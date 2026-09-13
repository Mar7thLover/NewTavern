import type { ModelInfo, ProviderErrorKind, ProviderId } from '@newtavern/providers';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { schema, type Db } from '../db/client.js';
import {
  DEFAULT_BASE_URLS,
  isProviderId,
  ProviderServiceError,
  type ProviderService,
} from '../services/providers.js';
import { keyHint, type Secrets } from '../services/secrets.js';

/**
 * 连接与模型列表。见 docs/M2-CONTRACT.md §3.2。
 * 明文 Key 只在 services/providers.ts 内部解密，本路由只返回 keyCount / keyHints。
 */

type ConnectionRow = typeof schema.connections.$inferSelect;

interface ConnectionInput {
  provider: ProviderId;
  label: string;
  baseUrl?: string;
  apiKeys?: string[];
  headers?: Record<string, string>;
  proxy?: string | null;
  quirks?: Record<string, boolean>;
  modelOverrides?: Record<string, unknown>;
}

function parseBody(body: Record<string, unknown>, partial: boolean): Partial<ConnectionInput> {
  const patch: Partial<ConnectionInput> = {};
  if (body.provider !== undefined) {
    if (!isProviderId(body.provider)) throw new Error(`provider 非法：${String(body.provider)}`);
    patch.provider = body.provider;
  } else if (!partial) {
    throw new Error('缺少 provider');
  }
  if (body.label !== undefined) {
    if (typeof body.label !== 'string') throw new Error('label 非法');
    patch.label = body.label.trim();
  }
  if (body.baseUrl !== undefined) {
    if (typeof body.baseUrl !== 'string') throw new Error('baseUrl 非法');
    patch.baseUrl = body.baseUrl.trim().replace(/\/+$/, '');
  }
  if (body.apiKeys !== undefined) {
    if (!Array.isArray(body.apiKeys) || body.apiKeys.some((k) => typeof k !== 'string')) {
      throw new Error('apiKeys 必须是字符串数组');
    }
    patch.apiKeys = (body.apiKeys as string[]).map((k) => k.trim()).filter((k) => k !== '');
  }
  if (body.headers !== undefined) {
    if (body.headers !== null && typeof body.headers !== 'object') throw new Error('headers 非法');
    patch.headers = (body.headers ?? {}) as Record<string, string>;
  }
  if (body.proxy !== undefined) {
    if (body.proxy !== null && typeof body.proxy !== 'string') throw new Error('proxy 非法');
    // TODO(M3)：proxy 目前只存储，不做请求转发
    patch.proxy = body.proxy;
  }
  if (body.quirks !== undefined) {
    if (body.quirks !== null && typeof body.quirks !== 'object') throw new Error('quirks 非法');
    patch.quirks = (body.quirks ?? {}) as Record<string, boolean>;
  }
  if (body.modelOverrides !== undefined) {
    if (body.modelOverrides !== null && typeof body.modelOverrides !== 'object') {
      throw new Error('modelOverrides 非法');
    }
    patch.modelOverrides = (body.modelOverrides ?? {}) as Record<string, unknown>;
  }
  return patch;
}

function toSummary(row: ConnectionRow, keys: string[]) {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    baseUrl: row.baseUrl,
    headers: row.headers ?? {},
    proxy: row.proxy,
    quirks: row.quirks ?? {},
    modelOverrides: row.modelOverrides ?? {},
    keyCount: keys.length,
    keyHints: keys.map(keyHint),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createConnectionsRoutes(db: Db, secrets: Secrets, providers: ProviderService) {
  const summaryOf = (row: ConnectionRow) => toSummary(row, providers.readKeys(row));

  const getRow = (id: string) =>
    db.select().from(schema.connections).where(eq(schema.connections.id, id)).get();

  /** 把 ProviderServiceError / 适配器抛出的 ProviderError 统一成契约的错误响应体 */
  const errorBody = (e: unknown) => {
    if (e instanceof ProviderServiceError) {
      return { error: e.code, kind: e.kind, message: e.message };
    }
    const err = e as { kind?: ProviderErrorKind; message?: string };
    return {
      error: 'provider_error',
      kind: err.kind ?? 'network',
      message: err.message ?? String(e),
    };
  };

  return new Hono()
    .get('/', (c) => {
      const rows = db
        .select()
        .from(schema.connections)
        .orderBy(desc(schema.connections.updatedAt))
        .all();
      return c.json(rows.map(summaryOf));
    })
    .post('/', async (c) => {
      let patch: Partial<ConnectionInput>;
      try {
        patch = parseBody((await c.req.json()) as Record<string, unknown>, false);
      } catch (e) {
        return c.json({ error: 'invalid', message: (e as Error).message }, 400);
      }
      const provider = patch.provider as ProviderId;
      const row = db
        .insert(schema.connections)
        .values({
          provider,
          label: patch.label ?? '',
          baseUrl: patch.baseUrl || DEFAULT_BASE_URLS[provider],
          keysEnc: secrets.encryptJson(patch.apiKeys ?? []),
          headers: patch.headers ?? null,
          proxy: patch.proxy ?? null,
          quirks: patch.quirks ?? null,
          modelOverrides: patch.modelOverrides ?? null,
        })
        .returning()
        .get();
      return c.json(summaryOf(row), 201);
    })
    .get('/:id', (c) => {
      const row = getRow(c.req.param('id'));
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.json(summaryOf(row));
    })
    .put('/:id', async (c) => {
      const row = getRow(c.req.param('id'));
      if (!row) return c.json({ error: 'not_found' }, 404);
      let patch: Partial<ConnectionInput>;
      try {
        patch = parseBody((await c.req.json()) as Record<string, unknown>, true);
      } catch (e) {
        return c.json({ error: 'invalid', message: (e as Error).message }, 400);
      }
      const provider = patch.provider ?? (row.provider as ProviderId);
      const values: Partial<typeof schema.connections.$inferInsert> = { updatedAt: new Date() };
      if (patch.provider !== undefined) values.provider = provider;
      if (patch.label !== undefined) values.label = patch.label;
      if (patch.baseUrl !== undefined)
        values.baseUrl = patch.baseUrl || DEFAULT_BASE_URLS[provider];
      // apiKeys 缺省 = 不变；[] = 清空
      if (patch.apiKeys !== undefined) values.keysEnc = secrets.encryptJson(patch.apiKeys);
      if (patch.headers !== undefined) values.headers = patch.headers;
      if (patch.proxy !== undefined) values.proxy = patch.proxy;
      if (patch.quirks !== undefined) values.quirks = patch.quirks;
      if (patch.modelOverrides !== undefined) values.modelOverrides = patch.modelOverrides;
      const updated = db
        .update(schema.connections)
        .set(values)
        .where(eq(schema.connections.id, row.id))
        .returning()
        .get();
      return c.json(summaryOf(updated));
    })
    .delete('/:id', (c) => {
      const row = db
        .delete(schema.connections)
        .where(eq(schema.connections.id, c.req.param('id')))
        .returning()
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.body(null, 204);
    })
    .get('/:id/models', async (c) => {
      const id = c.req.param('id');
      const row = getRow(id);
      if (!row) return c.json({ error: 'not_found' }, 404);
      const refresh = c.req.query('refresh') === '1';
      const cached = db
        .select()
        .from(schema.modelCache)
        .where(eq(schema.modelCache.connectionId, id))
        .get();
      if (!refresh && cached && cached.models.length > 0) {
        return c.json({
          models: cached.models as ModelInfo[],
          fetchedAt: cached.fetchedAt,
          source: 'cache' as const,
        });
      }
      let models: ModelInfo[];
      try {
        models = await providers.withKeyRotation(id, (resolved) =>
          resolved.adapter.listModels(resolved.conn),
        );
      } catch (e) {
        return c.json(errorBody(e), 502);
      }
      const fetchedAt = new Date();
      if (cached) {
        db.update(schema.modelCache)
          .set({ models, fetchedAt })
          .where(eq(schema.modelCache.id, cached.id))
          .run();
      } else {
        db.insert(schema.modelCache).values({ connectionId: id, models, fetchedAt }).run();
      }
      return c.json({ models, fetchedAt, source: 'remote' as const });
    })
    .post('/:id/test', async (c) => {
      const id = c.req.param('id');
      if (!getRow(id)) return c.json({ error: 'not_found' }, 404);
      const startedAt = Date.now();
      try {
        // M2 只用 listModels 探测；M3 再补「给了 model 时发一次极小的非流式请求」
        const models = await providers.withKeyRotation(id, (resolved) =>
          resolved.adapter.listModels(resolved.conn),
        );
        return c.json({
          ok: true as const,
          latencyMs: Date.now() - startedAt,
          modelCount: models.length,
          // 有些中转站（如 Z.AI）鉴权失败时仍回 HTTP 200，只在 body 里写 code:401，
          // 于是 listModels 拿到空列表。M2 只能这样提示；根治在适配器侧（契约 §5 [S→P]）。
          ...(models.length === 0
            ? { warning: '端点没有返回任何模型，Key 可能无效或该端点不提供模型列表' }
            : {}),
        });
      } catch (e) {
        return c.json(errorBody(e), 400);
      }
    })
    .get('/:id/capabilities', async (c) => {
      const model = c.req.query('model');
      if (!model) return c.json({ error: 'invalid', message: '缺少 model 查询参数' }, 400);
      try {
        const resolved = await providers.resolveConnection(c.req.param('id'));
        return c.json(resolved.adapter.capabilities(model, resolved.conn));
      } catch (e) {
        if (e instanceof ProviderServiceError && e.code === 'not_found') {
          return c.json({ error: 'not_found' }, 404);
        }
        return c.json(errorBody(e), 400);
      }
    });
}
