import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import {
  fetchJson,
  mutate,
  queryKeys,
  uploadFile,
  type CharacterCardData,
  type CharacterDetail,
  type ChatDetail,
  type LayoutMode,
} from './api';

/*
 * 创作工作台的前端数据层（M6 §2 / §4）。形状与服务端
 * `routes/{characters,versions,prompt-library,studio}.ts`、`services/studio-draft.ts` 一致
 * （web 不依赖 server 包，这里按契约声明）。AI 协作者的 SSE 在 `features/studio/assist/api.ts`。
 */

const enc = encodeURIComponent;

export type StudioKind = 'character' | 'preset' | 'lorebook';
export const STUDIO_KINDS: readonly StudioKind[] = ['character', 'preset', 'lorebook'];

export function isStudioKind(value: unknown): value is StudioKind {
  return STUDIO_KINDS.includes(value as StudioKind);
}

export type VersionAuthor = 'user' | 'ai';

/** 工作台里打开某个实体的路径 */
export function studioPath(kind: StudioKind, id: string): string {
  return `/studio/${kind}/${encodeURIComponent(id)}`;
}

/**
 * 组装草稿（M6 §2.4）：`POST /api/chats/:id/generate` 与 `POST /api/chats/:id/inspect` 的 body `draft`。
 * 给了就用内存对象代替对应数据库行，不落库。
 */
export interface StudioDraftBody {
  character?: { id: string; data: Record<string, unknown> };
  preset?: { id: string; data: Record<string, unknown> };
  lorebook?: { id: string; name?: string; entries: Record<string, unknown>[] };
}

/* ------------------------------------------------------------------ */
/* 测试会话的草稿登记：生成请求自动带上                                 */
/* ------------------------------------------------------------------ */

const chatDrafts = new Map<string, () => StudioDraftBody | undefined>();

/**
 * 工作台把「这条测试会话当前的草稿」登记在这里；`useGeneration` 发生成请求时取一次
 * （发送、重生成、重试、前端卡触发的生成都走同一条路，所以都带 draft）。返回注销函数。
 */
export function registerChatDraft(
  chatId: string,
  provider: () => StudioDraftBody | undefined,
): () => void {
  chatDrafts.set(chatId, provider);
  return () => {
    if (chatDrafts.get(chatId) === provider) chatDrafts.delete(chatId);
  };
}

/** 这条会话当前登记的草稿；没有登记或草稿与已保存一致时为 undefined */
export function chatDraftFor(chatId: string): StudioDraftBody | undefined {
  return chatDrafts.get(chatId)?.();
}

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

/** `GET /api/versions/recent` 的一项 */
export interface RecentEntity {
  type: StudioKind;
  id: string;
  name: string;
  version: number;
  author: VersionAuthor;
  updatedAt: string;
}

/** `GET /api/versions/:type/:id` 的一项 */
export interface VersionSummary {
  version: number;
  author: VersionAuthor;
  createdAt: string;
  /** 版本数据 JSON 的字节数 */
  size: number;
}

/** `GET /api/versions/:type/:id/:version`：data 与工作台草稿同形 */
export interface VersionDetail {
  type: StudioKind;
  id: string;
  version: number;
  data: unknown;
}

export type PromptRole = 'system' | 'user' | 'assistant';

/** 提示库条目（M6 §2.3） */
export interface PromptLibraryItem {
  id: string;
  name: string;
  content: string;
  role: PromptRole | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PromptLibraryInput {
  name?: string;
  content?: string;
  role?: PromptRole | null;
  tags?: string[];
}

/** `GET /api/characters/:id` 的整行（多了编辑标记） */
export interface StudioCharacterDetail extends CharacterDetail {
  editedAt?: string | null;
}

/* ------------------------------------------------------------------ */
/* Query keys                                                           */
/* ------------------------------------------------------------------ */

export const studioKeys = {
  recent: (limit: number) => ['versions', 'recent', limit] as const,
  versions: (kind: StudioKind, id: string) => ['versions', kind, id] as const,
  version: (kind: StudioKind, id: string, version: number) =>
    ['versions', kind, id, version] as const,
  promptLibrary: (q: string, tag: string) => ['prompt-library', q, tag] as const,
  promptLibraryAll: ['prompt-library'] as const,
  testChat: (kind: StudioKind, id: string) => ['studio', 'test-chat', kind, id] as const,
};

/* ------------------------------------------------------------------ */
/* 角色卡编辑                                                           */
/* ------------------------------------------------------------------ */

/** `POST /api/characters`：新建 V3 空卡（`studio: true` = 工作台里新建的，库页面不带） */
export function createCharacter(input: {
  name: string;
  data?: CharacterCardData;
  studio?: boolean;
}): Promise<StudioCharacterDetail> {
  return mutate<StudioCharacterDetail>('/api/characters', 'POST', input);
}

/** `PUT /api/characters/:id`：整份替换 data（完整 CCv3 data），写一版版本历史 */
export function updateCharacter(
  id: string,
  data: CharacterCardData,
  author?: VersionAuthor,
): Promise<StudioCharacterDetail> {
  return mutate<StudioCharacterDetail>(`/api/characters/${enc(id)}`, 'PUT', {
    data,
    ...(author ? { author } : {}),
  });
}

/** 换头像：导出 PNG 以头像为底图，只有 PNG 能当底图，调用方应上传 PNG（M6 §6 ST 修正 8） */
export function uploadCharacterAvatar(id: string, file: File): Promise<StudioCharacterDetail> {
  return uploadFile<StudioCharacterDetail>(`/api/characters/${enc(id)}/avatar`, file);
}

export function deleteCharacterAvatar(id: string): Promise<StudioCharacterDetail> {
  return mutate<StudioCharacterDetail>(`/api/characters/${enc(id)}/avatar`, 'DELETE');
}

export function useCreateCharacter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createCharacter,
    onSuccess: (row) => {
      queryClient.setQueryData(queryKeys.character(row.id), row);
      return queryClient.invalidateQueries({ queryKey: queryKeys.characters, exact: true });
    },
  });
}

/* ------------------------------------------------------------------ */
/* 复制到工作台                                                         */
/* ------------------------------------------------------------------ */

/** `POST /api/studio/fork/:kind/:id`：已是工作台的返回原 id（forked: false） */
export interface StudioForkResult {
  id: string;
  forked: boolean;
}

/** 进行中的复制，按 `kind:id` 去重：StrictMode 双调用 / 重复渲染只发一次请求 */
const pendingForks = new Map<string, Promise<StudioForkResult>>();

/**
 * 把库里的原件复制一份到工作台（原件不动），返回副本 id。同一实体同时只发一次请求；
 * 完成后刷新三类列表（副本出现在库与工作台首页里）。失败时清掉缓存，允许重试。
 */
export function forkToStudio(
  queryClient: QueryClient,
  kind: StudioKind,
  id: string,
): Promise<StudioForkResult> {
  const key = `${kind}:${id}`;
  const pending = pendingForks.get(key);
  if (pending) return pending;
  const promise = mutate<StudioForkResult>(`/api/studio/fork/${kind}/${enc(id)}`, 'POST')
    .then(async (result) => {
      if (result.forked) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.characters, exact: true }),
          queryClient.invalidateQueries({ queryKey: queryKeys.presets, exact: true }),
          queryClient.invalidateQueries({ queryKey: queryKeys.lorebooks, exact: true }),
        ]);
      }
      // 成功后留一小会儿：StrictMode 第二次挂载 / 跳转前的重复渲染拿到同一个结果，不会再复制一份
      setTimeout(() => {
        if (pendingForks.get(key) === promise) pendingForks.delete(key);
      }, 5000);
      return result;
    })
    .catch((error: unknown) => {
      // 失败立刻清掉，重试会重新发请求
      if (pendingForks.get(key) === promise) pendingForks.delete(key);
      throw error;
    });
  pendingForks.set(key, promise);
  return promise;
}

/* ------------------------------------------------------------------ */
/* 版本历史                                                             */
/* ------------------------------------------------------------------ */

export function useRecentEntities(limit = 12) {
  return useQuery({
    queryKey: studioKeys.recent(limit),
    queryFn: () => fetchJson<RecentEntity[]>(`/api/versions/recent?limit=${limit}`),
  });
}

export function useVersions(kind: StudioKind, id: string) {
  return useQuery({
    queryKey: studioKeys.versions(kind, id),
    queryFn: () => fetchJson<VersionSummary[]>(`/api/versions/${kind}/${enc(id)}`),
  });
}

export function useVersion(kind: StudioKind, id: string, version: number | null) {
  return useQuery({
    queryKey: studioKeys.version(kind, id, version ?? 0),
    queryFn: () => fetchJson<VersionDetail>(`/api/versions/${kind}/${enc(id)}/${version ?? 0}`),
    enabled: version !== null,
    // 版本内容不变
    staleTime: Infinity,
  });
}

/** 恢复某一版：服务端用该版 data 走一次保存（author='user'），产生新版本 */
export function restoreVersion(
  kind: StudioKind,
  id: string,
  version: number,
): Promise<{ version: number }> {
  return mutate<{ version: number }>(`/api/versions/${kind}/${enc(id)}/${version}/restore`, 'POST');
}

/* ------------------------------------------------------------------ */
/* 提示库                                                               */
/* ------------------------------------------------------------------ */

export function usePromptLibrary(q: string, tag: string) {
  return useQuery({
    queryKey: studioKeys.promptLibrary(q, tag),
    queryFn: () => {
      const query = new URLSearchParams();
      if (q) query.set('q', q);
      if (tag) query.set('tag', tag);
      const suffix = query.toString();
      return fetchJson<PromptLibraryItem[]>(`/api/prompt-library${suffix ? `?${suffix}` : ''}`);
    },
    placeholderData: (previous) => previous,
  });
}

export function useSavePromptLibraryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: PromptLibraryInput }) =>
      id === null
        ? mutate<PromptLibraryItem>('/api/prompt-library', 'POST', input)
        : mutate<PromptLibraryItem>(`/api/prompt-library/${enc(id)}`, 'PUT', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: studioKeys.promptLibraryAll }),
  });
}

export function useDeletePromptLibraryItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mutate(`/api/prompt-library/${enc(id)}`, 'DELETE'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: studioKeys.promptLibraryAll }),
  });
}

/* ------------------------------------------------------------------ */
/* 测试会话与带草稿的检查                                               */
/* ------------------------------------------------------------------ */

/** 该实体的测试会话（最近一条，没有就新建） */
export function fetchTestChat(kind: StudioKind, id: string): Promise<ChatDetail> {
  return fetchJson<ChatDetail>(`/api/studio/test-chat/${kind}/${enc(id)}`);
}

/**
 * 新建一条测试会话替换当前那条（旧的删除）：`characterId` 缺省沿用旧会话的角色，null = 不带角色；
 * 档案、预设、连接等覆盖、聊天书、作者注释沿用旧会话。
 */
export function recreateTestChat(
  kind: StudioKind,
  id: string,
  body: { characterId?: string | null } = {},
): Promise<ChatDetail> {
  return mutate<ChatDetail>(`/api/studio/test-chat/${kind}/${enc(id)}`, 'POST', body);
}

export interface DraftInspectParams {
  chatId: string;
  parentId: string | null;
  layoutMode: LayoutMode;
  connectionId: string | null;
  model: string | null;
}

/** `POST /api/chats/:id/inspect`：参数同 GET（在 query 里），body `{ draft }` */
export function inspectWithDraft<T>(
  params: DraftInspectParams,
  draft: StudioDraftBody | undefined,
): Promise<T> {
  const query = new URLSearchParams({ layoutMode: params.layoutMode });
  if (params.parentId !== null) query.set('parentId', params.parentId);
  if (params.connectionId) query.set('connectionId', params.connectionId);
  if (params.model) query.set('model', params.model);
  return mutate<T>(`/api/chats/${enc(params.chatId)}/inspect?${query.toString()}`, 'POST', {
    ...(draft ? { draft } : {}),
  });
}
