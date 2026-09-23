import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { schema, type Db } from '../db/client.js';
import {
  createScript,
  deleteScript,
  exportScript,
  getScript,
  importScripts,
  isScriptScope,
  listScripts,
  normalizeButtons,
  reorderScripts,
  setOwnerScriptsEnabled,
  updateScript,
  type ScriptScope,
  type UpdateScriptInput,
} from '../services/scripts.js';
import { sendDownload } from './download.js';

/**
 * 酒馆助手脚本库。见 docs/M5-CONTRACT.md 第二部分 §2.1。
 *
 * - `GET /?scope=global|preset&ownerId=`：按 displayOrder；`scope=preset` 不带 ownerId 时给全部预设的
 * - `POST /`、`PUT /:id`（部分字段）、`DELETE /:id`、`PUT /order`
 * - `POST /import`：multipart `file`（可带 `scope` / `ownerId` 字段）或 JSON `{ scope?, ownerId?, scripts }`
 *   （`scripts` 缺省时整个 body 就是导入物）；默认 `enabled:false`，返回 `{ count, scripts }`
 * - `GET /:id/export`：酒馆助手 Script 格式 JSON 附件
 * - `POST /owner-enabled` `{ scope:'preset', ownerId, enabled }`：一键开关某个预设自带的全部脚本
 */

async function readJson(c: Context): Promise<unknown> {
  try {
    return (await c.req.json()) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function presetExists(db: Db, id: string): boolean {
  return (
    db
      .select({ id: schema.presets.id })
      .from(schema.presets)
      .where(eq(schema.presets.id, id))
      .get() !== undefined
  );
}

/** scope + ownerId 校验：preset 必须指向存在的预设 */
function readOwner(
  db: Db,
  scopeValue: unknown,
  ownerValue: unknown,
): { error: string } | { scope: ScriptScope; ownerId: string | null } {
  const scope = scopeValue === undefined || scopeValue === '' ? 'global' : scopeValue;
  if (!isScriptScope(scope)) return { error: 'scope 非法' };
  if (scope === 'global') return { scope, ownerId: null };
  if (typeof ownerValue !== 'string' || ownerValue === '')
    return { error: 'preset 脚本需要 ownerId' };
  if (!presetExists(db, ownerValue)) return { error: '找不到这个预设' };
  return { scope, ownerId: ownerValue };
}

function readPatch(
  body: Record<string, unknown>,
): { error: string } | { patch: UpdateScriptInput } {
  const patch: UpdateScriptInput = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') return { error: 'name 非法' };
    patch.name = body.name;
  }
  if (body.content !== undefined) {
    if (typeof body.content !== 'string') return { error: 'content 非法' };
    patch.content = body.content;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled 非法' };
    patch.enabled = body.enabled;
  }
  if (body.buttonsEnabled !== undefined) {
    if (typeof body.buttonsEnabled !== 'boolean') return { error: 'buttonsEnabled 非法' };
    patch.buttonsEnabled = body.buttonsEnabled;
  }
  if (body.info !== undefined) {
    if (typeof body.info !== 'string') return { error: 'info 非法' };
    patch.info = body.info;
  }
  if (body.buttons !== undefined) {
    if (!Array.isArray(body.buttons)) return { error: 'buttons 非法' };
    patch.buttons = normalizeButtons(body.buttons);
  }
  return { patch };
}

export function createScriptsRoutes(db: Db) {
  return (
    new Hono()
      .get('/', (c) => {
        const scope = c.req.query('scope') ?? 'global';
        if (!isScriptScope(scope)) return c.json({ error: 'invalid', message: 'scope 非法' }, 400);
        return c.json(listScripts(db, scope, c.req.query('ownerId') ?? null));
      })
      .post('/', async (c) => {
        const body = await readJson(c);
        if (!isRecord(body))
          return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
        const owner = readOwner(db, body.scope, body.ownerId);
        if ('error' in owner) return c.json({ error: 'invalid', message: owner.error }, 400);
        if (typeof body.name !== 'string' || body.name.trim() === '') {
          return c.json({ error: 'invalid', message: 'name 非法' }, 400);
        }
        const parsed = readPatch(body);
        if ('error' in parsed) return c.json({ error: 'invalid', message: parsed.error }, 400);
        const row = createScript(db, {
          ...owner,
          name: body.name,
          ...(parsed.patch.content === undefined ? {} : { content: parsed.patch.content }),
          ...(parsed.patch.enabled === undefined ? {} : { enabled: parsed.patch.enabled }),
          ...(parsed.patch.buttons === undefined ? {} : { buttons: parsed.patch.buttons }),
          ...(parsed.patch.info === undefined ? {} : { info: parsed.patch.info }),
        });
        return c.json(row, 201);
      })
      // /order、/import、/owner-enabled 必须在 /:id 之前注册
      .put('/order', async (c) => {
        const body = await readJson(c);
        const ids = isRecord(body) ? body.ids : undefined;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
          return c.json({ error: 'invalid', message: 'ids 非法' }, 400);
        }
        reorderScripts(db, ids as string[]);
        return c.json({ ok: true });
      })
      .post('/import', async (c) => {
        const contentType = c.req.header('content-type') ?? '';
        let payload: unknown;
        let scopeValue: unknown;
        let ownerValue: unknown;
        if (contentType.includes('multipart/form-data')) {
          const form = await c.req.parseBody();
          const file = form['file'];
          if (!(file instanceof File)) {
            return c.json({ error: 'invalid', message: '缺少上传文件（字段名 file）' }, 400);
          }
          try {
            payload = JSON.parse(new TextDecoder().decode(await file.arrayBuffer())) as unknown;
          } catch {
            return c.json({ error: 'invalid', message: '脚本文件不是合法 JSON' }, 400);
          }
          scopeValue = form['scope'];
          ownerValue = form['ownerId'];
        } else {
          const body = await readJson(c);
          if (body === undefined) {
            return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
          }
          const wrapped = isRecord(body) && body.scripts !== undefined && body.type === undefined;
          payload = wrapped ? body.scripts : body;
          if (isRecord(body) && wrapped) {
            scopeValue = body.scope;
            ownerValue = body.ownerId;
          }
        }
        const owner = readOwner(db, scopeValue, ownerValue);
        if ('error' in owner) return c.json({ error: 'invalid', message: owner.error }, 400);
        const scripts = importScripts(db, payload, { ...owner, enabled: false });
        if (scripts.length === 0) {
          return c.json({ error: 'invalid', message: '文件里没有认得出的酒馆助手脚本' }, 400);
        }
        return c.json({ count: scripts.length, scripts }, 201);
      })
      .post('/owner-enabled', async (c) => {
        const body = await readJson(c);
        if (!isRecord(body))
          return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
        if (body.scope !== 'preset')
          return c.json({ error: 'invalid', message: 'scope 非法' }, 400);
        if (typeof body.ownerId !== 'string' || body.ownerId === '') {
          return c.json({ error: 'invalid', message: 'ownerId 非法' }, 400);
        }
        if (typeof body.enabled !== 'boolean') {
          return c.json({ error: 'invalid', message: 'enabled 非法' }, 400);
        }
        const changed = setOwnerScriptsEnabled(db, 'preset', body.ownerId, body.enabled);
        return c.json({ changed, scripts: listScripts(db, 'preset', body.ownerId) });
      })
      .get('/:id/export', (c) => {
        const row = getScript(db, c.req.param('id'));
        if (!row) return c.json({ error: 'not_found' }, 404);
        const json = JSON.stringify(exportScript(row), null, 2);
        return sendDownload(c, {
          fileName: `${row.name || 'script'}.json`,
          mime: 'application/json',
          bytes: new TextEncoder().encode(json),
        });
      })
      .get('/:id', (c) => {
        const row = getScript(db, c.req.param('id'));
        return row ? c.json(row) : c.json({ error: 'not_found' }, 404);
      })
      .put('/:id', async (c) => {
        const body = await readJson(c);
        if (!isRecord(body))
          return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
        const parsed = readPatch(body);
        if ('error' in parsed) return c.json({ error: 'invalid', message: parsed.error }, 400);
        const row = updateScript(db, c.req.param('id'), parsed.patch);
        return row ? c.json(row) : c.json({ error: 'not_found' }, 404);
      })
      .delete('/:id', (c) =>
        deleteScript(db, c.req.param('id'))
          ? c.body(null, 204)
          : c.json({ error: 'not_found' }, 404),
      )
  );
}
