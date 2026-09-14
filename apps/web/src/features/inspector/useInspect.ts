import { useMutation, useQuery } from '@tanstack/react-query';

import type { CompareResult, InspectResponse } from './types';
import { fetchJson, mutate, queryKeys, type LayoutMode } from '../../lib/api';

export interface InspectParams {
  chatId: string;
  /** 从哪个节点往回组装；null = 会话 head（不传参数） */
  parentId: string | null;
  layoutMode: LayoutMode;
  connectionId: string | null;
  model: string | null;
  /** 面板打开且不在生成中才取数 */
  enabled: boolean;
}

function inspectUrl({ chatId, parentId, layoutMode, connectionId, model }: InspectParams): string {
  const query = new URLSearchParams({ layoutMode });
  if (parentId !== null) query.set('parentId', parentId);
  if (connectionId) query.set('connectionId', connectionId);
  if (model) query.set('model', model);
  return `/api/chats/${encodeURIComponent(chatId)}/inspect?${query.toString()}`;
}

/**
 * 检查器数据（契约 §6）。刷新时机：面板打开（挂载即取）、head 变化、布局切换；
 * 生成中 `enabled=false`，不刷新。
 */
export function useInspect(params: InspectParams) {
  return useQuery({
    queryKey: queryKeys.chatInspect(params.chatId, {
      parentId: params.parentId,
      layoutMode: params.layoutMode,
      connectionId: params.connectionId,
      model: params.model,
    }),
    queryFn: () => fetchJson<InspectResponse>(inspectUrl(params)),
    enabled: params.enabled,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export interface CompareInput {
  chatId: string;
  parentId: string | null;
  connectionId: string | null;
  model: string | null;
  stRequest: unknown;
}

/** 与粘贴的 ST 请求体比对（契约 §6 `POST /api/inspect/compare`） */
export function useCompareStRequest() {
  return useMutation({
    mutationFn: (input: CompareInput) =>
      mutate<CompareResult>('/api/inspect/compare', 'POST', {
        chatId: input.chatId,
        ...(input.parentId !== null ? { parentId: input.parentId } : {}),
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        ...(input.model ? { model: input.model } : {}),
        stRequest: input.stRequest,
      }),
  });
}
