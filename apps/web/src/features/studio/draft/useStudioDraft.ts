import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { fetchJson, queryKeys } from '../../../lib/api';
import { studioKeys, type StudioDraftBody, type StudioKind } from '../../../lib/api-studio';
import type { StudioPair, StudioPatchOp } from '../types';
import {
  assembleDraftOf,
  assistDraftOf,
  detailToPair,
  pairDirty,
  pairValid,
  savePair,
  type StudioDetail,
} from './adapters';
import { studioDraftReducer, type StudioDraftState } from './state';

const DETAIL_URL: Record<StudioKind, string> = {
  character: '/api/characters',
  preset: '/api/presets',
  lorebook: '/api/lorebooks',
};

/** 工作台实体详情（与库页面的详情查询共用缓存键） */
export function fetchStudioDetail(kind: StudioKind, id: string): Promise<StudioDetail> {
  return fetchJson<StudioDetail>(`${DETAIL_URL[kind]}/${encodeURIComponent(id)}`);
}

export function detailQueryKey(kind: StudioKind, id: string) {
  return kind === 'character'
    ? queryKeys.character(id)
    : kind === 'preset'
      ? queryKeys.preset(id)
      : queryKeys.lorebook(id);
}

export interface StudioDraftApi {
  kind: StudioKind;
  id: string;
  /** 服务端当前行（头像、内嵌书 id 等不在草稿里的信息从这里读） */
  detail: StudioDetail | undefined;
  isPending: boolean;
  error: unknown;
  refetch: () => void;
  /** 载入完成后才有 */
  state: StudioDraftState | null;
  dirty: boolean;
  valid: boolean;
  /** 编辑器改动（草稿与当前 kind 一致） */
  setDraft: (draft: StudioPair['draft']) => void;
  applyOps: (ops: readonly StudioPatchOp[]) => void;
  revert: () => void;
  save: () => Promise<boolean>;
  saving: boolean;
  saveError: unknown;
  saved: boolean;
  /** 只更新服务端行（头像这类不进草稿的改动），草稿不动 */
  updateDetail: (detail: StudioDetail) => void;
  /** 用服务端新行重建基线与草稿（恢复版本后） */
  adopt: (detail: StudioDetail) => void;
  /** 重新取详情并重建（恢复版本后） */
  reload: () => Promise<void>;
  /** 最新草稿的读取器（引用稳定；测试对话 / 检查器在发请求时现取） */
  assembleDraft: () => StudioDraftBody | undefined;
  assistDraft: () => Record<string, unknown> | undefined;
}

/**
 * 工作台统一持有的草稿（M6 §4.2）：baseline / draft / dirty / save / revert。
 * 测试对话与检查器读同一份 draft；AI 协作者接受的改动经 `applyOps` 合进来。
 * 首次载入后不再被后台刷新覆盖（换实体时由调用方按 key 重建组件）。
 */
export function useStudioDraft(kind: StudioKind, id: string): StudioDraftApi {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: detailQueryKey(kind, id),
    queryFn: () => fetchStudioDetail(kind, id),
    refetchOnWindowFocus: false,
  });
  const [state, dispatch] = useReducer(studioDraftReducer, null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // 首次拿到详情：建草稿
  const loaded = state !== null;
  useEffect(() => {
    if (!loaded && query.data) dispatch({ type: 'adopt', pair: detailToPair(kind, query.data) });
  }, [loaded, query.data, kind]);

  const dirty = useMemo(() => (state ? pairDirty(state.pair) : false), [state]);
  const valid = useMemo(() => (state ? pairValid(state.pair) : false), [state]);

  const setDraft = useCallback((draft: StudioPair['draft']) => {
    setSaved(false);
    dispatch({ type: 'edit', draft });
  }, []);
  const applyOps = useCallback((ops: readonly StudioPatchOp[]) => {
    setSaved(false);
    dispatch({ type: 'applyOps', ops });
  }, []);
  const revert = useCallback(() => {
    setSaved(false);
    setSaveError(null);
    dispatch({ type: 'revert' });
  }, []);

  const adopt = useCallback(
    (detail: StudioDetail) => {
      queryClient.setQueryData(detailQueryKey(kind, id), detail);
      dispatch({ type: 'adopt', pair: detailToPair(kind, detail) });
    },
    [queryClient, kind, id],
  );

  const updateDetail = useCallback(
    (detail: StudioDetail) => {
      queryClient.setQueryData(detailQueryKey(kind, id), detail);
      void queryClient.invalidateQueries({
        queryKey: kind === 'character' ? queryKeys.characters : queryKeys.presets,
        exact: true,
      });
    },
    [queryClient, kind, id],
  );

  const reload = useCallback(async () => {
    const detail = await fetchJson<StudioDetail>(`${DETAIL_URL[kind]}/${encodeURIComponent(id)}`);
    adopt(detail);
  }, [adopt, kind, id]);

  const invalidateAfterSave = useCallback(() => {
    const listKey =
      kind === 'character'
        ? queryKeys.characters
        : kind === 'preset'
          ? queryKeys.presets
          : queryKeys.lorebooks;
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: listKey, exact: true }),
      queryClient.invalidateQueries({ queryKey: studioKeys.versions(kind, id) }),
      queryClient.invalidateQueries({ queryKey: ['versions', 'recent'] }),
      // 检查器依赖这份数据：各会话的 inspect 缓存一并失效
      queryClient.invalidateQueries({
        predicate: (q) => q.queryKey[0] === 'chats' && q.queryKey[2] === 'inspect',
      }),
      // 角色卡改名 / 换内嵌书会影响会话列表与测试会话的显示
      kind === 'character'
        ? queryClient.invalidateQueries({ queryKey: queryKeys.lorebooks, exact: true })
        : Promise.resolve(),
    ]);
  }, [queryClient, kind, id]);

  const save = useCallback(async (): Promise<boolean> => {
    const current = stateRef.current;
    if (!current || !pairDirty(current.pair) || !pairValid(current.pair)) return false;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const submitted = current.pair.draft;
      const result = await savePair(current.pair, id, current.aiTouched ? 'ai' : 'user');
      if (result.detail) queryClient.setQueryData(detailQueryKey(kind, id), result.detail);
      dispatch({ type: 'saved', baseline: result.baseline, submitted });
      setSaved(true);
      void invalidateAfterSave();
      return true;
    } catch (error) {
      setSaveError(error);
      return false;
    } finally {
      setSaving(false);
    }
  }, [id, kind, queryClient, invalidateAfterSave]);

  const assembleDraft = useCallback((): StudioDraftBody | undefined => {
    const current = stateRef.current;
    return current ? assembleDraftOf(current.pair, id) : undefined;
  }, [id]);

  const assistDraft = useCallback((): Record<string, unknown> | undefined => {
    const current = stateRef.current;
    return current ? assistDraftOf(current.pair) : undefined;
  }, []);

  return {
    kind,
    id,
    detail: query.data,
    isPending: query.isPending,
    error: query.error,
    refetch: () => void query.refetch(),
    state,
    dirty,
    valid,
    setDraft,
    applyOps,
    revert,
    save,
    saving,
    saveError,
    saved,
    updateDetail,
    adopt,
    reload,
    assembleDraft,
    assistDraft,
  };
}
