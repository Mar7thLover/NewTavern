import { create } from 'zustand';

import type { GenerateBody, GenerationError } from '../../lib/api';

/** 单个助手节点的流式缓冲；持久数据始终在 TanStack Query 缓存里 */
export interface StreamBuffer {
  text: string;
  reasoning: string;
  /** 推理区是否已被用户手动展开（未展开时正文出现后自动折叠） */
  reasoningPinned: boolean;
}

export interface ChatRun {
  /** 正在生成的助手节点；`node` 事件到达前为 null */
  nodeId: string | null;
  status: 'pending' | 'streaming' | 'error';
  error: (GenerationError & { retryable: boolean }) | null;
  /** 失败后「重试」用的原始参数 */
  lastBody: GenerateBody | null;
}

interface ChatStreamState {
  /** 按节点 id 的流式缓冲 */
  streaming: Record<string, StreamBuffer>;
  /** 按聊天 id 的生成状态 */
  runs: Record<string, ChatRun>;
  startRun: (chatId: string, body: GenerateBody) => void;
  attachNode: (chatId: string, nodeId: string) => void;
  appendDelta: (nodeId: string, field: 'text' | 'reasoning', text: string) => void;
  pinReasoning: (nodeId: string, pinned: boolean) => void;
  failRun: (chatId: string, error: GenerationError & { retryable: boolean }) => void;
  endRun: (chatId: string, nodeIds?: string[]) => void;
  clearError: (chatId: string) => void;
}

const EMPTY_BUFFER: StreamBuffer = { text: '', reasoning: '', reasoningPinned: false };

function withoutKeys<T>(record: Record<string, T>, keys: readonly string[]): Record<string, T> {
  if (keys.length === 0) return record;
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

export const useChatStore = create<ChatStreamState>()((set) => ({
  streaming: {},
  runs: {},

  startRun: (chatId, body) =>
    set((state) => ({
      runs: {
        ...state.runs,
        [chatId]: { nodeId: null, status: 'pending', error: null, lastBody: body },
      },
    })),

  attachNode: (chatId, nodeId) =>
    set((state) => {
      const run = state.runs[chatId];
      return {
        runs: run
          ? { ...state.runs, [chatId]: { ...run, nodeId, status: 'streaming', error: null } }
          : state.runs,
        streaming: { ...state.streaming, [nodeId]: { ...EMPTY_BUFFER } },
      };
    }),

  appendDelta: (nodeId, field, text) =>
    set((state) => {
      const buffer = state.streaming[nodeId] ?? EMPTY_BUFFER;
      return {
        streaming: { ...state.streaming, [nodeId]: { ...buffer, [field]: buffer[field] + text } },
      };
    }),

  pinReasoning: (nodeId, pinned) =>
    set((state) => {
      const buffer = state.streaming[nodeId];
      if (!buffer) return state;
      return {
        streaming: { ...state.streaming, [nodeId]: { ...buffer, reasoningPinned: pinned } },
      };
    }),

  failRun: (chatId, error) =>
    set((state) => {
      const run = state.runs[chatId] ?? {
        nodeId: null,
        status: 'error' as const,
        error: null,
        lastBody: null,
      };
      return { runs: { ...state.runs, [chatId]: { ...run, status: 'error', error } } };
    }),

  endRun: (chatId, nodeIds = []) =>
    set((state) => {
      const run = state.runs[chatId];
      const dropped = run?.nodeId ? [...nodeIds, run.nodeId] : nodeIds;
      // 保留 error 让用户看到失败原因；成功时整条 run 移除
      if (run?.status === 'error') {
        return {
          streaming: withoutKeys(state.streaming, dropped),
          runs: { ...state.runs, [chatId]: { ...run, nodeId: null } },
        };
      }
      return {
        streaming: withoutKeys(state.streaming, dropped),
        runs: withoutKeys(state.runs, [chatId]),
      };
    }),

  clearError: (chatId) => set((state) => ({ runs: withoutKeys(state.runs, [chatId]) })),
}));

/** 生成中（含尚未拿到节点的排队态） */
export function useIsGenerating(chatId: string | null): boolean {
  return useChatStore((state) => {
    const run = chatId ? state.runs[chatId] : undefined;
    return run?.status === 'pending' || run?.status === 'streaming';
  });
}
