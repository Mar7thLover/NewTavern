import { Hono } from 'hono';

import type { Db } from '../db/client.js';
import { toChatDetail } from '../services/chat-tree.js';
import {
  StudioEntityNotFoundError,
  getOrCreateTestChat,
  type StudioKind,
} from '../services/studio-test-chat.js';

export type { AssembleDraftBody as StudioDraft } from '../services/studio-draft.js';
export type { StudioKind };

const KINDS: readonly StudioKind[] = ['character', 'preset', 'lorebook'];

/**
 * 创作工作台（M6 §2.4）。AI 协作者（§3，`POST /assist`）等 F1 的工具调用就绪后再加。
 *
 * `GET /test-chat/:kind/:id`：该实体的测试会话（最近一条，没有就新建），返回 ChatDetail。
 * 测试会话的生成 / 检查照常走 `/api/chats/:id/generate`、`POST /api/chats/:id/inspect`，body 带 `draft`。
 */
export function createStudioRoutes(db: Db) {
  return new Hono().get('/test-chat/:kind/:id', (c) => {
    const kind = c.req.param('kind') as StudioKind;
    if (!KINDS.includes(kind)) {
      return c.json({ error: 'invalid', message: `未知类型：${kind}` }, 400);
    }
    try {
      const { chat, created } = getOrCreateTestChat(db, kind, c.req.param('id'));
      return c.json(toChatDetail(db, chat), created ? 201 : 200);
    } catch (e) {
      if (e instanceof StudioEntityNotFoundError) return c.json({ error: 'not_found' }, 404);
      throw e;
    }
  });
}
