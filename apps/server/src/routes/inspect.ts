import { Hono } from 'hono';

import type { Db } from '../db/client.js';
import {
  GenerationContextError,
  resolveGenerationContext,
} from '../services/generation-context.js';
import { buildCompare } from '../services/inspect.js';
import type { ProviderService } from '../services/providers.js';

/**
 * 「与 ST 请求比对」端点（M3 契约 §6）。
 * `POST /api/inspect/compare` body `{ chatId, parentId?, connectionId?, model?, stRequest }`
 * → 本地 **strict** 组装的 messages 与粘贴的 ST 请求体逐条比对。
 */

interface CompareBody {
  chatId?: unknown;
  parentId?: unknown;
  connectionId?: unknown;
  model?: unknown;
  stRequest?: unknown;
}

export function createInspectRoutes(db: Db, providers: ProviderService) {
  return new Hono().post('/compare', async (c) => {
    let body: CompareBody;
    try {
      body = ((await c.req.json()) ?? {}) as CompareBody;
    } catch {
      return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
    }
    if (typeof body.chatId !== 'string' || body.chatId === '') {
      return c.json({ error: 'invalid', message: '缺少 chatId' }, 400);
    }
    if (body.stRequest === undefined || body.stRequest === null) {
      return c.json({ error: 'invalid', message: '缺少 stRequest' }, 400);
    }

    try {
      const context = await resolveGenerationContext(db, providers, {
        chatId: body.chatId,
        // 不传 = 取 head；显式 null / 空串 = 从根开始
        parentId:
          body.parentId === undefined
            ? undefined
            : typeof body.parentId === 'string' && body.parentId !== ''
              ? body.parentId
              : null,
        connectionId: typeof body.connectionId === 'string' ? body.connectionId : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        // 比对只有 strict 才有意义
        layoutMode: 'strict',
      });
      return c.json(buildCompare(db, context, body.stRequest));
    } catch (e) {
      if (e instanceof GenerationContextError) return c.json(e.body, e.status);
      return c.json({ error: 'invalid', message: (e as Error).message }, 400);
    }
  });
}
