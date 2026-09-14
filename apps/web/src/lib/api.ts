import type { Part, RegexScript } from '@newtavern/core';
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
/* 连接与模型（M2 契约 §3.2）                                           */
/* ------------------------------------------------------------------ */

export type ProviderId = 'openai-chat' | 'openai-responses' | 'anthropic' | 'google';

export const PROVIDER_IDS: ProviderId[] = [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'google',
];

/** 与 `packages/providers` 的 `ModelCapabilities` 同构；UI 只读展示，故字段全部可选 */
export interface ModelCapabilities {
  thinking?: 'none' | 'budget' | 'effort' | 'level' | 'adaptive';
  effortLevels?: string[];
  caching?: 'none' | 'prefix-auto' | 'breakpoints' | 'explicit-object';
  cacheMinTokens?: number;
  maxBreakpoints?: number;
  systemInMessages?: boolean;
  reasoningRoundtrip?: 'none' | 'signature' | 'encrypted' | 'thoughtSignature';
  imageIn?: boolean;
  imageOut?: boolean;
  documentIn?: boolean;
  tools?: boolean;
  structuredOutput?: boolean;
  prefill?: boolean;
  maxContext?: number;
  maxOutput?: number;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
  maxOutput?: number;
}

export interface ConnectionInput {
  provider: ProviderId;
  label: string;
  baseUrl?: string;
  /** 缺省表示不改动；`[]` 表示清空 */
  apiKeys?: string[];
  headers?: Record<string, string>;
  proxy?: string | null;
  quirks?: Record<string, boolean>;
  modelOverrides?: Record<string, Partial<ModelCapabilities>>;
}

export interface ConnectionSummary extends Omit<ConnectionInput, 'apiKeys'> {
  id: string;
  keyCount: number;
  /** 每个 Key 的末 4 位 */
  keyHints: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionModelsResponse {
  models: ModelInfo[];
  fetchedAt: string | null;
  source: 'cache' | 'remote';
}

export interface ConnectionTestResult {
  ok: true;
  latencyMs: number;
  modelCount?: number;
}

/** 设置 KV `generation.default` */
export interface GenerationDefault {
  connectionId: string | null;
  model: string | null;
}

/** `GET /api/models/catalog` 的条目 */
export interface CatalogModel {
  provider: string;
  match: string;
  capabilities: Partial<ModelCapabilities>;
}

/* ------------------------------------------------------------------ */
/* 聊天与消息树（M2 契约 §3.4）                                         */
/* ------------------------------------------------------------------ */

export type MessageRole = 'user' | 'assistant' | 'system';

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface ChatOverrides {
  connectionId?: string | null;
  model?: string | null;
  sampling?: Record<string, unknown>;
  thinking?: { effort?: string; budgetTokens?: number };
  layoutMode?: LayoutMode;
  /** 全局系统提示词的按会话覆盖（M3 契约 §3.4），`null` = 不覆盖 */
  globalSystemPrompt?: GlobalSystemPromptOverride | null;
}

export type LayoutMode = 'strict' | 'cache-aware';

export interface MessageNode {
  id: string;
  chatId: string;
  parentId: string | null;
  siblingSeq: number;
  role: MessageRole;
  name: string | null;
  parts: Part[];
  reasoning: { text?: string; opaque?: unknown[] } | null;
  usage: Usage | null;
  provider: string | null;
  model: string | null;
  isHidden: boolean;
  extra: Record<string, unknown> | null;
  createdAt: string;
}

export interface ChatSummary {
  id: string;
  title: string | null;
  mode: string;
  characterIds: string[];
  personaId: string | null;
  presetId: string | null;
  overrides: ChatOverrides | null;
  rootNodeId: string | null;
  headNodeId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  character?: { id: string; name: string; avatarAssetId: string | null } | null;
  /** 绑定到该会话的世界书（插入顺序，M3 契约 §3.3） */
  lorebookIds: string[];
  messageCount: number;
  lastMessageAt: string | null;
  /** head 节点文本前 120 字 */
  preview: string | null;
}

export interface ChatDetail extends ChatSummary {
  nodes: MessageNode[];
}

export interface CreateChatInput {
  characterIds?: string[];
  personaId?: string | null;
  presetId?: string | null;
  title?: string;
  mode?: 'roleplay';
}

export interface PatchChatInput {
  title?: string;
  personaId?: string | null;
  presetId?: string | null;
  headNodeId?: string;
  overrides?: ChatOverrides;
  /** 浅合并；值为 `null` 的键会被删除（契约 §9 [SA→SB]） */
  metadata?: Record<string, unknown> | null;
}

export interface PostMessageInput {
  role: MessageRole;
  text: string;
  parentId?: string | null;
  name?: string;
}

export interface PatchNodeInput {
  text?: string;
  isHidden?: boolean;
  name?: string;
}

/** `POST /api/chats/:id/generate` 的请求体 */
export interface GenerateBody {
  userMessage?: { text: string; name?: string } | null;
  parentId?: string | null;
  connectionId?: string;
  model?: string;
  layoutMode?: LayoutMode;
}

/** 生成 SSE 的 error 事件载荷 */
export interface GenerationError {
  kind: string;
  message: string;
  status?: number;
}

/** 消息节点的纯文本（多个 text part 直接拼接） */
export function nodeText(node: Pick<MessageNode, 'parts'>): string {
  let text = '';
  for (const part of node.parts) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* M3：作者注释 / 全局系统提示词 / 世界书设置 / 正则脚本（契约 §3）      */
/* ------------------------------------------------------------------ */

/** 0 IN_PROMPT（主提示之后）、1 IN_CHAT（对话中按深度）、2 BEFORE_PROMPT（主提示之前） */
export type AuthorsNotePosition = 0 | 1 | 2;
/** 0 system、1 user、2 assistant */
export type InjectionRole = 0 | 1 | 2;

export interface AuthorsNote {
  text: string;
  position: AuthorsNotePosition;
  depth: number;
  role: InjectionRole;
  /** 每 N 条消息插一次，1 = 每次 */
  interval: number;
}

/** ST 默认值（契约 §3.4 修正） */
export const DEFAULT_AUTHORS_NOTE: AuthorsNote = {
  text: '',
  position: 1,
  depth: 4,
  role: 0,
  interval: 1,
};

/** 从 `chat.metadata.authorsNote` 读出作者注释；脏数据当作没有 */
export function readAuthorsNote(chat: Pick<ChatSummary, 'metadata'>): AuthorsNote | null {
  const raw = chat.metadata?.['authorsNote'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.text !== 'string') return null;
  const tri = (input: unknown, fallback: 0 | 1 | 2): 0 | 1 | 2 =>
    input === 0 || input === 1 || input === 2 ? input : fallback;
  const num = (input: unknown, fallback: number): number =>
    typeof input === 'number' && Number.isFinite(input) ? input : fallback;
  return {
    text: value.text,
    position: tri(value.position, DEFAULT_AUTHORS_NOTE.position),
    depth: num(value.depth, DEFAULT_AUTHORS_NOTE.depth),
    role: tri(value.role, DEFAULT_AUTHORS_NOTE.role),
    interval: num(value.interval, DEFAULT_AUTHORS_NOTE.interval),
  };
}

export type GlobalSystemPromptPosition = 'before_main' | 'after_main';

export interface GlobalSystemPrompt {
  enabled: boolean;
  text: string;
  position: GlobalSystemPromptPosition;
}

/** 会话覆盖：逐字段覆盖设置 KV 的值 */
export type GlobalSystemPromptOverride = Partial<GlobalSystemPrompt>;

export const DEFAULT_GLOBAL_SYSTEM_PROMPT: GlobalSystemPrompt = {
  enabled: false,
  text: '',
  position: 'before_main',
};

/** 设置 KV `worldInfo.settings` 的 UI 形态（预算为百分比） */
export interface WorldInfoSettings {
  scanDepth: number;
  budgetPercent: number;
  budgetCap: number;
  recursive: boolean;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  useGroupScoring: boolean;
  maxRecursionSteps: number;
  minActivations: number;
  minActivationsDepthMax: number;
  includeNames: boolean;
}

/**
 * ST 1.18 的实际默认值（契约 §9 修正 WI-10：`recursive=false`、`includeNames=true`）。
 * 服务端 `services/wi-settings.ts` 的旧默认值与此不同，见契约 §9 [WEB→SB]。
 */
export const DEFAULT_WORLD_INFO_SETTINGS: WorldInfoSettings = {
  scanDepth: 2,
  budgetPercent: 25,
  budgetCap: 0,
  recursive: false,
  caseSensitive: false,
  matchWholeWords: false,
  useGroupScoring: false,
  maxRecursionSteps: 0,
  minActivations: 0,
  minActivationsDepthMax: 0,
  includeNames: true,
};

/** 正则脚本对外形状与 `@newtavern/core` 的引擎入参一致，直接复用引擎类型 */
export type { RegexScript };

/** 新建 / 更新正则脚本时可写的字段 */
export type RegexScriptInput = Partial<Omit<RegexScript, 'id' | 'scope'>>;

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
  chats: ['chats'] as const,
  chat: (id: string) => ['chats', id] as const,
  connections: ['connections'] as const,
  connection: (id: string) => ['connections', id] as const,
  connectionModels: (id: string) => ['connections', id, 'models'] as const,
  generationDefault: ['settings', 'generation.default'] as const,
  catalogModels: ['models', 'catalog'] as const,
  setting: (key: string) => ['settings', key] as const,
  regexScripts: ['regex'] as const,
  characterRegex: (id: string) => ['characters', id, 'regex'] as const,
  /** 检查器：head / 布局模式 / 连接模型任一变化都要重新取数 */
  chatInspect: (id: string, params: Record<string, string | null>) =>
    ['chats', id, 'inspect', params] as const,
};

export const apiUrls = {
  importCharacter: '/api/import/character',
  importPreset: '/api/import/preset',
  importLorebook: '/api/import/lorebook',
  importRegex: '/api/import/regex',
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

/* ------------------------------------------------------------------ */
/* 连接与模型 hooks                                                     */
/* ------------------------------------------------------------------ */

export function useConnections() {
  return useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => fetchJson<ConnectionSummary[]>('/api/connections'),
  });
}

export function useConnection(id: string | null) {
  return useQuery({
    queryKey: queryKeys.connection(id ?? ''),
    queryFn: () => fetchJson<ConnectionSummary>(`/api/connections/${enc(id ?? '')}`),
    enabled: id !== null,
  });
}

export function useCreateConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConnectionInput) =>
      mutate<ConnectionSummary>('/api/connections', 'POST', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}

export function useUpdateConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: Partial<ConnectionInput> & { id: string }) =>
      mutate<ConnectionSummary>(`/api/connections/${enc(id)}`, 'PUT', patch),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.connection(data.id), data);
      return queryClient.invalidateQueries({ queryKey: queryKeys.connections });
    },
  });
}

export function useDeleteConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mutate(`/api/connections/${enc(id)}`, 'DELETE'),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.connection(id) });
      return queryClient.invalidateQueries({ queryKey: queryKeys.connections });
    },
  });
}

/**
 * 连接下的模型列表。`refresh` 为 true 时强制远端拉取（另开缓存键，避免污染常规列表）。
 */
export function useConnectionModels(id: string | null) {
  return useQuery({
    queryKey: queryKeys.connectionModels(id ?? ''),
    queryFn: () => fetchJson<ConnectionModelsResponse>(`/api/connections/${enc(id ?? '')}/models`),
    enabled: id !== null,
    staleTime: 5 * 60_000,
  });
}

/** 强制刷新模型列表并写回缓存 */
export function useRefreshConnectionModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      fetchJson<ConnectionModelsResponse>(`/api/connections/${enc(id)}/models?refresh=1`),
    onSuccess: (data, id) => queryClient.setQueryData(queryKeys.connectionModels(id), data),
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: ({ id, model }: { id: string; model?: string }) =>
      mutate<ConnectionTestResult>(`/api/connections/${enc(id)}/test`, 'POST', { model }),
  });
}

const GENERATION_DEFAULT_URL = '/api/settings/generation.default';

const EMPTY_GENERATION_DEFAULT: GenerationDefault = { connectionId: null, model: null };

/** 设置路由统一返回 `{ key, value }`，这里剥掉外层并补齐缺省值 */
function toGenerationDefault(value: unknown): GenerationDefault {
  const record = (value ?? {}) as { connectionId?: unknown; model?: unknown };
  return {
    connectionId: typeof record.connectionId === 'string' ? record.connectionId : null,
    model: typeof record.model === 'string' ? record.model : null,
  };
}

export function useGenerationDefault() {
  return useQuery({
    queryKey: queryKeys.generationDefault,
    queryFn: async () => {
      try {
        const row = await fetchJson<{ key: string; value: unknown }>(GENERATION_DEFAULT_URL);
        return toGenerationDefault(row.value);
      } catch (error) {
        // 从未设置过默认值时设置路由返回 404，视为「未设置」而不是错误
        if (error instanceof ApiError && error.status === 404) return EMPTY_GENERATION_DEFAULT;
        throw error;
      }
    },
  });
}

export function useSetGenerationDefault() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (value: GenerationDefault) => {
      const row = await mutate<{ key: string; value: unknown }>(
        GENERATION_DEFAULT_URL,
        'PUT',
        value,
      );
      return toGenerationDefault(row.value);
    },
    onSuccess: (data) => queryClient.setQueryData(queryKeys.generationDefault, data),
  });
}

export function useCatalogModels() {
  return useQuery({
    queryKey: queryKeys.catalogModels,
    queryFn: () => fetchJson<CatalogModel[]>('/api/models/catalog'),
    staleTime: Infinity,
  });
}

/* ------------------------------------------------------------------ */
/* 聊天 hooks                                                           */
/* ------------------------------------------------------------------ */

export function useChats() {
  return useQuery({
    queryKey: queryKeys.chats,
    queryFn: () => fetchJson<ChatSummary[]>('/api/chats'),
  });
}

export function useChat(id: string | null) {
  return useQuery({
    queryKey: queryKeys.chat(id ?? ''),
    queryFn: () => fetchJson<ChatDetail>(`/api/chats/${enc(id ?? '')}`),
    enabled: id !== null,
    // 流式期间由 useGeneration 直接写缓存，重新聚焦时的自动刷新会丢字
    refetchOnWindowFocus: false,
  });
}

export function useCreateChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateChatInput) => mutate<ChatDetail>('/api/chats', 'POST', input),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.chat(data.id), data);
      return queryClient.invalidateQueries({ queryKey: queryKeys.chats, exact: true });
    },
  });
}

export function usePatchChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: PatchChatInput & { id: string }) =>
      mutate<ChatDetail>(`/api/chats/${enc(id)}`, 'PATCH', patch),
    onSuccess: (data) => {
      // PATCH 返回 ChatDetail；服务端若省略 nodes 则保留缓存里的
      queryClient.setQueryData<ChatDetail>(queryKeys.chat(data.id), (previous) => ({
        ...data,
        nodes: data.nodes ?? previous?.nodes ?? [],
      }));
      return queryClient.invalidateQueries({ queryKey: queryKeys.chats, exact: true });
    },
  });
}

export function useDeleteChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mutate(`/api/chats/${enc(id)}`, 'DELETE'),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: queryKeys.chat(id) });
      return queryClient.invalidateQueries({ queryKey: queryKeys.chats, exact: true });
    },
  });
}

export function usePostMessage() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, ...input }: PostMessageInput & { chatId: string }) =>
      mutate<{ node: MessageNode; chat: ChatSummary }>(
        `/api/chats/${enc(chatId)}/messages`,
        'POST',
        input,
      ),
    onSuccess: ({ node, chat }) => {
      queryClient.setQueryData<ChatDetail>(queryKeys.chat(chat.id), (previous) =>
        previous ? mergeNode(previous, node, chat) : previous,
      );
      return queryClient.invalidateQueries({ queryKey: queryKeys.chats, exact: true });
    },
  });
}

export function usePatchNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      chatId,
      nodeId,
      ...patch
    }: PatchNodeInput & { chatId: string; nodeId: string }) =>
      mutate<MessageNode>(`/api/chats/${enc(chatId)}/nodes/${enc(nodeId)}`, 'PATCH', patch),
    onSuccess: (node, { chatId }) => {
      queryClient.setQueryData<ChatDetail>(queryKeys.chat(chatId), (previous) =>
        previous ? mergeNode(previous, node) : previous,
      );
      return queryClient.invalidateQueries({ queryKey: queryKeys.chats, exact: true });
    },
  });
}

export function useDeleteNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, nodeId }: { chatId: string; nodeId: string }) =>
      mutate<{ chat: ChatSummary }>(`/api/chats/${enc(chatId)}/nodes/${enc(nodeId)}`, 'DELETE'),
    onSuccess: (result, { chatId }) => {
      // 删的是子树，剩下哪些节点由服务端决定 —— 直接重新拉详情
      queryClient.setQueryData<ChatDetail>(queryKeys.chat(chatId), (previous) =>
        previous && result?.chat ? { ...previous, ...result.chat } : previous,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
      return queryClient.invalidateQueries({ queryKey: queryKeys.chats, exact: true });
    },
  });
}

/** 全量替换会话绑定的世界书（契约 §3.3，返回完整 ChatDetail） */
export function useSetChatLorebooks() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, bookIds }: { chatId: string; bookIds: string[] }) =>
      mutate<ChatDetail>(`/api/chats/${enc(chatId)}/lorebooks`, 'PUT', { bookIds }),
    onSuccess: (data) => {
      queryClient.setQueryData<ChatDetail>(queryKeys.chat(data.id), (previous) => ({
        ...data,
        nodes: data.nodes ?? previous?.nodes ?? [],
      }));
      return queryClient.invalidateQueries({ queryKey: queryKeys.chats, exact: true });
    },
  });
}

/* ------------------------------------------------------------------ */
/* 设置 KV hooks                                                        */
/* ------------------------------------------------------------------ */

/**
 * 通用设置项：响应信封是 `{ key, value }`，未设置过时 GET 返回 404（视为「用默认值」）。
 * `normalize` 负责把任意脏数据归一化成前端类型。
 */
export function useSetting<T>(key: string, normalize: (value: unknown) => T) {
  return useQuery({
    queryKey: queryKeys.setting(key),
    queryFn: async () => {
      try {
        const row = await fetchJson<{ key: string; value: unknown }>(`/api/settings/${enc(key)}`);
        return normalize(row.value);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return normalize(undefined);
        throw error;
      }
    },
  });
}

export function useSetSetting<T>(key: string, normalize: (value: unknown) => T) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (value: T) => {
      const row = await mutate<{ key: string; value: unknown }>(
        `/api/settings/${enc(key)}`,
        'PUT',
        value,
      );
      return normalize(row.value);
    },
    onSuccess: (data) => queryClient.setQueryData(queryKeys.setting(key), data),
  });
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function normalizeWorldInfoSettings(value: unknown): WorldInfoSettings {
  const source = asRecord(value);
  const result = { ...DEFAULT_WORLD_INFO_SETTINGS };
  for (const key of Object.keys(DEFAULT_WORLD_INFO_SETTINGS) as (keyof WorldInfoSettings)[]) {
    const incoming = source[key];
    const fallback = DEFAULT_WORLD_INFO_SETTINGS[key];
    if (typeof fallback === 'boolean') {
      if (typeof incoming === 'boolean') (result[key] as boolean) = incoming;
    } else if (typeof incoming === 'number' && Number.isFinite(incoming)) {
      (result[key] as number) = incoming;
    }
  }
  return result;
}

export function normalizeGlobalSystemPrompt(value: unknown): GlobalSystemPrompt {
  const source = asRecord(value);
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : false,
    text: typeof source.text === 'string' ? source.text : '',
    position: source.position === 'after_main' ? 'after_main' : 'before_main',
  };
}

function normalizeIdList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export const SETTING_KEYS = {
  worldInfoSettings: 'worldInfo.settings',
  worldInfoGlobalBooks: 'worldInfo.globalBookIds',
  globalSystemPrompt: 'globalSystemPrompt',
} as const;

export const useWorldInfoSettings = () =>
  useSetting(SETTING_KEYS.worldInfoSettings, normalizeWorldInfoSettings);
export const useSetWorldInfoSettings = () =>
  useSetSetting(SETTING_KEYS.worldInfoSettings, normalizeWorldInfoSettings);

export const useGlobalBookIds = () =>
  useSetting(SETTING_KEYS.worldInfoGlobalBooks, normalizeIdList);
export const useSetGlobalBookIds = () =>
  useSetSetting(SETTING_KEYS.worldInfoGlobalBooks, normalizeIdList);

export const useGlobalSystemPrompt = () =>
  useSetting(SETTING_KEYS.globalSystemPrompt, normalizeGlobalSystemPrompt);
export const useSetGlobalSystemPrompt = () =>
  useSetSetting(SETTING_KEYS.globalSystemPrompt, normalizeGlobalSystemPrompt);

/* ------------------------------------------------------------------ */
/* 正则脚本 hooks（契约 §3.2）                                          */
/* ------------------------------------------------------------------ */

/** 全局正则脚本，按 display_order。显示侧正则每条消息都要用，缓存 5 分钟。 */
export function useRegexScripts() {
  return useQuery({
    queryKey: queryKeys.regexScripts,
    queryFn: () => fetchJson<RegexScript[]>('/api/regex'),
    staleTime: 5 * 60_000,
  });
}

/** 角色卡内嵌正则（`data.extensions.regex_scripts`，scope='character'） */
export function useCharacterRegex(characterId: string | null) {
  return useQuery({
    queryKey: queryKeys.characterRegex(characterId ?? ''),
    queryFn: () => fetchJson<RegexScript[]>(`/api/characters/${enc(characterId ?? '')}/regex`),
    enabled: characterId !== null,
    staleTime: 5 * 60_000,
  });
}

/** 写操作成功后统一刷新脚本列表 */
function useRegexMutation<TVariables>(mutationFn: (variables: TVariables) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.regexScripts }),
  });
}

export function useCreateRegexScript() {
  return useRegexMutation((input: RegexScriptInput) =>
    mutate<RegexScript>('/api/regex', 'POST', input),
  );
}

export function useUpdateRegexScript() {
  return useRegexMutation(({ id, ...patch }: RegexScriptInput & { id: string }) =>
    mutate<RegexScript>(`/api/regex/${enc(id)}`, 'PUT', patch),
  );
}

export function useDeleteRegexScript() {
  return useRegexMutation((id: string) => mutate(`/api/regex/${enc(id)}`, 'DELETE'));
}

/** 重排：body `{ ids }` 为新顺序的全部 id，响应是重排后的列表 */
export function useReorderRegexScripts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => mutate<RegexScript[]>('/api/regex/order', 'PUT', { ids }),
    onSuccess: (data) => queryClient.setQueryData(queryKeys.regexScripts, data),
  });
}

/** 把一个节点写入 ChatDetail 缓存（存在则替换），并可选合并聊天摘要字段 */
export function mergeNode(detail: ChatDetail, node: MessageNode, chat?: ChatSummary): ChatDetail {
  const index = detail.nodes.findIndex((item) => item.id === node.id);
  const nodes =
    index === -1
      ? [...detail.nodes, node]
      : detail.nodes.map((item, i) => (i === index ? node : item));
  return { ...detail, ...(chat ?? {}), nodes };
}
