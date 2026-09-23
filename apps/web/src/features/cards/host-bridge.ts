import { childrenOf, type SlashHost } from '@newtavern/core';
import {
  RPC_METHODS,
  type RpcHandler,
  type SandboxChatMessage,
  type SandboxMacroContext,
  type SandboxVariables,
} from '@newtavern/sandbox-sdk';

import { runSlashCommand } from './slash';
import {
  deleteChatInjects,
  fetchChatVariables,
  mvuParse,
  postChatInjects,
  putVariableSchema,
  putVariableTable,
  replaceChatVariables,
  sandboxGenerate,
  type VariableScopeName,
} from '../../lib/api-cards';
import {
  fetchJson,
  mutate,
  nodeText,
  type ChatDetail,
  type LorebookDetail,
  type LorebookEntry,
  type LorebookEntryInput,
  type LorebookSummary,
  type MessageNode,
  type PresetSummary,
} from '../../lib/api';
import { pathToHead } from '../chat/shared';
import { cardGenerateImage } from '../imagine/api';

/**
 * 宿主侧的兼容层：把新酒馆的消息树 / 变量映射成酒馆助手那套形状，
 * 并把卡的写操作翻译成我们的 API 调用。见 docs/M5-CONTRACT.md §4.5。
 *
 * 两处**概念错位**必须在这里挑明（兼容矩阵也写了）：
 *
 * 1. **楼层号 vs 节点 id**：酒馆助手按「第几楼」定位消息，新酒馆是消息树。
 *    这里用「当前分支 root→head 的下标」当楼层号，并额外给每条消息带上 `node_id`；
 *    切了分支楼层号会变，节点 id 不会。
 * 2. **删除会连带后代**：树上删一个节点等于删掉它整条子树。`deleteChatMessages`
 *    删的是「该楼层及其之后」，不是只抽掉中间一层。
 */

export interface CardHostContext {
  chatId: string;
  /** 帧所在的消息节点（脚本帧为 null） */
  nodeId: string | null;
  /** 当前会话详情（消息树） */
  detail: ChatDetail | undefined;
  /** 角色卡数据（`getCharData`） */
  charData: unknown;
  /** 变量表（`getVariables`），由宿主按需取来 */
  variables: SandboxVariables;
  /** 宏上下文（`substitudeMacros` 的同步子集） */
  macros: SandboxMacroContext;
  /** 脚本帧的按钮 */
  scriptButtons?: { name: string; visible: boolean }[];
  /** 脚本帧的脚本 id（`script` 作用域变量的 ownerId） */
  scriptId?: string | null;
}

export interface CardHostActions {
  /** 提示（toastr → 应用自己的提示条） */
  notify: (level: string, message: string, title?: string) => void;
  /** 卡把事件转回宿主总线 */
  emit: (event: string, args: unknown[]) => void;
  /** 数据变了，宿主要刷新缓存 */
  invalidate: () => void;
  /** generate 的流式增量（宿主转成 iframe 事件） */
  onGenerationEvent: (event: string, args: unknown[]) => void;
  /** 脚本按钮变更 */
  setScriptButtons?: (buttons: { name: string; visible: boolean }[]) => void;
  /** `triggerSlash` 的宿主（`slash-host.ts` 的 createSlashHost） */
  slashHost?: () => SlashHost;
}

/* ------------------------------------------------------------------ */
/* 消息映射                                                            */
/* ------------------------------------------------------------------ */

/** 当前分支（root→head）；楼层号就是这里的下标 */
export function branchPath(detail: ChatDetail | undefined): MessageNode[] {
  if (!detail) return [];
  return pathToHead(detail.nodes, detail.headNodeId);
}

/** 节点 → 酒馆助手 `ChatMessage`（`data` 是该楼层的变量快照） */
export function toChatMessage(
  node: MessageNode,
  messageId: number,
  options: {
    nodes: readonly MessageNode[];
    variables?: Record<string, unknown>;
    characterName: string;
    userName: string;
  },
): SandboxChatMessage {
  const siblings = childrenOf(options.nodes, node.parentId);
  const swipeIndex = siblings.findIndex((item) => item.id === node.id);
  return {
    message_id: messageId,
    node_id: node.id,
    name: node.name ?? (node.role === 'user' ? options.userName : options.characterName),
    role: node.role,
    is_hidden: node.isHidden,
    message: nodeText(node),
    data: options.variables ?? {},
    extra: node.extra ?? {},
    // 兄弟节点就是 swipe（无后代的兄弟），`include_swipes` 时卡要看到它们
    swipes: siblings.map((item) => nodeText(item)),
    swipe_id: swipeIndex < 0 ? 0 : swipeIndex,
  };
}

export function buildChatMirror(context: CardHostContext): SandboxChatMessage[] {
  const detail = context.detail;
  if (!detail) return [];
  const path = branchPath(detail);
  const characterName = detail.character?.name ?? '角色';
  const userName = '用户';
  return path.map((node, index) =>
    toChatMessage(node, index, {
      nodes: detail.nodes,
      characterName,
      userName,
      // 只有帧自己那一层的快照是现成的，别的楼层按需取（卡真要时走 byMessageId）
      ...(node.id === context.nodeId ? { variables: context.variables.message } : {}),
    }),
  );
}

/* ------------------------------------------------------------------ */
/* 方法实现                                                            */
/* ------------------------------------------------------------------ */

interface ChatSetParams {
  messages: {
    message_id: number;
    node_id?: string;
    message?: string;
    is_hidden?: boolean;
    name?: string;
    data?: Record<string, unknown>;
    swipe_id?: number;
  }[];
}

function nodeAt(context: CardHostContext, messageId: number, nodeId?: string): MessageNode | undefined {
  const path = branchPath(context.detail);
  if (nodeId) {
    const byId = context.detail?.nodes.find((node) => node.id === nodeId);
    if (byId) return byId;
  }
  return path[messageId];
}

/** 名字 → 世界书（酒馆助手按名字寻书） */
async function findBook(name: string): Promise<LorebookSummary | undefined> {
  const books = await fetchJson<LorebookSummary[]>('/api/lorebooks');
  return books.find((book) => book.name === name);
}

async function loadBook(name: string): Promise<LorebookDetail> {
  const summary = await findBook(name);
  if (!summary) throw new Error(`找不到世界书：${name}`);
  return fetchJson<LorebookDetail>(`/api/lorebooks/${encodeURIComponent(summary.id)}`);
}

/** 我们的条目 → 酒馆助手 `LorebookEntry` 形状（字段名是 ST 的） */
function toHelperEntry(entry: LorebookEntry, index: number): Record<string, unknown> {
  return {
    uid: entry.uid ?? index,
    display_index: entry.displayIndex ?? index,
    comment: entry.comment ?? '',
    enabled: !entry.disabled,
    type: entry.constant ? 'constant' : 'selective',
    position: entry.position,
    depth: entry.depth,
    order: entry.entryOrder,
    probability: entry.probability ?? 100,
    keys: entry.keys,
    filters: entry.secondaryKeys,
    logic: entry.selectiveLogic ?? 0,
    content: entry.content,
    exclude_recursion: entry.excludeRecursion ?? false,
    prevent_recursion: entry.preventRecursion ?? false,
    delay_until_recursion: entry.delayUntilRecursion ?? false,
    scan_depth: entry.scanDepth,
    case_sensitive: entry.caseSensitive,
    match_whole_words: entry.matchWholeWords,
    use_group_scoring: entry.useGroupScoring,
    automation_id: entry.automationId ?? '',
    role: entry.role,
    sticky: entry.sticky ?? 0,
    cooldown: entry.cooldown ?? 0,
    delay: entry.delay ?? 0,
  };
}

/** 酒馆助手条目 → 我们的输入（只认它真的给了的字段） */
function fromHelperEntry(raw: Record<string, unknown>, existing?: LorebookEntry): LorebookEntryInput {
  const input: LorebookEntryInput = existing?.id ? { id: existing.id } : {};
  const set = <K extends keyof LorebookEntryInput>(key: K, value: LorebookEntryInput[K]) => {
    if (value !== undefined) input[key] = value;
  };
  if (typeof raw.content === 'string') set('content', raw.content);
  if (typeof raw.comment === 'string') set('comment', raw.comment);
  if (Array.isArray(raw.keys)) set('keys', raw.keys.filter((key): key is string => typeof key === 'string'));
  if (Array.isArray(raw.filters)) {
    set('secondaryKeys', raw.filters.filter((key): key is string => typeof key === 'string'));
  }
  if (typeof raw.enabled === 'boolean') set('disabled', !raw.enabled);
  if (raw.type === 'constant' || raw.type === 'selective') set('constant', raw.type === 'constant');
  if (typeof raw.position === 'number') set('position', raw.position);
  if (typeof raw.depth === 'number') set('depth', raw.depth);
  if (typeof raw.order === 'number') set('entryOrder', raw.order);
  if (typeof raw.probability === 'number') set('probability', raw.probability);
  if (typeof raw.sticky === 'number') set('sticky', raw.sticky);
  if (typeof raw.cooldown === 'number') set('cooldown', raw.cooldown);
  if (typeof raw.delay === 'number') set('delay', raw.delay);
  return input;
}

/** 整本回写：`PUT /api/lorebooks/:id` 收的是**完整**条目列表 */
async function saveBook(bookId: string, entries: LorebookEntryInput[]): Promise<void> {
  await mutate(`/api/lorebooks/${encodeURIComponent(bookId)}`, 'PUT', { entries });
}

function entryInputOf(entry: LorebookEntry): LorebookEntryInput {
  return { id: entry.id };
}

/**
 * 组装一帧的 RPC handlers。纯函数：依赖全部由 `context()` / `actions` 传进来，
 * 这样宿主组件只负责「什么时候刷新 context」。
 */
export function createCardHandlers(
  getContext: () => CardHostContext,
  actions: CardHostActions,
): Record<string, RpcHandler> {
  const generations = new Map<string, AbortController>();

  const handlers: Record<string, RpcHandler> = {
    [RPC_METHODS.chatSet]: async (params) => {
      const { messages } = (params ?? {}) as ChatSetParams;
      const context = getContext();
      for (const message of messages ?? []) {
        const node = nodeAt(context, message.message_id, message.node_id);
        if (!node) continue;
        const patch: Record<string, unknown> = {};
        if (typeof message.message === 'string') patch.text = message.message;
        if (typeof message.is_hidden === 'boolean') patch.isHidden = message.is_hidden;
        if (typeof message.name === 'string') patch.name = message.name;
        if (Object.keys(patch).length > 0) {
          await mutate(
            `/api/chats/${encodeURIComponent(context.chatId)}/nodes/${encodeURIComponent(node.id)}`,
            'PATCH',
            patch,
          );
        }
        if (message.data && typeof message.data === 'object') {
          await replaceChatVariables(context.chatId, {
            scope: 'message',
            nodeId: node.id,
            variables: message.data,
          });
        }
        if (typeof message.swipe_id === 'number') {
          // 切 swipe = 把 head 指到那个兄弟节点
          const siblings = childrenOf(context.detail?.nodes ?? [], node.parentId);
          const target = siblings[message.swipe_id];
          if (target) {
            await mutate(`/api/chats/${encodeURIComponent(context.chatId)}`, 'PATCH', {
              headNodeId: target.id,
            });
          }
        }
      }
      actions.invalidate();
      return null;
    },

    [RPC_METHODS.chatCreate]: async (params) => {
      const { messages, option } = (params ?? {}) as {
        messages: { role: string; message: string; name?: string; is_hidden?: boolean }[];
        option?: { insert_before?: number | 'end' };
      };
      const context = getContext();
      if (option?.insert_before !== undefined && option.insert_before !== 'end') {
        actions.notify('warning', '新酒馆的消息是树：插入到中间楼层暂不支持，已追加到末尾');
      }
      for (const message of messages ?? []) {
        await mutate(`/api/chats/${encodeURIComponent(context.chatId)}/messages`, 'POST', {
          role: message.role,
          text: message.message ?? '',
          ...(message.name ? { name: message.name } : {}),
        });
      }
      actions.invalidate();
      return null;
    },

    [RPC_METHODS.chatDelete]: async (params) => {
      const { messageIds } = (params ?? {}) as { messageIds: number[] };
      const context = getContext();
      // 从大到小删：删子树会让后面的楼层号失效
      for (const messageId of [...(messageIds ?? [])].sort((a, b) => b - a)) {
        const node = nodeAt(context, messageId);
        if (!node) continue;
        await mutate(
          `/api/chats/${encodeURIComponent(context.chatId)}/nodes/${encodeURIComponent(node.id)}`,
          'DELETE',
        );
      }
      actions.invalidate();
      return null;
    },

    [RPC_METHODS.variablesReplace]: async (params) => {
      const { scope, variables, messageId, scriptId } = (params ?? {}) as {
        scope: VariableScopeName;
        variables: Record<string, unknown>;
        messageId?: number;
        scriptId?: string;
      };
      const context = getContext();
      if (scope === 'script') {
        // 脚本变量按脚本 id 存（`variables` 表 scope='script'）；卡帧里要显式给 script_id
        const owner = scriptId ?? context.scriptId;
        if (!owner) throw new Error('script 作用域的变量只能在脚本里用（或传 script_id）');
        await putVariableTable('script', owner, variables);
        actions.invalidate();
        return null;
      }
      const nodeId =
        messageId === undefined
          ? context.nodeId
          : (nodeAt(context, messageId)?.id ?? context.nodeId);
      await replaceChatVariables(context.chatId, {
        scope,
        ...(scope === 'message' || scope === 'chat' ? { nodeId } : {}),
        variables,
      });
      actions.invalidate();
      return null;
    },

    [RPC_METHODS.mvuParse]: async (params) => {
      const { message, data } = (params ?? {}) as {
        message: string;
        data?: Record<string, unknown>;
      };
      const context = getContext();
      return mvuParse(context.chatId, {
        nodeId: context.nodeId,
        message,
        ...(data ? { data } : {}),
      });
    },

    [RPC_METHODS.mvuReplace]: async (params) => {
      const { data } = (params ?? {}) as { data: Record<string, unknown> };
      const context = getContext();
      await replaceChatVariables(context.chatId, {
        scope: 'message',
        nodeId: context.nodeId,
        variables: data,
      });
      actions.invalidate();
      return null;
    },

    [RPC_METHODS.generate]: async (params) => {
      const body = (params ?? {}) as {
        mode: 'generate' | 'raw';
        generationId: string;
        userInput?: string;
        shouldStream?: boolean;
        maxChatHistory?: number | 'all';
        orderedPrompts?: unknown;
        unsupported?: string[];
        injects?: unknown;
        overrides?: unknown;
        tools?: unknown;
        toolChoice?: unknown;
        jsonSchema?: unknown;
        presetName?: string;
      };
      const context = getContext();
      const controller = new AbortController();
      generations.set(body.generationId, controller);
      actions.onGenerationEvent('js_generation_started', [body.generationId]);
      let full = '';
      try {
        const result = await sandboxGenerate(
          context.chatId,
          {
            mode: body.mode,
            ...(body.userInput === undefined ? {} : { userInput: body.userInput }),
            ...(body.maxChatHistory === undefined ? {} : { maxChatHistory: body.maxChatHistory }),
            ...(body.orderedPrompts === undefined ? {} : { orderedPrompts: body.orderedPrompts }),
            shouldStream: body.shouldStream !== false,
            ...(body.unsupported?.length ? { unsupported: body.unsupported } : {}),
            ...(body.injects === undefined ? {} : { injects: body.injects }),
            ...(body.overrides === undefined ? {} : { overrides: body.overrides }),
            ...(body.tools === undefined ? {} : { tools: body.tools }),
            ...(body.toolChoice === undefined ? {} : { toolChoice: body.toolChoice }),
            ...(body.jsonSchema === undefined ? {} : { jsonSchema: body.jsonSchema }),
            ...(body.presetName === undefined ? {} : { presetName: body.presetName }),
          },
          {
            signal: controller.signal,
            onDelta: (delta) => {
              full += delta;
              actions.onGenerationEvent('js_stream_token_received_incrementally', [
                delta,
                body.generationId,
              ]);
              actions.onGenerationEvent('js_stream_token_received_fully', [full, body.generationId]);
            },
            onWarning: (warnings) => {
              for (const warning of warnings) actions.notify('warning', warning);
            },
          },
        );
        actions.onGenerationEvent('js_generation_ended', [result.text, body.generationId]);
        return result;
      } finally {
        generations.delete(body.generationId);
      }
    },

    [RPC_METHODS.generateStop]: (params) => {
      const { generationId } = (params ?? {}) as { generationId: string | null };
      if (generationId === null) {
        for (const controller of generations.values()) controller.abort();
        generations.clear();
        return true;
      }
      const controller = generations.get(generationId);
      controller?.abort();
      generations.delete(generationId);
      return controller !== undefined;
    },

    [RPC_METHODS.slash]: async (params) => {
      const { command } = (params ?? {}) as { command: string };
      if (!actions.slashHost) throw new Error('这个界面不能执行 slash 命令');
      const result = await runSlashCommand(String(command ?? ''), actions.slashHost());
      actions.invalidate();
      return result;
    },

    [RPC_METHODS.bookEntries]: async (params) => {
      const { name } = (params ?? {}) as { name: string };
      const book = await loadBook(name);
      return book.entries.map((entry, index) => toHelperEntry(entry, index));
    },

    [RPC_METHODS.bookWrite]: async (params) => {
      const { name, mode, entries, uids } = (params ?? {}) as {
        name: string;
        mode: 'set' | 'create' | 'delete' | 'replace';
        entries?: Record<string, unknown>[];
        uids?: number[];
      };
      const book = await loadBook(name);
      const byUid = new Map<number, LorebookEntry>();
      book.entries.forEach((entry, index) => byUid.set(entry.uid ?? index, entry));

      if (mode === 'delete') {
        const remove = new Set(uids ?? []);
        await saveBook(
          book.id,
          book.entries
            .filter((entry, index) => !remove.has(entry.uid ?? index))
            .map((entry) => entryInputOf(entry)),
        );
        actions.invalidate();
        return { deleted: remove.size };
      }

      if (mode === 'create') {
        const created = (entries ?? []).map((raw) => fromHelperEntry(raw));
        await saveBook(book.id, [...book.entries.map((entry) => entryInputOf(entry)), ...created]);
        actions.invalidate();
        return { created: created.length };
      }

      if (mode === 'replace') {
        await saveBook(
          book.id,
          (entries ?? []).map((raw) => fromHelperEntry(raw)),
        );
        actions.invalidate();
        return null;
      }

      // set：按 uid 局部更新，没给的字段保持原样
      const patches = new Map<number, Record<string, unknown>>();
      for (const raw of entries ?? []) {
        const uid = typeof raw.uid === 'number' ? raw.uid : undefined;
        if (uid === undefined) continue;
        patches.set(uid, raw);
      }
      await saveBook(
        book.id,
        book.entries.map((entry, index) => {
          const patch = patches.get(entry.uid ?? index);
          return patch ? fromHelperEntry(patch, entry) : entryInputOf(entry);
        }),
      );
      actions.invalidate();
      return null;
    },

    [RPC_METHODS.notify]: (params) => {
      const { level, message, title } = (params ?? {}) as {
        level: string;
        message: string;
        title?: string;
      };
      actions.notify(level, message, title);
      return null;
    },

    [RPC_METHODS.scriptButtons]: (params) => {
      const { buttons } = (params ?? {}) as { buttons: { name: string; visible: boolean }[] };
      actions.setScriptButtons?.(buttons ?? []);
      return null;
    },

    [RPC_METHODS.eventEmit]: (params) => {
      const { event, args } = (params ?? {}) as { event: string; args: unknown[] };
      if (typeof event === 'string') actions.emit(event, args ?? []);
      return null;
    },

    // 外接生图（M4（二）§D.3）：只存资产，返回 { assetUrl }
    [RPC_METHODS.imageGenerate]: (params) => cardGenerateImage(getContext().chatId, params),

    [RPC_METHODS.variablesRegisterSchema]: async (params) => {
      const { type, schema } = (params ?? {}) as { type?: string; schema?: unknown };
      const context = getContext();
      const scope = (
        ['message', 'chat', 'character', 'global', 'script', 'preset'].includes(String(type))
          ? type
          : 'message'
      ) as VariableScopeName;
      if (typeof schema !== 'object' || schema === null) throw new Error('schema 不是对象');
      await putVariableSchema(context.chatId, scope, schema as Record<string, unknown>);
      actions.invalidate();
      return null;
    },

    [RPC_METHODS.promptsInject]: async (params) => {
      const { prompts, once } = (params ?? {}) as { prompts?: unknown[]; once?: boolean };
      await postChatInjects(getContext().chatId, Array.isArray(prompts) ? prompts : [], once === true);
      return null;
    },

    [RPC_METHODS.promptsUninject]: async (params) => {
      const { ids } = (params ?? {}) as { ids?: string[] };
      await deleteChatInjects(getContext().chatId, Array.isArray(ids) ? ids : []);
      return null;
    },

    [RPC_METHODS.presetLoad]: async (params) => {
      const { name } = (params ?? {}) as { name?: string };
      const presets = await fetchJson<PresetSummary[]>('/api/presets');
      const found = presets.find((preset) => preset.name === name);
      if (!found) throw new Error(`预设不存在：${String(name)}`);
      await mutate(`/api/chats/${encodeURIComponent(getContext().chatId)}`, 'PATCH', {
        presetId: found.id,
      });
      actions.invalidate();
      return true;
    },

    [RPC_METHODS.mirrorRefresh]: async () => {
      const context = getContext();
      // 重新取一次变量：卡自己改完想立刻看到权威值时用
      await fetchChatVariables(context.chatId, context.nodeId);
      actions.invalidate();
      return null;
    },
  };

  return handlers;
}
