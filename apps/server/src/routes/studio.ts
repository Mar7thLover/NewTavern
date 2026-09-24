import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { Db } from '../db/client.js';
import { toChatDetail } from '../services/chat-tree.js';
import { readGenerationDefault } from '../services/generation-context.js';
import {
  ProviderServiceError,
  type ProviderService,
  type ResolvedConnection,
} from '../services/providers.js';
import {
  AssistTargetNotFoundError,
  parseAssistRequest,
  prepareAssist,
  runStudioAssist,
  type PreparedAssist,
  type StudioAssistEvents,
} from '../services/studio-assist.js';
import {
  StudioEntityNotFoundError,
  getOrCreateTestChat,
  type StudioKind,
} from '../services/studio-test-chat.js';

export type { AssembleDraftBody as StudioDraft } from '../services/studio-draft.js';
export type {
  StudioAssistEvents,
  StudioAssistRequest,
  StudioPatchOp,
} from '../services/studio-assist.js';
export type { StudioKind };

const KINDS: readonly StudioKind[] = ['character', 'preset', 'lorebook'];

/** 首包填充：绕过部分代理 / 浏览器对小 SSE 包的缓冲（同 chats / writing） */
const SSE_PADDING = 2048;
const PING_INTERVAL_MS = 15_000;

/**
 * 创作工作台（M6 §2.4 / §3）。
 *
 * - `GET /test-chat/:kind/:id`：该实体的测试会话（最近一条，没有就新建），返回 ChatDetail。
 *   测试会话的生成 / 检查照常走 `/api/chats/:id/generate`、`POST /api/chats/:id/inspect`，body 带 `draft`。
 * - `POST /assist`（SSE）：AI 协作者。请求体与事件见 `services/studio-assist.ts`
 *   （`StudioAssistRequest` / `StudioAssistEvents`）。请求校验、target 不存在、没有连接
 *   在开流之前以 JSON 400 / 404 返回。
 */
export function createStudioRoutes(db: Db, dataDir: string, providers: ProviderService) {
  return new Hono()
    .get('/test-chat/:kind/:id', (c) => {
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
    })
    .post('/assist', async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: 'invalid', message: '请求体不是合法的 JSON' }, 400);
      }
      const req = parseAssistRequest(body);
      if (typeof req === 'string') return c.json({ error: 'invalid', message: req }, 400);

      const fallback = readGenerationDefault(db);
      const connectionId = req.connectionId ?? fallback.connectionId;
      const model = req.model ?? fallback.model;
      if (!connectionId || !model) {
        return c.json({ error: 'no_connection', message: '未指定连接或模型' }, 400);
      }

      let prepared: PreparedAssist;
      try {
        prepared = prepareAssist(db, req);
      } catch (e) {
        if (e instanceof AssistTargetNotFoundError) return c.json({ error: 'not_found' }, 404);
        throw e;
      }
      let resolved: ResolvedConnection;
      try {
        resolved = await providers.resolveConnection(connectionId);
      } catch (e) {
        if (e instanceof ProviderServiceError) {
          return c.json(
            e.code === 'not_found'
              ? { error: 'no_connection', message: e.message }
              : { error: e.code, kind: e.kind, message: e.message },
            400,
          );
        }
        throw e;
      }

      c.header('X-Accel-Buffering', 'no');
      return streamSSE(c, async (stream) => {
        const ac = new AbortController();
        const onClientGone = () => {
          if (!ac.signal.aborted) ac.abort();
        };
        c.req.raw.signal.addEventListener('abort', onClientGone);
        stream.onAbort(onClientGone);

        const send = async <K extends keyof StudioAssistEvents>(
          event: K,
          data: StudioAssistEvents[K],
        ) => {
          if (ac.signal.aborted) return;
          await stream.writeSSE({ event, data: JSON.stringify(data) });
        };

        await stream.write(`:${'-'.repeat(SSE_PADDING)}\n\n`);
        const ping = setInterval(() => void stream.write(': ping\n\n'), PING_INTERVAL_MS);
        try {
          await runStudioAssist(
            {
              db,
              dataDir,
              connectionId,
              model,
              resolved,
              req,
              prepared,
              signal: ac.signal,
            },
            send,
          );
        } catch (e) {
          await send('error', { message: (e as Error).message });
        } finally {
          clearInterval(ping);
          c.req.raw.signal.removeEventListener('abort', onClientGone);
        }
      });
    });
}
