import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { ImagineError, runImagine, type ImagineBody } from './api';
import { mergeNode, queryKeys, type ChatDetail } from '../../lib/api';

/**
 * 每个会话同时只跑一次生图：进行中的状态（阶段、进度、提示词、错误）放在这里，
 * Composer 的进度条、生图菜单与 ChatView 的「重画」共用。
 * 不放 zustand：状态只在本模块内被写，外部只读 + 取消。
 */

export type ImaginePhase = 'writing' | 'drawing' | 'error';

export interface ImagineState {
  phase: ImaginePhase;
  /** 0–1；writing 阶段为 null */
  fraction: number | null;
  prompt: string | null;
  error: { message: string; kind: string } | null;
  /** 触发它的请求体（错误时「重试」用） */
  body: ImagineBody;
}

const states = new Map<string, ImagineState>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function set(chatId: string, next: ImagineState | null) {
  if (next) states.set(chatId, next);
  else states.delete(chatId);
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getImagineState(chatId: string): ImagineState | null {
  return states.get(chatId) ?? null;
}

export function useImagineState(chatId: string | undefined): ImagineState | null {
  return useSyncExternalStore(
    subscribe,
    () => (chatId ? getImagineState(chatId) : null),
    () => null,
  );
}

export function isImagining(chatId: string): boolean {
  return controllers.has(chatId);
}

/** 取消进行中的生图（abort SSE；服务端随之中止后端请求） */
export function cancelImagine(chatId: string): void {
  controllers.get(chatId)?.abort();
}

export function dismissImagineError(chatId: string): void {
  if (states.get(chatId)?.phase === 'error') set(chatId, null);
}

/**
 * 发起一次生图：结果节点写进 ChatDetail 缓存并把 head 移过去。
 * 已有进行中的生图时忽略（返回 false）。
 */
export function startImagine(queryClient: QueryClient, chatId: string, body: ImagineBody): boolean {
  if (controllers.has(chatId)) return false;
  const controller = new AbortController();
  controllers.set(chatId, controller);
  const needsWriter = !body.redrawOf && body.mode !== undefined && body.mode !== 'free';
  set(chatId, {
    phase: needsWriter ? 'writing' : 'drawing',
    fraction: needsWriter ? null : 0,
    prompt: body.prompt ?? null,
    error: null,
    body,
  });
  const patch = (partial: Partial<ImagineState>) => {
    const current = states.get(chatId);
    if (current && controllers.get(chatId) === controller) set(chatId, { ...current, ...partial });
  };

  void runImagine(
    chatId,
    body,
    {
      onPrompt: (text) => patch({ prompt: text, phase: 'drawing', fraction: 0 }),
      onProgress: (fraction) => patch({ phase: 'drawing', fraction }),
      onNode: (node, chat) => {
        queryClient.setQueryData<ChatDetail>(queryKeys.chat(chatId), (previous) =>
          previous ? { ...mergeNode(previous, node, chat), headNodeId: node.id } : previous,
        );
      },
    },
    controller.signal,
  )
    .then(() => {
      controllers.delete(chatId);
      set(chatId, null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats, exact: true });
    })
    .catch((error: unknown) => {
      controllers.delete(chatId);
      const kind = error instanceof ImagineError ? error.kind : 'invalid';
      if (kind === 'abort') {
        set(chatId, null);
        return;
      }
      const current = states.get(chatId);
      set(chatId, {
        phase: 'error',
        fraction: null,
        prompt: current?.prompt ?? null,
        error: { message: (error as Error).message, kind },
        body,
      });
    });
  return true;
}
