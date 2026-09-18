import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { useChatStore } from '../../app/store/chat';
import { emitCompat, emitNative, NATIVE_EVENTS } from '../cards/bus';
import { cardQueryKeys, type MvuNodeResult } from '../../lib/api-cards';
import { pathToHead } from './shared';
import {
  mergeNode,
  queryKeys,
  type ChatDetail,
  type ChatSummary,
  type GenerateBody,
  type GenerationError,
  type ImagePart,
  type MessageNode,
  type Usage,
} from '../../lib/api';

/* ------------------------------------------------------------------ */
/* SSE 解析                                                             */
/* ------------------------------------------------------------------ */

export interface SseMessage {
  event: string | undefined;
  data: string;
}

/** 把一个事件块（已按空行切分）解析为 { event, data }；纯注释块返回 null */
function parseBlock(block: string): SseMessage | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue; // 注释行 / 空行
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && event === undefined) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * 自写的 SSE 解析器：处理跨 chunk 断句、多行 data、CRLF 与注释（心跳 `: ping`）行。
 * 不依赖 EventSource —— 生成是 POST 请求且需要 AbortController。
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 末尾孤立的 \r 可能是下一 chunk 里 \r\n 的前半，留到下次
      const trailingCr = buffer.endsWith('\r');
      let work = trailingCr ? buffer.slice(0, -1) : buffer;
      work = work.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let index = work.indexOf('\n\n');
      while (index !== -1) {
        const message = parseBlock(work.slice(0, index));
        work = work.slice(index + 2);
        if (message) yield message;
        index = work.indexOf('\n\n');
      }
      buffer = trailingCr ? `${work}\r` : work;
    }
    const tail = parseBlock(buffer.replace(/\r\n?/g, '\n').trim());
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* 生成                                                                 */
/* ------------------------------------------------------------------ */

/** 每个聊天同时只允许一次生成；停止按钮与切换聊天都从这里取控制器 */
const controllers = new Map<string, AbortController>();

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** 当前分支上这个节点是第几楼（酒馆助手的 message_id） */
function floorOf(detail: ChatDetail | undefined, nodeId: string): number {
  if (!detail) return -1;
  return pathToHead(detail.nodes, detail.headNodeId).findIndex((node) => node.id === nodeId);
}

/** 把服务端推来的节点写入 ChatDetail 缓存，并把 head 移到它上面 */
function writeNode(
  queryClient: QueryClient,
  chatId: string,
  node: MessageNode,
  chat?: ChatSummary,
): void {
  queryClient.setQueryData<ChatDetail>(queryKeys.chat(chatId), (previous) =>
    previous ? { ...mergeNode(previous, node, chat), headNodeId: node.id } : previous,
  );
}

export interface GenerationController {
  generate: (body: GenerateBody) => void;
  stop: () => void;
  retry: () => void;
  isGenerating: boolean;
  error: (GenerationError & { retryable: boolean }) | null;
  /** 正在流式输出的助手节点 id */
  streamingNodeId: string | null;
  dismissError: () => void;
}

export function useGeneration(chatId: string | null): GenerationController {
  const queryClient = useQueryClient();
  const run = useChatStore((state) => (chatId ? state.runs[chatId] : undefined));

  const generate = useCallback(
    (body: GenerateBody) => {
      if (!chatId) return;
      const store = useChatStore.getState();
      controllers.get(chatId)?.abort();
      const controller = new AbortController();
      controllers.set(chatId, controller);
      store.startRun(chatId, body);
      // 前端卡靠这些事件跟上生成进度（酒馆助手的 generation_started 等）
      emitNative(NATIVE_EVENTS.GENERATION_STARTED, chatId);
      void runGeneration(queryClient, chatId, body, controller).finally(() => {
        if (controllers.get(chatId) === controller) controllers.delete(chatId);
      });
    },
    [chatId, queryClient],
  );

  const stop = useCallback(() => {
    if (!chatId) return;
    controllers.get(chatId)?.abort();
  }, [chatId]);

  const retry = useCallback(() => {
    const body = useChatStore.getState().runs[chatId ?? '']?.lastBody;
    if (body) generate(body);
  }, [chatId, generate]);

  const dismissError = useCallback(() => {
    if (chatId) useChatStore.getState().clearError(chatId);
  }, [chatId]);

  return {
    generate,
    stop,
    retry,
    dismissError,
    isGenerating: run?.status === 'pending' || run?.status === 'streaming',
    error: run?.error ?? null,
    streamingNodeId: run?.status === 'streaming' ? run.nodeId : null,
  };
}

async function runGeneration(
  queryClient: QueryClient,
  chatId: string,
  body: GenerateBody,
  controller: AbortController,
): Promise<void> {
  const store = useChatStore.getState();
  const createdNodeIds: string[] = [];
  let finished = false;

  try {
    const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      const payload = parseJson<{ error?: string; message?: string }>(await response.text());
      store.failRun(chatId, {
        kind: payload?.error ?? 'network',
        message: payload?.message ?? `HTTP ${response.status}`,
        status: response.status,
        retryable: response.status >= 500 || response.status === 429,
      });
      return;
    }

    for await (const message of parseSseStream(response.body)) {
      switch (message.event) {
        case 'node': {
          const payload = parseJson<{ node: MessageNode; chat: ChatSummary }>(message.data);
          if (!payload) break;
          createdNodeIds.push(payload.node.id);
          writeNode(queryClient, chatId, payload.node, payload.chat);
          // assistant 节点才是流式目标；user 节点只是写入历史
          if (payload.node.role === 'assistant') store.attachNode(chatId, payload.node.id);
          else {
            const detail = queryClient.getQueryData<ChatDetail>(queryKeys.chat(chatId));
            emitNative(NATIVE_EVENTS.MESSAGE_ADDED, floorOf(detail, payload.node.id), 'user');
          }
          break;
        }
        case 'text.delta':
        case 'reasoning.delta': {
          const payload = parseJson<{ nodeId: string; text: string }>(message.data);
          if (!payload?.text) break;
          store.appendDelta(
            payload.nodeId,
            message.event === 'text.delta' ? 'text' : 'reasoning',
            payload.text,
          );
          if (message.event === 'text.delta') {
            emitNative(NATIVE_EVENTS.STREAM_DELTA, payload.text, payload.nodeId);
          }
          break;
        }
        case 'image': {
          // 模型输出的图片已落盘为资产（M4 契约 §1.3）：先追加在正文之后，done 再按最终顺序
          const payload = parseJson<{ nodeId: string; part: ImagePart }>(message.data);
          if (!payload?.part?.assetId) break;
          store.appendImage(payload.nodeId, payload.part);
          break;
        }
        case 'usage': {
          const payload = parseJson<{ nodeId: string; usage: Usage }>(message.data);
          if (!payload) break;
          queryClient.setQueryData<ChatDetail>(queryKeys.chat(chatId), (previous) =>
            previous
              ? {
                  ...previous,
                  nodes: previous.nodes.map((node) =>
                    node.id === payload.nodeId ? { ...node, usage: payload.usage } : node,
                  ),
                }
              : previous,
          );
          break;
        }
        case 'variables': {
          // MVU：服务端算完的节点快照。写进缓存（前端卡的镜像据此刷新），
          // 再按 MVU 的事件名广播一遍，监听 `mag_variable_update_ended` 的卡就能收到。
          const payload = parseJson<MvuNodeResult>(message.data);
          if (!payload) break;
          if (payload.nodeId) {
            queryClient.setQueryData(cardQueryKeys.variables(chatId, payload.nodeId), {
              nodeId: payload.nodeId,
              message: payload.variables,
              chat: payload.variables,
              global: {},
              character: {},
            });
          }
          void queryClient.invalidateQueries({ queryKey: ['chats', chatId, 'variables'] });
          emitNative(NATIVE_EVENTS.VARIABLES_UPDATED, payload.variables, payload.nodeId);
          if ((payload.initialized ?? []).length > 0) {
            emitCompat('mag_variable_initiailized', payload.variables, 0);
          }
          if (payload.changed) {
            emitCompat('mag_variable_update_started', payload.variables);
            emitCompat('mag_variable_update_ended', payload.variables, payload.variables);
          }
          for (const error of payload.errors) {
            console.warn(`[MVU] ${error.command}：${error.message}`);
          }
          break;
        }
        case 'done': {
          const payload = parseJson<{ node: MessageNode; chat: ChatSummary }>(message.data);
          if (payload) {
            writeNode(queryClient, chatId, payload.node, payload.chat);
            const detail = queryClient.getQueryData<ChatDetail>(queryKeys.chat(chatId));
            emitNative(NATIVE_EVENTS.MESSAGE_ADDED, floorOf(detail, payload.node.id), 'normal');
          }
          finished = true;
          break;
        }
        case 'error': {
          const payload = parseJson<{
            nodeId?: string;
            error: GenerationError;
            retryable?: boolean;
          }>(message.data);
          store.failRun(chatId, {
            kind: payload?.error.kind ?? 'provider_error',
            message: payload?.error.message ?? '',
            ...(payload?.error.status === undefined ? {} : { status: payload.error.status }),
            retryable: payload?.retryable ?? true,
          });
          // 服务端在无文本时会删掉刚建的助手节点，重新拉一次详情最稳
          void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
          break;
        }
        default:
          break;
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      // 停止生成：服务端照常持久化已产出的文本，重新拉取以对齐
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    } else {
      store.failRun(chatId, {
        kind: 'network',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }
  } finally {
    emitNative(
      finished ? NATIVE_EVENTS.GENERATION_ENDED : NATIVE_EVENTS.GENERATION_STOPPED,
      chatId,
    );
    if (!finished && !useChatStore.getState().runs[chatId]?.error) {
      // 流意外中断（无 done 也无 error）：以服务端为准
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    }
    useChatStore.getState().endRun(chatId, createdNodeIds);
    void queryClient.invalidateQueries({ queryKey: queryKeys.chats, exact: true });
  }
}
