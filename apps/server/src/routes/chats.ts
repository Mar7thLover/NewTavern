import { substituteMacros, type Part, type PromptIR } from '@newtavern/core';
import type {
  Connection,
  ModelCapabilities,
  ProviderAdapter,
  ProviderError,
  ProviderRequest,
} from '@newtavern/providers';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { schema, type Db } from '../db/client.js';
import {
  assemblePrompt,
  type AssembleCharacter,
  type AssembleHistoryNode,
  type AssembleInput,
} from '../services/assemble.js';
import { parseAuthorsNote } from '../services/authors-note.js';
import {
  clearOpaqueSubtree,
  deleteSubtree,
  insertNode,
  loadChat,
  loadNodes,
  patchChat,
  pathToNode,
  setChatLorebooks,
  textOfParts,
  toChatDetail,
  toChatSummary,
  toMessageNode,
  type ChatOverrides,
  type ChatRow,
  type InsertNodeInput,
  type NodeReasoning,
  type NodeRow,
  type Usage,
} from '../services/chat-tree.js';
import {
  GenerationContextError,
  resolveGenerationContext,
  type GenerationContext,
} from '../services/generation-context.js';
import { isGlobalSystemPromptOverride } from '../services/global-system-prompt.js';
import type { ProviderService } from '../services/providers.js';

/**
 * 聊天与消息树 + 生成 SSE。见 docs/M2-CONTRACT.md §3.4 / §3.5。
 */

/** SSE 首包填充：iOS Safari 等中间层会缓冲小响应（PLAN §七-9） */
const SSE_PADDING = 2048;
const PING_INTERVAL_MS = 15_000;
/** extra.request 体积上限，超出只存 body 长度（契约 §3.5） */
const REQUEST_STORE_LIMIT = 200 * 1024;

interface GenerateBody {
  userMessage?: { text: string; name?: string } | null;
  parentId?: string | null;
  connectionId?: string;
  model?: string;
  layoutMode?: 'strict' | 'cache-aware';
}

/** P 之后会给 buildRequest 增加可选第 4 参数（thinking 等）；用「参数更多」的类型接住三参签名 */
interface BuildOptions {
  thinking?: { effort?: string; budgetTokens?: number };
}
type BuildRequestFn = (
  ir: PromptIR,
  conn: Connection,
  model: string,
  options?: BuildOptions,
) => ProviderRequest;

function buildRequest(
  adapter: ProviderAdapter,
  ir: PromptIR,
  conn: Connection,
  model: string,
  thinking?: BuildOptions['thinking'],
): ProviderRequest {
  const build: BuildRequestFn = adapter.buildRequest.bind(adapter);
  return build(ir, conn, model, thinking ? { thinking } : undefined);
}

function requestForStorage(req: ProviderRequest | null): Record<string, unknown> | null {
  if (!req) return null;
  const body = JSON.stringify(req.body ?? null);
  if (body.length > REQUEST_STORE_LIMIT) {
    return { method: req.method, url: req.url, bodyLength: body.length, truncated: true };
  }
  // headers 含鉴权信息，绝不落库
  return { method: req.method, url: req.url, body: req.body };
}

function numberOf(
  source: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 存进 `extra.capabilities` 的能力摘要（M3 前端展示用，只留四个字段） */
function capabilitiesSummary(caps: ModelCapabilities): Record<string, unknown> {
  return {
    maxContext: caps.maxContext,
    maxOutput: caps.maxOutput,
    thinking: caps.thinking,
    caching: caps.caching,
  };
}

/** 插入节点并把 head（必要时还有 root）指过去 */
function appendNode(db: Db, chat: ChatRow, input: Omit<InsertNodeInput, 'chatId'>): NodeRow {
  const row = insertNode(db, { ...input, chatId: chat.id });
  patchChat(db, chat.id, {
    headNodeId: row.id,
    rootNodeId: row.parentId === null ? (chat.rootNodeId ?? row.id) : chat.rootNodeId,
  });
  return row;
}

function buildAssembleInput(
  db: Db,
  chat: ChatRow,
  parentId: string | null,
  provider: string,
  model: string,
  layoutMode: 'strict' | 'cache-aware',
  /** 模型能力里的上下文窗口；与预设的 openai_max_context 取较小值后传给组装器 */
  capsMaxContext: number,
): AssembleInput {
  const characterId = chat.characterIds[0];
  const characterRow = characterId
    ? db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()
    : undefined;
  const personaRow = chat.personaId
    ? db.select().from(schema.personas).where(eq(schema.personas.id, chat.personaId)).get()
    : undefined;
  const presetRow = chat.presetId
    ? db.select().from(schema.presets).where(eq(schema.presets.id, chat.presetId)).get()
    : undefined;

  const nodes = loadNodes(db, chat.id);
  const history = parentId ? pathToNode(nodes, parentId) : [];

  // 组装器以 options.maxContextTokens 优先（不会再去看预设），
  // 所以这里先取「模型能力 maxContext」与「预设 openai_max_context」的较小值。
  const presetMaxContext =
    numberOf(presetRow?.sampling, 'openai_max_context') ??
    numberOf(presetRow?.data as Record<string, unknown> | undefined, 'openai_max_context');
  const maxContextTokens =
    presetMaxContext !== undefined ? Math.min(capsMaxContext, presetMaxContext) : capsMaxContext;

  return {
    chatId: chat.id,
    model,
    provider,
    preset: presetRow
      ? {
          id: presetRow.id,
          format: presetRow.format,
          data: presetRow.data as Record<string, unknown>,
          sampling: presetRow.sampling ?? null,
        }
      : null,
    character: characterRow
      ? {
          id: characterRow.id,
          name: characterRow.name,
          data: characterRow.data as AssembleCharacter['data'],
        }
      : null,
    persona: personaRow
      ? { id: personaRow.id, name: personaRow.name, description: personaRow.description }
      : null,
    history: history
      .filter((node) => !node.isHidden)
      .map((node): AssembleHistoryNode => ({
        id: node.id,
        role: node.role,
        name: node.name,
        parts: (node.parts as Part[] | null) ?? [],
        // reasoning.opaque 里 provider/model 不匹配的块由 assemblePrompt 负责丢弃
        reasoning: (node.reasoning as AssembleHistoryNode['reasoning']) ?? null,
        isHidden: node.isHidden,
      })),
    layoutMode,
    options: { maxContextTokens },
  };
}

export function createChatsRoutes(db: Db, providers: ProviderService) {
  return (
    new Hono()
      .get('/', (c) => {
        const rows = db.select().from(schema.chats).orderBy(desc(schema.chats.updatedAt)).all();
        return c.json(rows.map((row) => toChatSummary(db, row)));
      })
      .post('/', async (c) => {
        let body: Record<string, unknown>;
        try {
          body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
        } catch {
          body = {};
        }
        const characterIds = Array.isArray(body.characterIds)
          ? body.characterIds.filter((id): id is string => typeof id === 'string')
          : [];
        const personaId = typeof body.personaId === 'string' ? body.personaId : null;
        const presetId = typeof body.presetId === 'string' ? body.presetId : null;
        const mode = body.mode === 'writing' || body.mode === 'crpg' ? body.mode : 'roleplay';

        const characterRow = characterIds[0]
          ? db
              .select()
              .from(schema.characters)
              .where(eq(schema.characters.id, characterIds[0]))
              .get()
          : undefined;
        if (characterIds[0] && !characterRow) {
          return c.json({ error: 'not_found', message: `角色不存在：${characterIds[0]}` }, 404);
        }
        const personaRow = personaId
          ? db.select().from(schema.personas).where(eq(schema.personas.id, personaId)).get()
          : undefined;

        const title =
          typeof body.title === 'string' && body.title.trim()
            ? body.title.trim()
            : (characterRow?.name ?? '');

        let chat = db
          .insert(schema.chats)
          .values({ title, mode, characterIds, personaId, presetId })
          .returning()
          .get();

        // first_mes + alternate_greetings → 根节点与它的 swipe 兄弟
        const card = (characterRow?.data ?? {}) as Record<string, unknown>;
        const firstMes = typeof card.first_mes === 'string' ? card.first_mes : '';
        if (characterRow && firstMes.trim()) {
          const charName = characterRow.name;
          const userName = personaRow?.name ?? 'User';
          const greetings = [
            firstMes,
            ...(Array.isArray(card.alternate_greetings)
              ? card.alternate_greetings.filter(
                  (g): g is string => typeof g === 'string' && !!g.trim(),
                )
              : []),
          ];
          let rootId: string | null = null;
          greetings.forEach((greeting, index) => {
            const row = insertNode(db, {
              chatId: chat.id,
              parentId: null,
              siblingSeq: index,
              role: 'assistant',
              name: charName,
              parts: [
                {
                  type: 'text',
                  text: substituteMacros(greeting, {
                    char: charName,
                    user: userName,
                    persona: personaRow?.description,
                    description:
                      typeof card.description === 'string' ? card.description : undefined,
                    personality:
                      typeof card.personality === 'string' ? card.personality : undefined,
                    scenario: typeof card.scenario === 'string' ? card.scenario : undefined,
                    mesExamples:
                      typeof card.mes_example === 'string' ? card.mes_example : undefined,
                  }),
                },
              ],
            });
            if (index === 0) rootId = row.id;
          });
          chat = patchChat(db, chat.id, { rootNodeId: rootId, headNodeId: rootId });
        }
        return c.json(toChatDetail(db, chat), 201);
      })
      .get('/:id', (c) => {
        const chat = loadChat(db, c.req.param('id'));
        if (!chat) return c.json({ error: 'not_found' }, 404);
        return c.json(toChatDetail(db, chat));
      })
      .patch('/:id', async (c) => {
        const chat = loadChat(db, c.req.param('id'));
        if (!chat) return c.json({ error: 'not_found' }, 404);
        let body: Record<string, unknown>;
        try {
          body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
        } catch {
          return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
        }
        const patch: Partial<ChatRow> = {};
        if (body.title !== undefined) {
          if (typeof body.title !== 'string')
            return c.json({ error: 'invalid', message: 'title 非法' }, 400);
          patch.title = body.title;
        }
        if (body.personaId !== undefined) {
          patch.personaId = typeof body.personaId === 'string' ? body.personaId : null;
        }
        if (body.presetId !== undefined) {
          patch.presetId = typeof body.presetId === 'string' ? body.presetId : null;
        }
        if (body.headNodeId !== undefined) {
          const nodes = loadNodes(db, chat.id);
          if (body.headNodeId !== null && !nodes.some((node) => node.id === body.headNodeId)) {
            return c.json({ error: 'invalid', message: 'headNodeId 不属于该聊天' }, 400);
          }
          patch.headNodeId = (body.headNodeId as string | null) ?? null;
        }
        if (body.overrides !== undefined) {
          if (body.overrides !== null && typeof body.overrides !== 'object') {
            return c.json({ error: 'invalid', message: 'overrides 非法' }, 400);
          }
          const overrides = (body.overrides ?? null) as ChatOverrides | null;
          // 全局系统提示词的会话覆盖（契约 §3.4）
          if (
            overrides?.globalSystemPrompt !== undefined &&
            !isGlobalSystemPromptOverride(overrides.globalSystemPrompt)
          ) {
            return c.json({ error: 'invalid', message: 'overrides.globalSystemPrompt 非法' }, 400);
          }
          patch.overrides = overrides;
        }
        if (body.metadata !== undefined) {
          if (body.metadata !== null && typeof body.metadata !== 'object') {
            return c.json({ error: 'invalid', message: 'metadata 非法' }, 400);
          }
          if (body.metadata === null) {
            patch.metadata = null;
          } else {
            // 浅合并：值为 null 的键删除（frozenVolatile 清空等），其余覆盖
            const incoming = body.metadata as Record<string, unknown>;
            if (incoming.authorsNote !== undefined) {
              const note = parseAuthorsNote(incoming.authorsNote);
              if (note === 'invalid') {
                return c.json({ error: 'invalid', message: 'metadata.authorsNote 非法' }, 400);
              }
              incoming.authorsNote = note;
            }
            const merged: Record<string, unknown> = { ...(chat.metadata ?? {}) };
            for (const [key, value] of Object.entries(incoming)) {
              if (value === null) delete merged[key];
              else merged[key] = value;
            }
            patch.metadata = merged;
          }
        }
        return c.json(toChatDetail(db, patchChat(db, chat.id, patch)));
      })
      /** 全量替换聊天世界书绑定（契约 §3.3） */
      .put('/:id/lorebooks', async (c) => {
        const chat = loadChat(db, c.req.param('id'));
        if (!chat) return c.json({ error: 'not_found' }, 404);
        let body: Record<string, unknown>;
        try {
          body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
        } catch {
          return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
        }
        const bookIds = body.bookIds;
        if (!Array.isArray(bookIds) || bookIds.some((id) => typeof id !== 'string')) {
          return c.json({ error: 'invalid', message: 'bookIds 非法' }, 400);
        }
        for (const bookId of bookIds as string[]) {
          const book = db
            .select({ id: schema.lorebooks.id })
            .from(schema.lorebooks)
            .where(eq(schema.lorebooks.id, bookId))
            .get();
          if (!book) {
            return c.json({ error: 'invalid', message: `世界书不存在：${bookId}` }, 400);
          }
        }
        setChatLorebooks(db, chat.id, bookIds as string[]);
        return c.json(toChatDetail(db, patchChat(db, chat.id, {})));
      })
      .delete('/:id', (c) => {
        const row = db
          .delete(schema.chats)
          .where(eq(schema.chats.id, c.req.param('id')))
          .returning()
          .get();
        if (!row) return c.json({ error: 'not_found' }, 404);
        return c.body(null, 204);
      })
      .post('/:id/messages', async (c) => {
        const chat = loadChat(db, c.req.param('id'));
        if (!chat) return c.json({ error: 'not_found' }, 404);
        let body: Record<string, unknown>;
        try {
          body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
        } catch {
          return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
        }
        const role = body.role;
        if (role !== 'user' && role !== 'assistant' && role !== 'system') {
          return c.json({ error: 'invalid', message: 'role 非法' }, 400);
        }
        if (typeof body.text !== 'string') {
          return c.json({ error: 'invalid', message: '缺少 text' }, 400);
        }
        const parentId =
          body.parentId !== undefined
            ? ((body.parentId as string | null) ?? null)
            : chat.headNodeId;
        if (parentId !== null && !loadNodes(db, chat.id).some((node) => node.id === parentId)) {
          return c.json({ error: 'invalid', message: `父节点不存在：${parentId}` }, 400);
        }
        const node = appendNode(db, chat, {
          parentId,
          role,
          parts: [{ type: 'text', text: body.text }],
          name: typeof body.name === 'string' ? body.name : null,
        });
        return c.json({
          node: toMessageNode(node),
          chat: toChatSummary(db, loadChat(db, chat.id) as ChatRow),
        });
      })
      .patch('/:id/nodes/:nodeId', async (c) => {
        const chat = loadChat(db, c.req.param('id'));
        if (!chat) return c.json({ error: 'not_found' }, 404);
        const nodeId = c.req.param('nodeId');
        const node = loadNodes(db, chat.id).find((row) => row.id === nodeId);
        if (!node) return c.json({ error: 'not_found' }, 404);
        let body: Record<string, unknown>;
        try {
          body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
        } catch {
          return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
        }
        const patch: Partial<typeof schema.messageNodes.$inferInsert> = {};
        let textChanged = false;
        if (body.text !== undefined) {
          if (typeof body.text !== 'string') {
            return c.json({ error: 'invalid', message: 'text 非法' }, 400);
          }
          // 非文本 part（图片/文档）保留，只替换文本部分
          const kept = ((node.parts as Part[] | null) ?? []).filter(
            (part) => part.type !== 'text' && part.type !== 'reasoning_opaque',
          );
          patch.parts = [{ type: 'text', text: body.text }, ...kept] satisfies Part[];
          textChanged = true;
        }
        if (body.isHidden !== undefined) {
          if (typeof body.isHidden !== 'boolean') {
            return c.json({ error: 'invalid', message: 'isHidden 非法' }, 400);
          }
          patch.isHidden = body.isHidden;
        }
        if (body.name !== undefined) {
          patch.name = typeof body.name === 'string' ? body.name : null;
        }
        const updated = db
          .update(schema.messageNodes)
          .set(patch)
          .where(eq(schema.messageNodes.id, nodeId))
          .returning()
          .get();
        // 编辑正文使下游推理块失效（PLAN §3.1「推理内容持久化」）
        if (textChanged) clearOpaqueSubtree(db, chat.id, nodeId);
        patchChat(db, chat.id, {});
        const fresh = loadNodes(db, chat.id).find((row) => row.id === nodeId) ?? updated;
        return c.json(toMessageNode(fresh));
      })
      .delete('/:id/nodes/:nodeId', (c) => {
        const chat = loadChat(db, c.req.param('id'));
        if (!chat) return c.json({ error: 'not_found' }, 404);
        const updated = deleteSubtree(db, chat, c.req.param('nodeId'));
        if (!updated) return c.json({ error: 'not_found' }, 404);
        return c.json({ chat: toChatSummary(db, updated) });
      })
      /**
       * 提示词检查器数据源（契约 §3.6）。
       * SA 只做路由骨架：参数解析 + 连接/模型解析 + 404/400 分支；
       * SB 接入组装 v2 后按契约 §6 填充 ir / request / layout / wi 等字段。
       */
      .get('/:id/inspect', async (c) => {
        const rawParentId = c.req.query('parentId');
        let context: GenerationContext;
        try {
          context = await resolveGenerationContext(db, providers, {
            chatId: c.req.param('id'),
            // 不传 = 取 head；parentId= （空串）= 从根开始
            parentId: rawParentId === undefined ? undefined : rawParentId || null,
            connectionId: c.req.query('connectionId'),
            model: c.req.query('model'),
            layoutMode: c.req.query('layoutMode'),
          });
        } catch (e) {
          if (e instanceof GenerationContextError) return c.json(e.body, e.status);
          throw e;
        }
        return c.json({
          todo: true,
          chatId: context.chat.id,
          parentId: context.parentId,
          connectionId: context.connectionId,
          model: context.model,
          layoutMode: context.layoutMode,
        });
      })
      .post('/:id/generate', async (c) => {
        const chatId = c.req.param('id');

        let body: GenerateBody = {};
        try {
          body = ((await c.req.json()) ?? {}) as GenerateBody;
        } catch {
          body = {};
        }

        let context: GenerationContext;
        try {
          context = await resolveGenerationContext(db, providers, {
            chatId,
            parentId: body.parentId,
            connectionId: body.connectionId,
            model: body.model,
            layoutMode: body.layoutMode,
          });
        } catch (e) {
          if (e instanceof GenerationContextError) return c.json(e.body, e.status);
          throw e;
        }
        const { overrides, connectionId, model, resolved, parentId, layoutMode } = context;
        const provider = resolved.conn.provider;

        c.header('X-Accel-Buffering', 'no');
        return streamSSE(c, async (stream) => {
          const startedAt = Date.now();
          const ac = new AbortController();
          let aborted = false;
          const onClientGone = () => {
            if (aborted) return;
            aborted = true;
            ac.abort();
          };
          c.req.raw.signal.addEventListener('abort', onClientGone);
          stream.onAbort(onClientGone);

          const send = (event: string, data: unknown) =>
            stream.writeSSE({ event, data: JSON.stringify(data) });
          const chatNow = () => loadChat(db, chatId) as ChatRow;

          await stream.write(`:${'-'.repeat(SSE_PADDING)}\n\n`);
          const ping = setInterval(() => void stream.write(': ping\n\n'), PING_INTERVAL_MS);

          let assistantId: string | null = null;
          let text = '';
          let reasoningText = '';
          const opaque: unknown[] = [];
          let usage: Usage | null = null;
          let stopReason: string | null = null;
          let genError: ProviderError | null = null;
          let finalRequest: ProviderRequest | null = null;

          try {
            // 1. 可选的 user 节点
            let genParentId = parentId;
            const userMessage = body.userMessage;
            if (userMessage && typeof userMessage.text === 'string') {
              const userRow = appendNode(db, chatNow(), {
                parentId: genParentId,
                role: 'user',
                parts: [{ type: 'text', text: userMessage.text }],
                name: typeof userMessage.name === 'string' ? userMessage.name : null,
              });
              genParentId = userRow.id;
              await send('node', {
                node: toMessageNode(userRow),
                chat: toChatSummary(db, chatNow()),
              });
            }

            // 2. 组装：按模型能力（与预设取较小值）限制上下文预算
            const caps = resolved.adapter.capabilities(model, resolved.conn);
            const ir = assemblePrompt(
              buildAssembleInput(
                db,
                chatNow(),
                genParentId,
                provider,
                model,
                layoutMode,
                caps.maxContext,
              ),
            );

            // 3. assistant 节点（parts 空），head 移过去
            const assistantRow = appendNode(db, chatNow(), {
              parentId: genParentId,
              role: 'assistant',
              parts: [],
              provider,
              model,
            });
            assistantId = assistantRow.id;
            await send('node', {
              node: toMessageNode(assistantRow),
              chat: toChatSummary(db, chatNow()),
            });

            // 4. 流式；首事件就是 401/429 时换下一个 Key 重试一次
            const maxAttempts = resolved.keyCount > 1 ? 2 : 1;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
              const active =
                attempt === 0 ? resolved : await providers.resolveConnection(connectionId);
              finalRequest = buildRequest(
                active.adapter,
                ir,
                active.conn,
                model,
                overrides.thinking,
              );
              let firstEvent = true;
              let retry = false;
              for await (const ev of active.adapter.stream(active.conn, finalRequest, ac.signal)) {
                if (
                  firstEvent &&
                  ev.type === 'error' &&
                  attempt + 1 < maxAttempts &&
                  (ev.error.kind === 'auth' || ev.error.kind === 'rateLimit')
                ) {
                  retry = true;
                  break;
                }
                firstEvent = false;
                switch (ev.type) {
                  case 'text.delta':
                    text += ev.text;
                    await send('text.delta', { nodeId: assistantId, text: ev.text });
                    break;
                  case 'reasoning.delta':
                    reasoningText += ev.text;
                    await send('reasoning.delta', { nodeId: assistantId, text: ev.text });
                    break;
                  case 'reasoning.opaque':
                    opaque.push({ provider: ev.provider, model: ev.model, payload: ev.payload });
                    break;
                  case 'usage':
                    usage = {
                      input: ev.input,
                      output: ev.output,
                      cacheRead: ev.cacheRead,
                      cacheWrite: ev.cacheWrite,
                      reasoning: ev.reasoning,
                    };
                    await send('usage', { nodeId: assistantId, usage });
                    break;
                  case 'stop':
                    stopReason = ev.reason;
                    break;
                  case 'error':
                    genError = ev.error;
                    break;
                  default:
                    // image / tool.call：M2 不落地，保留事件名
                    break;
                }
              }
              if (!retry) break;
            }

            if (aborted) stopReason = 'abort';

            if (genError && text === '') {
              // 无任何文本：删除刚创建的节点、head 回退、只发 error
              deleteSubtree(db, chatNow(), assistantId);
              assistantId = null;
              await send('error', {
                error: { kind: genError.kind, message: genError.message, status: genError.status },
                retryable: genError.retryable,
              });
            } else {
              const reasoning: NodeReasoning | null =
                reasoningText || opaque.length > 0
                  ? {
                      ...(reasoningText ? { text: reasoningText } : {}),
                      ...(opaque.length > 0 ? { opaque } : {}),
                    }
                  : null;
              const finalRow = db
                .update(schema.messageNodes)
                .set({
                  parts: text ? ([{ type: 'text', text }] satisfies Part[]) : [],
                  reasoning,
                  usage,
                  extra: {
                    stopReason: stopReason ?? (genError ? 'error' : 'end'),
                    request: requestForStorage(finalRequest),
                    capabilities: capabilitiesSummary(caps),
                  },
                })
                .where(eq(schema.messageNodes.id, assistantId))
                .returning()
                .get();
              const latencyMs = Date.now() - startedAt;
              db.insert(schema.generationLog)
                .values({
                  nodeId: assistantId,
                  provider,
                  model,
                  usage: usage ?? undefined,
                  latencyMs,
                  layoutMode,
                })
                .run();
              patchChat(db, chatId, {});
              if (genError) {
                await send('error', {
                  nodeId: assistantId,
                  error: {
                    kind: genError.kind,
                    message: genError.message,
                    status: genError.status,
                  },
                  retryable: genError.retryable,
                });
              } else if (!aborted) {
                await send('done', {
                  node: toMessageNode(finalRow),
                  chat: toChatSummary(db, chatNow()),
                  stopReason: stopReason ?? 'end',
                  latencyMs,
                });
              }
            }
          } catch (e) {
            // 组装 / buildRequest / 适配器抛出的异常：无文本则回滚节点
            if (assistantId && text === '') {
              deleteSubtree(db, chatNow(), assistantId);
              assistantId = null;
            }
            await send('error', {
              nodeId: assistantId ?? undefined,
              error: { kind: 'invalid', message: (e as Error).message },
              retryable: false,
            });
          } finally {
            clearInterval(ping);
            c.req.raw.signal.removeEventListener('abort', onClientGone);
          }
        });
      })
  );
}

export { textOfParts };
