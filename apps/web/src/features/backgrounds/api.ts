import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

import {
  fetchJson,
  mutate,
  uploadFile,
  useSetSetting,
  useSetting,
  type ChatSummary,
} from '../../lib/api';

/**
 * 背景库（M4（二）契约 §A）。与 `lib/api.ts` 分开放，避免多个代理同时改同一个文件。
 * 生效顺序：会话 `metadata.background` > 角色 settings `backgroundByCharacter` > 全局 `defaultBackground`。
 */

export interface BackgroundItem {
  assetId: string;
  name: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

/** 会话 metadata.background 的「本会话明确不要背景」 */
export const BACKGROUND_NONE = 'none';

export const DEFAULT_BACKGROUND_KEY = 'defaultBackground';
export const BACKGROUND_BY_CHARACTER_KEY = 'backgroundByCharacter';

const backgroundsKey = ['backgrounds'] as const;
const enc = encodeURIComponent;

/** 背景图的地址：走资产文件接口 */
export function backgroundUrl(assetId: string): string {
  return `/api/assets/${enc(assetId)}/file`;
}

export function useBackgrounds() {
  return useQuery({
    queryKey: backgroundsKey,
    queryFn: () => fetchJson<BackgroundItem[]>('/api/backgrounds'),
    staleTime: 60_000,
  });
}

export function useUploadBackground() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => uploadFile<BackgroundItem>('/api/backgrounds', file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: backgroundsKey }),
  });
}

export function useRenameBackground() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ assetId, name }: { assetId: string; name: string }) =>
      mutate<BackgroundItem>(`/api/backgrounds/${enc(assetId)}`, 'PATCH', { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: backgroundsKey }),
  });
}

export function useDeleteBackground() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (assetId: string) => mutate(`/api/backgrounds/${enc(assetId)}`, 'DELETE'),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: backgroundsKey }),
        // 服务端顺手清了 settings 里的引用
        queryClient.invalidateQueries({ queryKey: ['settings', DEFAULT_BACKGROUND_KEY] }),
        queryClient.invalidateQueries({ queryKey: ['settings', BACKGROUND_BY_CHARACTER_KEY] }),
      ]),
  });
}

const normalizeId = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : null;

function normalizeByCharacter(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '',
    ),
  );
}

export const useDefaultBackground = () => useSetting(DEFAULT_BACKGROUND_KEY, normalizeId);

/** 全局默认背景；null = 删掉这一项（settings 的值不许为 NULL） */
export function useSetDefaultBackground() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (assetId: string | null) => {
      const url = `/api/settings/${enc(DEFAULT_BACKGROUND_KEY)}`;
      if (assetId === null) await mutate(url, 'DELETE');
      else await mutate(url, 'PUT', assetId);
      return assetId;
    },
    onSuccess: (assetId) =>
      queryClient.setQueryData(['settings', DEFAULT_BACKGROUND_KEY], assetId),
  });
}
export const useBackgroundByCharacter = () =>
  useSetting(BACKGROUND_BY_CHARACTER_KEY, normalizeByCharacter);
export const useSetBackgroundByCharacter = () =>
  useSetSetting(BACKGROUND_BY_CHARACTER_KEY, normalizeByCharacter);

export type BackgroundSource = 'chat' | 'character' | 'global' | 'none';

export interface ResolvedBackground {
  assetId: string | null;
  /** 生效的是哪一层；`none` = 会话明确不要，或三层都没有 */
  source: BackgroundSource;
}

/**
 * 算出会话实际生效的背景。悬空引用（背景已被删）当作缺省，往下一层找。
 * `library` 未加载完（undefined）时不做悬空判断。
 */
export function resolveBackground(
  chat: Pick<ChatSummary, 'metadata' | 'characterIds'> | null,
  byCharacter: Record<string, string> | undefined,
  globalId: string | null | undefined,
  library: readonly BackgroundItem[] | undefined,
): ResolvedBackground {
  const exists = (id: string | null | undefined): id is string =>
    typeof id === 'string' && id !== '' && (!library || library.some((item) => item.assetId === id));
  const own = chat?.metadata?.['background'];
  if (own === BACKGROUND_NONE) return { assetId: null, source: 'none' };
  if (typeof own === 'string' && exists(own)) return { assetId: own, source: 'chat' };
  const characterId = chat?.characterIds[0];
  const forCharacter = characterId ? byCharacter?.[characterId] : undefined;
  if (exists(forCharacter)) return { assetId: forCharacter, source: 'character' };
  if (exists(globalId)) return { assetId: globalId, source: 'global' };
  return { assetId: null, source: 'none' };
}

/**
 * 当前应当垫在应用底下的背景（对话页打开一个会话时由 ChatView 写入，离开时清空）。
 * 应用外壳读它交给 `BackdropLayer`。不持久化。
 */
interface BackdropState {
  assetId: string | null;
  setAssetId: (assetId: string | null) => void;
  /** 命令面板「切换背景」：递增后会话面板的背景小节展开并滚到眼前 */
  focusNonce: number;
  requestFocus: () => void;
  /** 背景小节处理完请求后清零（之后再挂载不会自己展开） */
  clearFocus: () => void;
}

export const useBackdropStore = create<BackdropState>()((set) => ({
  assetId: null,
  setAssetId: (assetId) => set({ assetId }),
  focusNonce: 0,
  requestFocus: () => set((state) => ({ focusNonce: state.focusNonce + 1 })),
  clearFocus: () => set({ focusNonce: 0 }),
}));
