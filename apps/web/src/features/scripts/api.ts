import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { fetchJson, mutate } from '../../lib/api';

/**
 * 酒馆助手脚本库的前端接口。见 docs/M5-CONTRACT.md 第二部分 §2.1，
 * 形状与服务端 `apps/server/src/services/scripts.ts` 的 `ScriptRow` 一致。
 */

export type ScriptScope = 'global' | 'preset';

export interface ScriptButton {
  name: string;
  visible: boolean;
}

export interface ScriptRow {
  id: string;
  scope: ScriptScope;
  ownerId: string | null;
  name: string;
  content: string;
  enabled: boolean;
  buttons: ScriptButton[];
  /** 酒馆助手 `button.enabled`：false 时按钮整体不显示 */
  buttonsEnabled: boolean;
  /** 作者说明（`data.info`） */
  info: string;
  /** 导入时所在的文件夹 */
  folder: string | null;
  data: Record<string, unknown>;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScriptInput {
  name?: string;
  content?: string;
  enabled?: boolean;
  buttons?: ScriptButton[];
  buttonsEnabled?: boolean;
  info?: string;
}

export const scriptQueryKeys = {
  all: ['scripts'] as const,
  list: (scope: ScriptScope, ownerId: string | null) => ['scripts', scope, ownerId ?? ''] as const,
};

export const SCRIPTS_IMPORT_URL = '/api/scripts/import';

export function scriptExportUrl(id: string): string {
  return `/api/scripts/${encodeURIComponent(id)}/export`;
}

function listUrl(scope: ScriptScope, ownerId: string | null): string {
  const query = new URLSearchParams({ scope });
  if (ownerId) query.set('ownerId', ownerId);
  return `/api/scripts?${query.toString()}`;
}

export function fetchScripts(scope: ScriptScope, ownerId: string | null): Promise<ScriptRow[]> {
  return fetchJson<ScriptRow[]>(listUrl(scope, ownerId));
}

/** 某一组脚本；`scope='preset'` 且没有 ownerId 时不请求（避免把所有预设的脚本混在一起） */
export function useScripts(scope: ScriptScope, ownerId: string | null) {
  return useQuery({
    queryKey: scriptQueryKeys.list(scope, ownerId),
    queryFn: () => fetchScripts(scope, ownerId),
    enabled: scope === 'global' || ownerId !== null,
  });
}

function useInvalidateScripts() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: scriptQueryKeys.all });
}

export function useCreateScript() {
  const invalidate = useInvalidateScripts();
  return useMutation({
    mutationFn: (
      input: ScriptInput & { scope: ScriptScope; ownerId?: string | null; name: string },
    ) => mutate<ScriptRow>('/api/scripts', 'POST', input),
    onSuccess: () => invalidate(),
  });
}

export function useUpdateScript() {
  const invalidate = useInvalidateScripts();
  return useMutation({
    mutationFn: ({ id, ...patch }: ScriptInput & { id: string }) =>
      mutate<ScriptRow>(`/api/scripts/${encodeURIComponent(id)}`, 'PUT', patch),
    onSuccess: () => invalidate(),
  });
}

export function useDeleteScript() {
  const invalidate = useInvalidateScripts();
  return useMutation({
    mutationFn: (id: string) => mutate(`/api/scripts/${encodeURIComponent(id)}`, 'DELETE'),
    onSuccess: () => invalidate(),
  });
}

export function useReorderScripts() {
  const invalidate = useInvalidateScripts();
  return useMutation({
    mutationFn: (ids: string[]) => mutate('/api/scripts/order', 'PUT', { ids }),
    onSuccess: () => invalidate(),
  });
}

/** 一键开关某个预设自带的全部脚本（启用时按原件里的开关恢复） */
export function useSetScriptOwnerEnabled() {
  const invalidate = useInvalidateScripts();
  return useMutation({
    mutationFn: (input: { scope: 'preset'; ownerId: string; enabled: boolean }) =>
      mutate<{ changed: number; scripts: ScriptRow[] }>(
        '/api/scripts/owner-enabled',
        'POST',
        input,
      ),
    onSuccess: () => invalidate(),
  });
}

/** 把 `items` 里第 `from` 个挪到 `to`（拖拽与上下移共用），返回新数组 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (from < 0 || from >= next.length) return next;
  const clamped = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(clamped, 0, item);
  return next;
}

/** 编辑器里按钮列表的规整：去掉首尾空白，丢掉空名字，按名字去重（酒馆助手按名字触发按钮事件） */
export function cleanButtons(buttons: readonly ScriptButton[]): ScriptButton[] {
  const seen = new Set<string>();
  const out: ScriptButton[] = [];
  for (const button of buttons) {
    const name = button.name.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, visible: button.visible });
  }
  return out;
}
