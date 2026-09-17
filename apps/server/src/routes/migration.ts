import type { IncomingMessage } from 'node:http';

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { Db } from '../db/client.js';
import type { AssetsService } from '../services/assets.js';
import type { Importer } from '../services/importer.js';
import {
  MigrationError,
  countMigrationItems,
  parseMigrationSelect,
  resolveStRoot,
  runStMigration,
  scanStDirectory,
} from '../services/st-migration.js';

/**
 * SillyTavern 目录迁移（契约 M4 §2.3）。挂在 `/api/migration`。
 * 迁移会读取服务端这台电脑上的任意文件夹，所以只允许本机访问。
 */

const FORBIDDEN = {
  error: 'forbidden',
  message: '迁移会读取这台电脑上的文件夹，只能在运行服务端的电脑上打开本页操作',
} as const;

const SSE_PADDING = 2048;

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const value = address.trim().toLowerCase();
  return (
    value === '::1' ||
    value === 'localhost' ||
    /^127\.\d+\.\d+\.\d+$/.test(value) ||
    /^::ffff:127\.\d+\.\d+\.\d+$/.test(value)
  );
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || isLoopbackAddress(host);
}

function isLoopbackUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * 本机判定：TCP 对端必须是回环地址；另外凡是带了来源信息的头（Origin / Referer / 转发头）也必须指向本机——
 * Vite 开发代理（`host: true`）会把局域网浏览器的请求从 localhost 转过来，只看对端地址会被绕过。
 */
export function isLocalRequest(c: Context): boolean {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  if (!isLoopbackAddress(incoming?.socket?.remoteAddress)) return false;
  const origin = c.req.header('origin');
  if (origin && origin !== 'null' && !isLoopbackUrl(origin)) return false;
  const referer = c.req.header('referer');
  if (referer && !isLoopbackUrl(referer)) return false;
  const forwardedFor = c.req.header('x-forwarded-for');
  if (forwardedFor && !forwardedFor.split(',').every((part) => isLoopbackAddress(part)))
    return false;
  const realIp = c.req.header('x-real-ip');
  if (realIp && !isLoopbackAddress(realIp)) return false;
  const forwardedHost = c.req.header('x-forwarded-host');
  if (
    forwardedHost &&
    !isLoopbackHost(forwardedHost.split(',')[0]?.trim().replace(/:\d+$/, '') ?? '')
  ) {
    return false;
  }
  return true;
}

const localOnly: MiddlewareHandler = async (c, next) => {
  if (!isLocalRequest(c)) return c.json(FORBIDDEN, 403);
  await next();
};

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = (await c.req.json()) as unknown;
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function createMigrationRoutes(db: Db, assets: AssetsService, importer: Importer) {
  return (
    new Hono()
      .use('*', localOnly)
      /** 前端进页面先探一下：本机 200，非本机 403 */
      .get('/access', (c) => c.json({ ok: true }))
      .post('/st/scan', async (c) => {
        const body = await readJson(c);
        if (typeof body.path !== 'string') {
          return c.json({ error: 'invalid', message: '缺少 path' }, 400);
        }
        try {
          const resolved = resolveStRoot(body.path);
          if ('users' in resolved) return c.json({ users: resolved.users });
          return c.json(scanStDirectory(db, resolved.root));
        } catch (e) {
          if (e instanceof MigrationError)
            return c.json({ error: 'invalid', message: e.message }, 400);
          throw e;
        }
      })
      /**
       * SSE：`start { total }` → 逐项 `item { category, file, status, id?, message? }` → `done { counts, warnings }`。
       * 路径与选择先校验，出错直接 400（不开流）；单项失败不中断。
       */
      .post('/st/run', async (c) => {
        const body = await readJson(c);
        let root: string;
        let select: ReturnType<typeof parseMigrationSelect>;
        try {
          if (typeof body.path !== 'string') throw new MigrationError('缺少 path');
          const resolved = resolveStRoot(body.path);
          if ('users' in resolved) {
            throw new MigrationError(
              '这个文件夹里有多个 SillyTavern 用户，请先选定一个用户的文件夹',
            );
          }
          root = resolved.root;
          select = parseMigrationSelect(body.select);
        } catch (e) {
          if (e instanceof MigrationError)
            return c.json({ error: 'invalid', message: e.message }, 400);
          throw e;
        }

        c.header('X-Accel-Buffering', 'no');
        return streamSSE(c, async (stream) => {
          let aborted = false;
          stream.onAbort(() => {
            aborted = true;
          });
          const send = (event: string, data: unknown) =>
            stream.writeSSE({ event, data: JSON.stringify(data) });

          await stream.write(`:${'-'.repeat(SSE_PADDING)}\n\n`);
          await send('start', { total: countMigrationItems(root, select) });
          try {
            const done = await runStMigration(
              { db, assets, importer },
              root,
              select,
              (item) => send('item', item),
              () => aborted,
            );
            if (!aborted) await send('done', done);
          } catch (e) {
            await send('error', { message: (e as Error).message });
          }
        });
      })
  );
}
