import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  fetchJson,
  mutate,
  queryKeys,
  useSetSetting,
  useSetting,
  type ChatDetail,
} from '../../lib/api';

/**
 * 立绘表情（M4（二）契约 §B）。与 `lib/api.ts` 分开放，避免多个代理同时改同一个文件。
 */

export interface SpriteItem {
  label: string;
  assetId: string;
}

export interface SpriteImportResult {
  imported: string[];
  skipped: { file: string; reason: string }[];
  sprites: SpriteItem[];
}

/** ST 表情扩展的 28 个默认标签（与服务端 `DEFAULT_EXPRESSIONS` 一致） */
export const DEFAULT_EXPRESSIONS = [
  'admiration',
  'amusement',
  'anger',
  'annoyance',
  'approval',
  'caring',
  'confusion',
  'curiosity',
  'desire',
  'disappointment',
  'disapproval',
  'disgust',
  'embarrassment',
  'excitement',
  'fear',
  'gratitude',
  'grief',
  'joy',
  'love',
  'nervousness',
  'neutral',
  'optimism',
  'pride',
  'realization',
  'relief',
  'remorse',
  'sadness',
  'surprise',
] as const;

/** 与服务端 `normalizeSpriteLabel` 同规则：ASCII 转小写须是 `[a-z0-9_-]{1,32}`；含中文的 ≤ 32 字 */
export function normalizeSpriteLabel(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (/^[a-z0-9_-]{1,32}$/.test(lower)) return lower;
  if (
    /\p{Script=Han}/u.test(trimmed) &&
    Array.from(trimmed).length <= 32 &&
    !/[\p{Cc}\\/"'<>`]/u.test(trimmed)
  ) {
    return trimmed;
  }
  return null;
}

const enc = encodeURIComponent;
const spritesKey = (characterId: string) => ['characters', characterId, 'sprites'] as const;

export function spriteUrl(assetId: string): string {
  return `/api/assets/${enc(assetId)}/file`;
}

export function useSprites(characterId: string | null) {
  return useQuery({
    queryKey: spritesKey(characterId ?? ''),
    queryFn: () => fetchJson<SpriteItem[]>(`/api/characters/${enc(characterId ?? '')}/sprites`),
    enabled: characterId !== null,
    staleTime: 60_000,
  });
}

function uploadTo<T>(url: string, method: 'PUT' | 'POST', file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return mutate<T>(url, method, form);
}

export function useUploadSprite(characterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ label, file }: { label: string; file: File }) =>
      uploadTo<SpriteItem>(
        `/api/characters/${enc(characterId)}/sprites/${enc(label)}`,
        'PUT',
        file,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spritesKey(characterId) }),
  });
}

export function useDeleteSprite(characterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string) =>
      mutate(`/api/characters/${enc(characterId)}/sprites/${enc(label)}`, 'DELETE'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: spritesKey(characterId) }),
  });
}

export function useImportSpriteZip(characterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (file: File) =>
      uploadTo<SpriteImportResult>(
        `/api/characters/${enc(characterId)}/sprites/import`,
        'POST',
        file,
      ),
    onSuccess: (result) => queryClient.setQueryData(spritesKey(characterId), result.sprites),
  });
}

/* ------------------------------------------------------------------ */
/* 表情选择设置（settings KV `sprites`）                                 */
/* ------------------------------------------------------------------ */

export type SpriteMode = 'off' | 'classify' | 'manual';

export interface SpriteSettings {
  mode: SpriteMode;
  connectionId?: string;
  model?: string;
  fallback: string;
}

export const SPRITES_SETTINGS_KEY = 'sprites';

export function normalizeSpriteSettings(value: unknown): SpriteSettings {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const mode = record['mode'];
  const fallback =
    typeof record['fallback'] === 'string' ? normalizeSpriteLabel(record['fallback']) : null;
  return {
    mode: mode === 'off' || mode === 'manual' || mode === 'classify' ? mode : 'classify',
    ...(typeof record['connectionId'] === 'string' && record['connectionId']
      ? { connectionId: record['connectionId'] }
      : {}),
    ...(typeof record['model'] === 'string' && record['model'] ? { model: record['model'] } : {}),
    fallback: fallback ?? 'neutral',
  };
}

export const useSpriteSettings = () => useSetting(SPRITES_SETTINGS_KEY, normalizeSpriteSettings);
export const useSetSpriteSettings = () =>
  useSetSetting(SPRITES_SETTINGS_KEY, normalizeSpriteSettings);

/* ------------------------------------------------------------------ */
/* 表情选择                                                             */
/* ------------------------------------------------------------------ */

export interface ExpressionResult {
  label: string;
  source: 'manual' | 'classify' | 'fallback';
}

/** 手动（带 label）或分类（不带）；结果写回聊天缓存里那个节点的 `extra.expression` */
export function useChooseExpression(chatId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, label }: { nodeId: string; label?: string }) =>
      mutate<ExpressionResult>(
        `/api/chats/${enc(chatId)}/nodes/${enc(nodeId)}/expression`,
        'POST',
        label === undefined ? {} : { label },
      ),
    onSuccess: (result, { nodeId }) => {
      queryClient.setQueryData<ChatDetail>(queryKeys.chat(chatId), (previous) =>
        previous
          ? {
              ...previous,
              nodes: previous.nodes.map((node) =>
                node.id === nodeId
                  ? { ...node, extra: { ...(node.extra ?? {}), expression: result.label } }
                  : node,
              ),
            }
          : previous,
      );
    },
  });
}

/** 节点上已有的表情标签 */
export function nodeExpression(extra: Record<string, unknown> | null | undefined): string | null {
  const value = extra?.['expression'];
  return typeof value === 'string' && value ? value : null;
}

/** 标签 → 该角色的立绘：精确 → fallback → neutral → 第一张 */
export function pickSprite(
  sprites: readonly SpriteItem[],
  label: string | null,
  fallback: string,
): SpriteItem | null {
  return (
    (label ? sprites.find((sprite) => sprite.label === label) : undefined) ??
    sprites.find((sprite) => sprite.label === fallback) ??
    sprites.find((sprite) => sprite.label === 'neutral') ??
    sprites[0] ??
    null
  );
}
