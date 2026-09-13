import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/* ------------------------------------------------------------------ */
/* 通用请求助手                                                         */
/* ------------------------------------------------------------------ */

/** 服务端错误响应统一为 `{ error, message? }` */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function toApiError(res: Response, url: string): Promise<ApiError> {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string' && body.message) message = body.message;
  } catch {
    // 非 JSON 错误体（如代理 502），退回状态码描述
  }
  return new ApiError(message ?? code ?? `${url} -> ${res.status}`, res.status, code);
}

async function readBody<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw await toApiError(res, url);
  return readBody<T>(res);
}

export type MutateMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** 写操作：普通对象按 JSON 发送，FormData 原样发送（multipart） */
export function mutate<T = void>(url: string, method: MutateMethod, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  return fetchJson<T>(url, init);
}

/** multipart 上传单个文件（字段名 `file`） */
export function uploadFile<T = unknown>(url: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  return mutate<T>(url, 'POST', form);
}

export function assetUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}/file`;
}

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

export interface HealthResponse {
  ok: boolean;
  name: string;
  time: string;
}

export type CharacterSpec = 'v2' | 'v3';

export interface CharacterSummary {
  id: string;
  name: string;
  spec: CharacterSpec;
  tags: string[];
  avatarAssetId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** CCv3 data 对象；未知字段原样保留，故仅声明 UI 用到的字段 */
export interface CharacterCardData {
  name?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  creator_notes_multilingual?: Record<string, string>;
  alternate_greetings?: string[];
  tags?: string[];
  character_book?: unknown;
  [key: string]: unknown;
}

export interface CharacterDetail extends CharacterSummary {
  data: CharacterCardData;
  bookId: string | null;
  sourcePath: string | null;
  originalHash: string | null;
}

export type CharacterExportFormat = 'png' | 'charx' | 'json';

export type PresetFormat = 'st-openai' | 'native';

export interface PresetSummary {
  id: string;
  name: string;
  format: PresetFormat;
  apiFamily: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PresetDetail extends PresetSummary {
  data: Record<string, unknown>;
  sampling: Record<string, unknown> | null;
  layoutPolicy: Record<string, unknown> | null;
}

export type LorebookScope = 'global' | 'char' | 'chat';

export interface LorebookSummary {
  id: string;
  name: string;
  scope: LorebookScope;
  settings: Record<string, unknown> | null;
  entryCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LorebookEntry {
  id: string;
  uid: number | null;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  comment: string | null;
  constant: boolean;
  selective: boolean;
  position: number;
  depth: number | null;
  entryOrder: number;
  probability: number | null;
  group: string | null;
  disabled: boolean;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  [key: string]: unknown;
}

export interface LorebookDetail extends Omit<LorebookSummary, 'entryCount'> {
  entries: LorebookEntry[];
}

export interface Persona {
  id: string;
  name: string;
  description: string;
  avatarAssetId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaInput {
  name: string;
  description?: string;
}

/* ------------------------------------------------------------------ */
/* Query keys 与 URL                                                    */
/* ------------------------------------------------------------------ */

export const queryKeys = {
  health: ['server-health'] as const,
  characters: ['characters'] as const,
  character: (id: string) => ['characters', id] as const,
  presets: ['presets'] as const,
  preset: (id: string) => ['presets', id] as const,
  lorebooks: ['lorebooks'] as const,
  lorebook: (id: string) => ['lorebooks', id] as const,
  personas: ['personas'] as const,
};

export const apiUrls = {
  importCharacter: '/api/import/character',
  importPreset: '/api/import/preset',
  importLorebook: '/api/import/lorebook',
  exportCharacter: (id: string, format: CharacterExportFormat) =>
    `/api/characters/${encodeURIComponent(id)}/export?format=${format}`,
  exportPreset: (id: string) => `/api/presets/${encodeURIComponent(id)}/export`,
  exportLorebook: (id: string) => `/api/lorebooks/${encodeURIComponent(id)}/export`,
};

const enc = encodeURIComponent;

/* ------------------------------------------------------------------ */
/* Hooks                                                                */
/* ------------------------------------------------------------------ */

export function useServerHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => fetchJson<HealthResponse>('/api/health'),
    refetchInterval: 15_000,
    retry: false,
  });
}

/** 删除资源：成功后刷新列表并丢弃详情缓存 */
function useDeleteResource(base: string, listKey: readonly string[]) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mutate(`${base}/${enc(id)}`, 'DELETE'),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: [...listKey, id] });
      return queryClient.invalidateQueries({ queryKey: listKey, exact: true });
    },
  });
}

export function useCharacters() {
  return useQuery({
    queryKey: queryKeys.characters,
    queryFn: () => fetchJson<CharacterSummary[]>('/api/characters'),
  });
}

export function useCharacter(id: string | null) {
  return useQuery({
    queryKey: queryKeys.character(id ?? ''),
    queryFn: () => fetchJson<CharacterDetail>(`/api/characters/${enc(id ?? '')}`),
    enabled: id !== null,
  });
}

export function useDeleteCharacter() {
  return useDeleteResource('/api/characters', queryKeys.characters);
}

export function usePresets() {
  return useQuery({
    queryKey: queryKeys.presets,
    queryFn: () => fetchJson<PresetSummary[]>('/api/presets'),
  });
}

export function usePreset(id: string | null) {
  return useQuery({
    queryKey: queryKeys.preset(id ?? ''),
    queryFn: () => fetchJson<PresetDetail>(`/api/presets/${enc(id ?? '')}`),
    enabled: id !== null,
  });
}

export function useDeletePreset() {
  return useDeleteResource('/api/presets', queryKeys.presets);
}

export function useLorebooks() {
  return useQuery({
    queryKey: queryKeys.lorebooks,
    queryFn: () => fetchJson<LorebookSummary[]>('/api/lorebooks'),
  });
}

export function useLorebook(id: string | null) {
  return useQuery({
    queryKey: queryKeys.lorebook(id ?? ''),
    queryFn: () => fetchJson<LorebookDetail>(`/api/lorebooks/${enc(id ?? '')}`),
    enabled: id !== null,
  });
}

export function useDeleteLorebook() {
  return useDeleteResource('/api/lorebooks', queryKeys.lorebooks);
}

export function usePersonas() {
  return useQuery({
    queryKey: queryKeys.personas,
    queryFn: () => fetchJson<Persona[]>('/api/personas'),
  });
}

export function useCreatePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PersonaInput) => mutate<Persona>('/api/personas', 'POST', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.personas }),
  });
}

export function useUpdatePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<PersonaInput> & { id: string }) =>
      mutate<Persona>(`/api/personas/${enc(id)}`, 'PUT', patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.personas }),
  });
}

export function useDeletePersona() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mutate(`/api/personas/${enc(id)}`, 'DELETE'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.personas }),
  });
}
