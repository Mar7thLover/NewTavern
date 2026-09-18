import { TRUST_LEVELS, type FrontendCardTrustLevel } from '@newtavern/sandbox-sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { fetchJson, mutate, queryKeys, useSetSetting, useSetting } from './api';

/**
 * M5 的前端接口：变量表、MVU、前端卡设置、沙箱 `generate`。
 * 见 docs/M5-CONTRACT.md §3.4 / §4.6。放在单独文件里，`api.ts` 只加类型不加 hook。
 */

/* ------------------------------------------------------------------ */
/* 变量                                                                */
/* ------------------------------------------------------------------ */

export type VariableScopeName = 'message' | 'chat' | 'character' | 'global' | 'script';

export interface ChatVariables {
  /** 快照所属节点（不传 nodeId 时是 head） */
  nodeId: string | null;
  /** 该节点的变量快照（MVU 的 `stat_data` 在里面） */
  message: Record<string, unknown>;
  /** 与 `message` 同一份表（新酒馆的聊天变量按节点存） */
  chat: Record<string, unknown>;
  global: Record<string, unknown>;
  character: Record<string, unknown>;
}

export interface MvuUpdateInfo {
  type: string;
  path: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  display: string;
}

export interface MvuErrorInfo {
  command: string;
  message: string;
}

/** SSE `variables` 事件的载荷，也是 `mvu/run` 与 `mvu/replay` 的单条结果 */
export interface MvuNodeResult {
  nodeId: string | null;
  changed: boolean;
  variables: Record<string, unknown>;
  updates: MvuUpdateInfo[];
  errors: MvuErrorInfo[];
  /** 本轮由哪些世界书的 `[InitVar]` 初始化来（只有第一轮非空） */
  initialized?: string[];
}

export const cardQueryKeys = {
  variables: (chatId: string, nodeId: string | null) =>
    ['chats', chatId, 'variables', nodeId ?? 'head'] as const,
  variableTable: (scope: string, ownerId: string) => ['variables', scope, ownerId] as const,
};

export function fetchChatVariables(chatId: string, nodeId?: string | null): Promise<ChatVariables> {
  const query = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
  return fetchJson<ChatVariables>(`/api/chats/${encodeURIComponent(chatId)}/variables${query}`);
}

export function useChatVariables(chatId: string | null, nodeId: string | null) {
  return useQuery({
    queryKey: cardQueryKeys.variables(chatId ?? '', nodeId),
    queryFn: () => fetchChatVariables(chatId as string, nodeId),
    enabled: chatId !== null,
  });
}

export interface ReplaceVariablesInput {
  scope: VariableScopeName;
  nodeId?: string | null;
  ownerId?: string;
  variables: Record<string, unknown>;
}

export function replaceChatVariables(
  chatId: string,
  input: ReplaceVariablesInput,
): Promise<{ scope: string; nodeId?: string; variables: Record<string, unknown> }> {
  return mutate(`/api/chats/${encodeURIComponent(chatId)}/variables`, 'PUT', input);
}

export function useReplaceVariables(chatId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReplaceVariablesInput) =>
      replaceChatVariables(chatId as string, input),
    onSuccess: () => {
      if (chatId) {
        void queryClient.invalidateQueries({ queryKey: ['chats', chatId, 'variables'] });
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* MVU                                                                */
/* ------------------------------------------------------------------ */

export function mvuParse(
  chatId: string,
  body: { nodeId?: string | null; message?: string; data?: Record<string, unknown> },
): Promise<{
  changed: boolean;
  variables: Record<string, unknown>;
  updates: MvuUpdateInfo[];
  errors: MvuErrorInfo[];
}> {
  return mutate(`/api/chats/${encodeURIComponent(chatId)}/mvu/parse`, 'POST', body);
}

/** 重新解析某条消息的变量更新（MVU 的「重新处理变量」） */
export function useMvuRun(chatId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: string | null) =>
      mutate<MvuNodeResult>(`/api/chats/${encodeURIComponent(chatId as string)}/mvu/run`, 'POST', {
        nodeId,
      }),
    onSuccess: () => {
      if (chatId) {
        void queryClient.invalidateQueries({ queryKey: ['chats', chatId, 'variables'] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
    },
  });
}

/** 从某条消息起沿当前分支重算变量（MVU 的「重演楼层」） */
export function useMvuReplay(chatId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: string | null) =>
      mutate<{ results: MvuNodeResult[] }>(
        `/api/chats/${encodeURIComponent(chatId as string)}/mvu/replay`,
        'POST',
        { nodeId },
      ),
    onSuccess: () => {
      if (chatId) {
        void queryClient.invalidateQueries({ queryKey: ['chats', chatId, 'variables'] });
        void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export interface CardSettings {
  /** 按角色卡记的信任级别（键是角色 id） */
  trustByCharacter: Record<string, FrontendCardTrustLevel>;
  /** 默认信任级别 */
  defaultTrust: FrontendCardTrustLevel;
  /** 给 iframe 注入社区常用外链（FontAwesome / Tailwind）；关掉更适合离线与隐私 */
  externalLibs: boolean;
  /** 跑角色卡与全局脚本库里的脚本 */
  scripts: boolean;
}

export const DEFAULT_CARD_SETTINGS: CardSettings = {
  trustByCharacter: {},
  defaultTrust: 'standard',
  externalLibs: true,
  scripts: true,
};

function isTrust(value: unknown): value is FrontendCardTrustLevel {
  return typeof value === 'string' && (TRUST_LEVELS as readonly string[]).includes(value);
}

export function normalizeCardSettings(value: unknown): CardSettings {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const trustByCharacter: Record<string, FrontendCardTrustLevel> = {};
  const rawTrust = source.trustByCharacter;
  if (typeof rawTrust === 'object' && rawTrust !== null) {
    for (const [key, level] of Object.entries(rawTrust as Record<string, unknown>)) {
      if (isTrust(level)) trustByCharacter[key] = level;
    }
  }
  return {
    trustByCharacter,
    defaultTrust: isTrust(source.defaultTrust) ? source.defaultTrust : DEFAULT_CARD_SETTINGS.defaultTrust,
    externalLibs:
      typeof source.externalLibs === 'boolean' ? source.externalLibs : DEFAULT_CARD_SETTINGS.externalLibs,
    scripts: typeof source.scripts === 'boolean' ? source.scripts : DEFAULT_CARD_SETTINGS.scripts,
  };
}

export interface MvuSettings {
  /** 自动解析模型输出里的 `<UpdateVariable>` */
  enabled: boolean;
}

export function normalizeMvuSettings(value: unknown): MvuSettings {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return { enabled: typeof source.enabled === 'boolean' ? source.enabled : true };
}

export const CARD_SETTING_KEYS = { cards: 'cards', mvu: 'mvu' } as const;

export const useCardSettings = () => useSetting(CARD_SETTING_KEYS.cards, normalizeCardSettings);
export const useSetCardSettings = () =>
  useSetSetting(CARD_SETTING_KEYS.cards, normalizeCardSettings);
export const useMvuSettings = () => useSetting(CARD_SETTING_KEYS.mvu, normalizeMvuSettings);
export const useSetMvuSettings = () => useSetSetting(CARD_SETTING_KEYS.mvu, normalizeMvuSettings);

/** 这张卡该用哪档信任级别 */
export function trustFor(
  settings: CardSettings | undefined,
  characterId: string | null | undefined,
): FrontendCardTrustLevel {
  if (!settings) return DEFAULT_CARD_SETTINGS.defaultTrust;
  if (characterId && settings.trustByCharacter[characterId]) {
    return settings.trustByCharacter[characterId];
  }
  return settings.defaultTrust;
}

/* ------------------------------------------------------------------ */
/* 沙箱 generate（SSE）                                                */
/* ------------------------------------------------------------------ */

export interface SandboxGenerateBody {
  mode: 'generate' | 'raw';
  userInput?: string;
  maxChatHistory?: number | 'all';
  orderedPrompts?: unknown;
  shouldStream?: boolean;
  unsupported?: string[];
}

export interface SandboxGenerateHandlers {
  onDelta?: (text: string) => void;
  onWarning?: (warnings: string[]) => void;
  signal?: AbortSignal;
}

/**
 * 前端卡的 `generate()`：SSE 流，回最终文本。
 * 与正式生成的区别是**不写消息树**（服务端 dryRun 组装），见 M5 契约 §4.6。
 */
export async function sandboxGenerate(
  chatId: string,
  body: SandboxGenerateBody,
  handlers: SandboxGenerateHandlers = {},
): Promise<string> {
  const response = await fetch(
    `/api/chats/${encodeURIComponent(chatId)}/sandbox/generate`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      ...(handlers.signal ? { signal: handlers.signal } : {}),
    },
  );
  if (!response.ok || !response.body) {
    throw new Error(`生成失败：HTTP ${response.status}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let failure: string | null = null;

  const handleBlock = (block: string) => {
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (dataLines.length === 0) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
    } catch {
      return;
    }
    if (event === 'text.delta' && typeof payload.text === 'string') {
      text += payload.text;
      handlers.onDelta?.(payload.text);
    } else if (event === 'warning' && Array.isArray(payload.warnings)) {
      handlers.onWarning?.(payload.warnings as string[]);
    } else if (event === 'done' && typeof payload.text === 'string') {
      text = payload.text;
    } else if (event === 'error') {
      const error = payload.error as { message?: string } | undefined;
      failure = error?.message ?? '生成失败';
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      handleBlock(buffer.slice(0, index));
      buffer = buffer.slice(index + 2);
      index = buffer.indexOf('\n\n');
    }
  }
  if (buffer.trim() !== '') handleBlock(buffer);
  if (failure !== null) throw new Error(failure);
  return text;
}
