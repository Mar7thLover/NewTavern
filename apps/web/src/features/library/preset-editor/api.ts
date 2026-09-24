import { useMutation, useQueryClient } from '@tanstack/react-query';

import { mutate, queryKeys, type PresetDetail } from '../../../lib/api';
import {
  presetDraftChanges,
  presetDraftToLayoutPolicyBody,
  presetDraftToUpdate,
  type PresetDraft,
  type PresetLayoutPolicy,
} from './model';

const enc = encodeURIComponent;

/**
 * 保存布局策略（M6 §4.2 布局策略与保真锁）——前端唯一写 `layoutPolicy` 的地方。
 * 单独一个请求：`PUT /api/presets/:id/layout-policy` body `{ layoutPolicy, author? }`
 * （null = 清空、跟随默认），返回预设详情；服务端同样写一版版本历史。
 */
export function savePresetLayoutPolicy(
  id: string,
  layoutPolicy: PresetLayoutPolicy | null,
  author?: 'user' | 'ai',
): Promise<PresetDetail> {
  return mutate<PresetDetail>(`/api/presets/${enc(id)}/layout-policy`, 'PUT', {
    layoutPolicy,
    ...(author ? { author } : {}),
  });
}

/**
 * 按草稿相对基线的改动保存：data / 名称改了走 `PUT /api/presets/:id`，布局策略改了再单独保存。
 * 返回最后一次请求的预设详情（两块都没改时返回 undefined）。
 */
export async function savePresetDraft(
  id: string,
  draft: PresetDraft,
  baseline: PresetDraft,
  options: { author?: 'user' | 'ai' } = {},
): Promise<PresetDetail | undefined> {
  const changes = presetDraftChanges(baseline, draft);
  let row: PresetDetail | undefined;
  if (changes.data) {
    row = await mutate<PresetDetail>(`/api/presets/${enc(id)}`, 'PUT', {
      ...presetDraftToUpdate(draft),
      ...(options.author ? { author: options.author } : {}),
    });
  }
  if (changes.layoutPolicy) {
    row = await savePresetLayoutPolicy(
      id,
      presetDraftToLayoutPolicyBody(draft).layoutPolicy,
      options.author,
    );
  }
  return row;
}

/** `savePresetDraft` 的 mutation 版：成功后刷新预设缓存与各会话检查器 */
export function useSavePresetDraft(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { draft: PresetDraft; baseline: PresetDraft; author?: 'user' | 'ai' }) =>
      savePresetDraft(id, input.draft, input.baseline, { author: input.author }),
    onSuccess: (row) => {
      if (row) queryClient.setQueryData(queryKeys.preset(id), row);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.presets, exact: true }),
        // 检查器结果依赖预设：各会话的 inspect 缓存一并失效（只有打开着的面板会立即重取）
        queryClient.invalidateQueries({
          predicate: (query) => query.queryKey[0] === 'chats' && query.queryKey[2] === 'inspect',
        }),
      ]);
    },
  });
}
