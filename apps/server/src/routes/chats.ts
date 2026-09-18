import { substituteMacros, type Part } from '@newtavern/core';
import {
  canDisableThinking,
  type ModelCapabilities,
  type ProviderError,
  type ProviderRequest,
} from '@newtavern/providers';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { schema, type Db } from '../db/client.js';
import { assemblePrompt } from '../services/assemble.js';
import {
  buildAssembleInput,
  readFrozenVolatile,
  readNearestSnapshots,
} from '../services/assemble-input.js';
import type { AssetsService } from '../services/assets.js';
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
import { ensureMvuInitialized, runMvuForNode } from '../services/mvu.js';
import { buildInspect } from '../services/inspect.js';
import {
  AttachmentError,
  compactMediaParts,
  createAssetResolver,
  generatedImageMime,
  isMediaPart,
  messageParts,
  parseAttachments,
} from '../services/media.js';
import { loadBookOpeners } from '../services/openers.js';
import { readDefaultPersonaId } from '../services/personas.js';
import { readDefaultPresetId } from '../services/presets.js';
import type { ProviderService } from '../services/providers.js';
import { buildProviderRequest, requestForStorage } from '../services/provider-request.js';
import { applyGlobalChanges } from '../services/variables.js';

/**
 * 聊天与消息树 + 生成 SSE。见 docs/M2-CONTRACT.md §3.4 / §3.5。
 */

/** SSE 首包填充：iOS Safari 等中间层会缓冲小响应（PLAN §七-9） */
const SSE_PADDING = 2048;
const PING_INTERVAL_MS = 15_000;

interface GenerateBody {
  /** attachments：上传得到的 assetId，按顺序（M4 §1.3）；文本为空但有附件也可以发送 */
  userMessage?: { text?: string; name?: string; attachments?: unknown } | null;
  parentId?: string | null;
  connectionId?: string;
  model?: string;
  layoutMode?: 'strict' | 'cache-aware';
}

/**
 * 存进 `extra.capabilities` 的能力摘要（前端展示用）：四个基础字段，
 * 推理模型再带 `effortLevels`（目录有写时）与 `canDisableThinking`。
 */
function capabilitiesSummary(caps: ModelCapabilities): Record<string, unknown> {
  return {
    maxContext: caps.maxContext,
    maxOutput: caps.maxOutput,
    thinking: caps.thinking,
    caching: caps.caching,
    ...(caps.effortLevels ? { effortLevels: caps.effortLevels } : {}),
    ...(caps.thinking === 'none' ? {} : { canDisableThinking: canDisableThinking(caps) }),
  };
}

const THINKING_OVERRIDE_KEYS = new Set(['enabled', 'effort', 'budgetTokens']);

/** `overrides.thinking` 的形状：`{ enabled?: boolean; effort?: string; budgetTokens?: 非负整数 }` */
function isThinkingOverride(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !THINKING_OVERRIDE_KEYS.has(key))) return false;
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') return false;
  if (obj.effort !== undefined && (typeof obj.effort !== 'string' || obj.effort === '')) {
    return false;
  }
  if (
    obj.budgetTokens !== undefined &&
    !(Number.isInteger(obj.budgetTokens) && (obj.budgetTokens as number) >= 0)
  ) {
    return false;
  }
  return true;
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

/** 请求体里 `attachments` 非空（用来放行「只发附件、不写字」） */
function hasAttachments(raw: unknown): boolean {
  return Array.isArray(raw) && raw.length > 0;
}

export function createChatsRoutes(db: Db, providers: ProviderService, assets: AssetsService) {
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
        // 没带 personaId 字段 → 用默认档案；显式 null → 不用档案
        const personaId =
          'personaId' in body
            ? typeof body.personaId === 'string'
              ? body.personaId
              : null
            : readDefaultPersonaId(db);
        // 同上：没带 presetId 字段 → 用默认预设；显式 null → 不用预设（「无」）
        const presetId =
          'presetId' in body
            ? typeof body.presetId === 'string'
              ? body.presetId
              : null
            : readDefaultPresetId(db);
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

        // 新建对话页可以只挑一本世界书开场（不带角色卡），这些书同时落成聊天书
        const lorebookIds = Array.isArray(body.lorebookIds)
          ? [
              ...new Set(
                body.lorebookIds.filter((id): id is string => typeof id === 'string' && id !== ''),
              ),
            ]
          : [];
        const bookRows = lorebookIds.map((id) =>
          db.select().from(schema.lorebooks).where(eq(schema.lorebooks.id, id)).get(),
        );
        const missingIndex = bookRows.findIndex((row) => row === undefined);
        if (missingIndex >= 0) {
          return c.json(
            { error: 'not_found', message: `世界书不存在：${lorebookIds[missingIndex]}` },
            404,
          );
        }
        const openers = loadBookOpeners(db, lorebookIds);

        // 标题：显式给的 > 角色名 > 第一本世界书的名字（没有开场白的书同样能开场）
        const title =
          typeof body.title === 'string' && body.title.trim()
            ? body.title.trim()
            : (characterRow?.name ?? bookRows[0]?.name ?? '');

        let chat = db
          .insert(schema.chats)
          .values({ title, mode, characterIds, personaId, presetId })
          .returning()
          .get();
        if (lorebookIds.length > 0) setChatLorebooks(db, chat.id, lorebookIds);

        /**
         * 开场白 → 根节点与它的 swipe 兄弟。来源按顺序拼：角色卡的
         * `first_mes` + `alternate_greetings`，再接世界书自带的开场白
         * （`@@is_greeting` 在前、role=assistant 的 prefill 在后，见 services/openers.ts）。
         */
        const card = (characterRow?.data ?? {}) as Record<string, unknown>;
        const charName = characterRow?.name ?? '';
        const firstMes = typeof card.first_mes === 'string' ? card.first_mes : '';
        const cardGreetings = characterRow
          ? [
              firstMes,
              ...(Array.isArray(card.alternate_greetings)
                ? card.alternate_greetings.filter(
                    (g): g is string => typeof g === 'string' && !!g.trim(),
                  )
                : []),
            ].filter((greeting) => greeting.trim() !== '')
          : [];
        const openings = [
          ...cardGreetings.map((text) => ({ text, name: charName })),
          // 无角色卡时用书名当说话人，与用书名当标题保持一致
          ...openers.map((opener) => ({ text: opener.content, name: charName || opener.bookName })),
        ];

        if (openings.length > 0) {
          const userName = personaRow?.name ?? 'User';
          let rootId: string | null = null;
          openings.forEach((opening, index) => {
            // ST 1.18：开场白里的 {{persona}} {{description}} … 取各字段 baseChatReplace 后的值
            // （字段先 trim、再只展开 {{user}} {{char}} 等，字段里的卡类宏为空），见 M4 契约 §9 MSS 修正
            const seed = { char: opening.name, user: userName };
            const base = (value: unknown) =>
              typeof value === 'string' ? substituteMacros(value.trim(), seed) : undefined;
            const row = insertNode(db, {
              chatId: chat.id,
              parentId: null,
              siblingSeq: index,
              role: 'assistant',
              name: opening.name,
              parts: [
                {
                  type: 'text',
                  text: substituteMacros(opening.text, {
                    ...seed,
                    persona: base(personaRow?.description),
                    description: base(card.description),
                    personality: base(card.personality),
                    scenario: base(card.scenario),
                    mesExamples: base(card.mes_example),
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
          // 推理强度：null = 跟随预设（删掉该键）
          if (overrides && 'thinking' in overrides) {
            const thinking: unknown = overrides.thinking;
            if (thinking === null || thinking === undefined) {
              delete overrides.thinking;
            } else if (!isThinkingOverride(thinking)) {
              return c.json({ error: 'invalid', message: 'overrides.thinking 非法' }, 400);
            }
          }
          // 允许模型输出图片：null = 按默认（删掉该键）
          if (overrides && 'imageOutput' in overrides) {
            const imageOutput: unknown = overrides.imageOutput;
            if (imageOutput === null || imageOutput === undefined) {
              delete overrides.imageOutput;
            } else if (typeof imageOutput !== 'boolean') {
              return c.json({ error: 'invalid', message: 'overrides.imageOutput 非法' }, 400);
            }
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
        // 只带附件时 text 可以省略
        if (
          typeof body.text !== 'string' &&
          !(body.text === undefined && hasAttachments(body.attachments))
        ) {
          return c.json({ error: 'invalid', message: '缺少 text' }, 400);
        }
        let media: Part[];
        try {
          media = parseAttachments(assets, body.attachments);
        } catch (e) {
          if (e instanceof AttachmentError) {
            return c.json({ error: 'invalid', message: e.message }, 400);
          }
          throw e;
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
          parts: messageParts(typeof body.text === 'string' ? body.text : '', media),
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
        let parts = (node.parts as Part[] | null) ?? [];
        if (body.text !== undefined) {
          if (typeof body.text !== 'string') {
            return c.json({ error: 'invalid', message: 'text 非法' }, 400);
          }
          // 非文本 part（图片/文档）保留，只替换文本部分
          const kept = parts.filter(
            (part) => part.type !== 'text' && part.type !== 'reasoning_opaque',
          );
          parts = [{ type: 'text', text: body.text }, ...kept];
          textChanged = true;
        }
        // 附件（M4 §3.3）：替换该节点全部 image / document part，文本保留；null / [] = 移除全部附件
        if (body.attachments !== undefined) {
          let media: Part[];
          try {
            media = parseAttachments(assets, body.attachments);
          } catch (e) {
            if (e instanceof AttachmentError) {
              return c.json({ error: 'invalid', message: e.message }, 400);
            }
            throw e;
          }
          parts = [...parts.filter((part) => !isMediaPart(part)), ...media];
          textChanged = true;
        }
        if (textChanged) patch.parts = compactMediaParts(parts);
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
        // 编辑正文 / 附件使下游推理块失效（PLAN §3.1「推理内容持久化」）
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
       * 提示词检查器数据源（契约 §3.6 + §6）：dryRun 组装一轮 →
       * `ir` / `request`（去 headers）/ `strictIr` / `diff` / `layout` / `wi` / `warnings` /
       * `tokenEstimate` / `lastUsage`。不写库、不推进 WI 时间态、不落变量副作用。
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
        try {
          return c.json(buildInspect(db, context, assets));
        } catch (e) {
          return c.json({ error: 'invalid', message: (e as Error).message }, 400);
        }
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

        // 附件在开流之前校验：不存在的 assetId 直接回 400，不产生半截节点
        let userMedia: Part[] = [];
        try {
          userMedia = parseAttachments(assets, body.userMessage?.attachments);
        } catch (e) {
          if (e instanceof AttachmentError) {
            return c.json({ error: 'invalid', message: e.message }, 400);
          }
          throw e;
        }

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
          /** 最终 parts：文本与模型输出的图片按到达顺序交错，连续文本增量并进同一个 text part（M4 §1.3） */
          const outParts: Part[] = [];
          let imageCount = 0;
          /** 流式解析中的非致命告警（GenEvent `warning`，例如 http 图片链接降级） */
          const streamWarnings: string[] = [];
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
            if (userMessage && (typeof userMessage.text === 'string' || userMedia.length > 0)) {
              const userRow = appendNode(db, chatNow(), {
                parentId: genParentId,
                role: 'user',
                parts: messageParts(
                  typeof userMessage.text === 'string' ? userMessage.text : '',
                  userMedia,
                ),
                name: typeof userMessage.name === 'string' ? userMessage.name : null,
              });
              genParentId = userRow.id;
              await send('node', {
                node: toMessageNode(userRow),
                chat: toChatSummary(db, chatNow()),
              });
            }

            // 2. 组装 v2：世界书 / 宏 / 正则 / 变量 / 布局（契约 §6）
            const caps = resolved.adapter.capabilities(model, resolved.conn);
            const nodesForAssemble = loadNodes(db, chatId);
            // MVU `[InitVar]`：组装前先把变量表初始化好，第一轮的
            // `{{get_message_variable::stat_data}}` 才能看到初始值（M5 §2.2）
            const mvuInit = ensureMvuInitialized(
              db,
              chatNow(),
              readNearestSnapshots(
                genParentId ? pathToNode(nodesForAssemble, genParentId) : [],
              ).variables,
            );
            const assembled = assemblePrompt(
              buildAssembleInput(db, {
                chat: chatNow(),
                overrides,
                nodes: nodesForAssemble,
                parentId: genParentId,
                provider,
                model,
                layoutMode,
                caps,
                // 文档附件在组装前内联（M4 §3.3）
                assets,
                ...(mvuInit.initialized.length > 0 ? { variablesOverride: mvuInit.variables } : {}),
              }),
            );
            if (mvuInit.initialized.length > 0 || mvuInit.errors.length > 0) {
              await send('variables', {
                nodeId: null,
                // 形状与更新事件保持一致：前端一个分支就能处理两种
                changed: false,
                initialized: mvuInit.initialized,
                errors: mvuInit.errors.map((error) => ({
                  command: `[InitVar] ${error.book}`,
                  message: error.message,
                })),
                updates: [],
                variables: mvuInit.variables,
              });
            }
            const ir = assembled.ir;
            // 图片 / PDF 渲染成各家内联块：只解析 IR 里出现过的资产，首次用到时读文件
            const resolveAsset = createAssetResolver(assets, ir);

            /** 连续文本增量并进最后一个 text part；前面是图片时另起一段 */
            const appendText = (delta: string) => {
              if (delta === '') return;
              const last = outParts[outParts.length - 1];
              if (last?.type === 'text') {
                outParts[outParts.length - 1] = { type: 'text', text: last.text + delta };
              } else {
                outParts.push({ type: 'text', text: delta });
              }
            };

            // 3. assistant 节点（parts 空），head 移过去；WI 时间态与变量快照随节点落库
            const assistantRow = appendNode(db, chatNow(), {
              parentId: genParentId,
              role: 'assistant',
              parts: [],
              provider,
              model,
              // WITimedState 没有索引签名，JSON 列要 Record；结构一致，断言即可
              wiState: assembled.wiState as unknown as Record<string, unknown>,
              variables: assembled.variables.chat,
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
              finalRequest = buildProviderRequest(
                active.adapter,
                ir,
                active.conn,
                model,
                overrides.thinking,
                { resolveAsset, imageOutput: overrides.imageOutput },
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
                    appendText(ev.text);
                    await send('text.delta', { nodeId: assistantId, text: ev.text });
                    break;
                  case 'image': {
                    // 模型输出的图片：先落盘成 generated 资产，再追加 part、发 SSE `image`
                    const bytes = Buffer.from(ev.data, 'base64');
                    const mime = bytes.length > 0 ? generatedImageMime(bytes, ev.mime) : null;
                    if (!mime) {
                      streamWarnings.push(`模型输出的图片无法识别（${ev.mime}），已忽略`);
                      break;
                    }
                    const asset = assets.save({
                      bytes,
                      kind: 'generated',
                      mime,
                      source: `generated:${assistantId}`,
                    });
                    const part = { type: 'image', assetId: asset.id, mime: asset.mime } as const;
                    outParts.push(part);
                    imageCount += 1;
                    await send('image', { nodeId: assistantId, part });
                    break;
                  }
                  case 'warning':
                    streamWarnings.push(ev.message);
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
                    // tool.call：暂不落地，保留事件名
                    break;
                }
              }
              if (!retry) break;
            }

            if (aborted) stopReason = 'abort';

            if (genError && text === '' && imageCount === 0) {
              // 无任何文本且无图片：删除刚创建的节点、head 回退、只发 error
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
                  // 文本与图片按到达顺序；中止时已收到的图片同样保留
                  parts: outParts,
                  reasoning,
                  usage,
                  extra: {
                    stopReason: stopReason ?? (genError ? 'error' : 'end'),
                    // 已脱敏：内联图片 / PDF 的 base64 替换成占位串
                    request: requestForStorage(finalRequest),
                    capabilities: capabilitiesSummary(caps),
                    // 契约 §6：布局报告、WI 激活摘要与告警随节点返回，供检查器/前端展示
                    layout: assembled.layout,
                    activations: ir.meta.activations,
                    // 组装告警 + 适配器告警（例如「模型不支持图片输入，已丢弃 N 张图片」）+ 流式告警
                    warnings: [
                      ...new Set([
                        ...ir.meta.warnings,
                        ...((finalRequest as ProviderRequest | null)?.warnings ?? []),
                        ...streamWarnings,
                      ]),
                    ],
                  },
                })
                .where(eq(schema.messageNodes.id, assistantId))
                .returning()
                .get();
              // 全局变量变更入库（chat 作用域已随节点快照落库）
              applyGlobalChanges(db, assembled.variables.globalChanges, assistantId);
              // MVU：从本节点的快照（= 生成前状态）出发应用 `<UpdateVariable>`，写回同一节点。
              // 父快照不动，所以 swipe / 重生天然从同一起点重新算（M5 §2.3）。
              const mvuResult = runMvuForNode(db, chatNow(), finalRow, text);
              if (mvuResult) {
                await send('variables', {
                  nodeId: mvuResult.nodeId,
                  variables: mvuResult.variables,
                  updates: mvuResult.updates,
                  errors: mvuResult.errors,
                  initialized: [],
                });
              }
              // 本轮新冻结的易变段并入 chat.metadata.frozenVolatile，下一轮复用
              const newFrozen = assembled.layout.newFrozenVolatile;
              if (Object.keys(newFrozen).length > 0) {
                const current = chatNow();
                patchChat(db, chatId, {
                  metadata: {
                    ...(current.metadata ?? {}),
                    frozenVolatile: { ...readFrozenVolatile(current), ...newFrozen },
                  },
                });
              }
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
            // 组装 / buildRequest / 适配器抛出的异常：无文本且无图片则回滚节点；
            // 否则把已收到的文本与图片写进节点（不然已落盘的生成图片没有任何节点引用）
            if (assistantId && text === '' && imageCount === 0) {
              deleteSubtree(db, chatNow(), assistantId);
              assistantId = null;
            } else if (assistantId) {
              db.update(schema.messageNodes)
                .set({ parts: outParts, extra: { stopReason: 'error' } })
                .where(eq(schema.messageNodes.id, assistantId))
                .run();
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
