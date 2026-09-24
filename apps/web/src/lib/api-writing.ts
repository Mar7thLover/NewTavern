import type { WritingAction, WritingContextReport } from '@newtavern/core';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { fetchJson, mutate } from './api';

/**
 * 长篇写作的前端数据层（M7 契约 §3）。形状与服务端 `apps/server/src/services/writing.ts`、
 * `writing-ai.ts` 一致（web 不直接依赖 server 包，这里照抄一份）。
 */

export type { WritingAction, WritingContextReport } from '@newtavern/core';

export type WritingLanguage = 'zh-CN' | 'en';
export type WritingLayoutMode = 'cache-aware' | 'strict';
export type WritingDocumentKind = 'chapter' | 'note';

export interface WritingProjectSettings {
  connectionId?: string;
  model?: string;
  layoutMode: WritingLayoutMode;
  styleGuide: string;
  systemPrompt?: string;
  contextBudget?: number;
  language?: WritingLanguage;
  [key: string]: unknown;
}

export interface WritingProjectSummary {
  id: string;
  title: string;
  chapterCount: number;
  noteCount: number;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WritingDocumentSummary {
  id: string;
  projectId: string;
  kind: WritingDocumentKind;
  title: string;
  order: number;
  done: boolean;
  summary: string;
  summaryStale: boolean;
  summaryPending: boolean;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

/** TipTap JSON（ProseMirror 文档的 toJSON） */
export type WritingContent = Record<string, unknown>;

export interface WritingDocumentDetail extends WritingDocumentSummary {
  content: WritingContent | null;
  text: string;
}

export interface WritingProjectDetail {
  id: string;
  title: string;
  settings: WritingProjectSettings;
  lorebookIds: string[];
  outline: string;
  chapterCount: number;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
  documents: WritingDocumentSummary[];
}

export interface WritingVersionSummary {
  version: number;
  author: 'user' | 'ai';
  label: string | null;
  createdAt: string;
  wordCount: number;
  size: number;
}

export interface WritingVersionDetail extends WritingVersionSummary {
  content: WritingContent | null;
  text: string;
}

export interface UpdateWritingProjectRequest {
  title?: string;
  /** 浅合并；值为 null 的字段删除 */
  settings?: Record<string, unknown>;
  lorebookIds?: string[];
  outline?: string;
}

export interface UpdateWritingDocumentRequest {
  title?: string;
  content?: WritingContent | null;
  text?: string;
  done?: boolean;
  summary?: string;
}

export interface WritingAiRequest {
  action: WritingAction;
  instruction?: string;
  cursor?: number;
  selection?: { from: number; to: number };
  textBefore?: string;
  textAfter?: string;
  selectionText?: string;
  targetLength?: number;
  connectionId?: string;
  model?: string;
}

export interface WritingUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export interface WritingInspectResponse {
  connected: boolean;
  connectionId: string | null;
  model: string | null;
  layoutMode: WritingLayoutMode;
  budget: number;
  segments: { id: string; role: string; stability: string; text?: string }[];
  report: WritingContextReport;
}

/** AI SSE 事件（`event:` 名 → `data` 形状） */
export interface WritingAiEvents {
  context: { report: WritingContextReport; model: string; connectionId: string };
  text: { delta: string };
  reasoning: { delta: string };
  usage: WritingUsage;
  done: {
    text: string;
    stopReason: string;
    usage: WritingUsage | null;
    summary?: string;
    beforeVersion: number | null;
  };
  error: { message: string; kind?: string };
}

export type WritingAiEvent = {
  [K in keyof WritingAiEvents]: { type: K; data: WritingAiEvents[K] };
}[keyof WritingAiEvents];

/* ------------------------------------------------------------------ */
/* 查询键与 URL                                                          */
/* ------------------------------------------------------------------ */

const enc = encodeURIComponent;
const BASE = '/api/writing';

export const writingKeys = {
  all: ['writing'] as const,
  projects: ['writing', 'projects'] as const,
  project: (id: string) => ['writing', 'project', id] as const,
  document: (id: string) => ['writing', 'document', id] as const,
  versions: (docId: string) => ['writing', 'document', docId, 'versions'] as const,
  version: (docId: string, version: number) =>
    ['writing', 'document', docId, 'versions', version] as const,
};

export function exportUrl(projectId: string, format: 'md' | 'txt'): string {
  return `${BASE}/projects/${enc(projectId)}/export?format=${format}`;
}

/* ------------------------------------------------------------------ */
/* 项目                                                                  */
/* ------------------------------------------------------------------ */

export function useWritingProjects() {
  return useQuery({
    queryKey: writingKeys.projects,
    queryFn: () => fetchJson<WritingProjectSummary[]>(`${BASE}/projects`),
  });
}

export function useWritingProject(id: string | null) {
  return useQuery({
    queryKey: writingKeys.project(id ?? ''),
    queryFn: () => fetchJson<WritingProjectDetail>(`${BASE}/projects/${enc(id ?? '')}`),
    enabled: id !== null,
    // 章节标记完成后服务端在后台写摘要：有进行中的就轮询，写完自动停
    refetchInterval: (query) =>
      query.state.data?.documents.some((doc) => doc.summaryPending) ? 3000 : false,
  });
}

export function useCreateWritingProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { title: string }) =>
      mutate<WritingProjectDetail>(`${BASE}/projects`, 'POST', input),
    onSuccess: (data) => {
      queryClient.setQueryData(writingKeys.project(data.id), data);
      return queryClient.invalidateQueries({ queryKey: writingKeys.projects });
    },
  });
}

export function useUpdateWritingProject(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateWritingProjectRequest) =>
      mutate<WritingProjectDetail>(`${BASE}/projects/${enc(id)}`, 'PUT', patch),
    onSuccess: (data) => {
      queryClient.setQueryData(writingKeys.project(id), data);
      return queryClient.invalidateQueries({ queryKey: writingKeys.projects });
    },
  });
}

export function useDeleteWritingProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mutate(`${BASE}/projects/${enc(id)}`, 'DELETE'),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: writingKeys.project(id) });
      return queryClient.invalidateQueries({ queryKey: writingKeys.projects });
    },
  });
}

/* ------------------------------------------------------------------ */
/* 文档                                                                  */
/* ------------------------------------------------------------------ */

export function useWritingDocument(id: string | null) {
  return useQuery({
    queryKey: writingKeys.document(id ?? ''),
    queryFn: () => fetchJson<WritingDocumentDetail>(`${BASE}/documents/${enc(id ?? '')}`),
    enabled: id !== null,
    // 编辑器是唯一的写入方：打开期间别让后台重取把光标下的内容换掉
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

/** 文档摘要（列表里那一份）随保存结果同步到项目缓存，树上的字数、完成、过期标记跟着变 */
function patchProjectDocument(queryClient: QueryClient, doc: WritingDocumentSummary) {
  queryClient.setQueryData<WritingProjectDetail>(writingKeys.project(doc.projectId), (project) => {
    if (!project) return project;
    const documents = project.documents.map((item) =>
      item.id === doc.id ? { ...item, ...toSummary(doc) } : item,
    );
    const chapters = documents.filter((item) => item.kind === 'chapter');
    return {
      ...project,
      documents,
      wordCount: chapters.reduce((sum, item) => sum + item.wordCount, 0),
    };
  });
}

function toSummary(doc: WritingDocumentSummary): WritingDocumentSummary {
  return {
    id: doc.id,
    projectId: doc.projectId,
    kind: doc.kind,
    title: doc.title,
    order: doc.order,
    done: doc.done,
    summary: doc.summary,
    summaryStale: doc.summaryStale,
    summaryPending: doc.summaryPending,
    wordCount: doc.wordCount,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** 保存文档（自动保存直接调用，不经 useMutation，免得并发的保存互相覆盖 isPending） */
export async function saveWritingDocument(
  queryClient: QueryClient,
  id: string,
  patch: UpdateWritingDocumentRequest,
): Promise<WritingDocumentDetail> {
  const doc = await mutate<WritingDocumentDetail>(`${BASE}/documents/${enc(id)}`, 'PUT', patch);
  // 正文缓存不回写 content：编辑器里可能已经有更新的内容；只更新元信息
  queryClient.setQueryData<WritingDocumentDetail>(writingKeys.document(id), (current) =>
    current ? { ...current, ...toSummary(doc), content: doc.content, text: doc.text } : doc,
  );
  patchProjectDocument(queryClient, doc);
  return doc;
}

export function useUpdateWritingDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: UpdateWritingDocumentRequest & { id: string }) =>
      saveWritingDocument(queryClient, id, patch),
    onSuccess: (doc) => {
      if (doc.summaryPending) {
        return queryClient.invalidateQueries({ queryKey: writingKeys.project(doc.projectId) });
      }
    },
  });
}

export function useCreateWritingDocument(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: WritingDocumentKind; title?: string; afterId?: string | null }) =>
      mutate<WritingDocumentDetail>(`${BASE}/projects/${enc(projectId)}/documents`, 'POST', input),
    onSuccess: (doc) => {
      queryClient.setQueryData(writingKeys.document(doc.id), doc);
      void queryClient.invalidateQueries({ queryKey: writingKeys.projects });
      return queryClient.invalidateQueries({ queryKey: writingKeys.project(projectId) });
    },
  });
}

export function useDeleteWritingDocument(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => mutate(`${BASE}/documents/${enc(id)}`, 'DELETE'),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: writingKeys.document(id) });
      void queryClient.invalidateQueries({ queryKey: writingKeys.projects });
      return queryClient.invalidateQueries({ queryKey: writingKeys.project(projectId) });
    },
  });
}

export function useReorderWritingDocuments(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      mutate<WritingProjectDetail>(`${BASE}/projects/${enc(projectId)}/order`, 'PUT', { ids }),
    // 乐观：先按新顺序排好，失败再回滚
    onMutate: async (ids) => {
      await queryClient.cancelQueries({ queryKey: writingKeys.project(projectId) });
      const previous = queryClient.getQueryData<WritingProjectDetail>(
        writingKeys.project(projectId),
      );
      if (previous) {
        const rank = new Map(ids.map((id, index) => [id, index]));
        queryClient.setQueryData<WritingProjectDetail>(writingKeys.project(projectId), {
          ...previous,
          documents: previous.documents
            .map((doc) =>
              rank.has(doc.id) ? { ...doc, order: rank.get(doc.id) ?? doc.order } : doc,
            )
            .sort((a, b) =>
              a.kind === b.kind ? a.order - b.order : a.kind === 'chapter' ? -1 : 1,
            ),
        });
      }
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) {
        queryClient.setQueryData(writingKeys.project(projectId), context.previous);
      }
    },
    onSuccess: (data) => queryClient.setQueryData(writingKeys.project(projectId), data),
  });
}

/* ------------------------------------------------------------------ */
/* 版本                                                                  */
/* ------------------------------------------------------------------ */

export function useWritingVersions(docId: string | null) {
  return useQuery({
    queryKey: writingKeys.versions(docId ?? ''),
    queryFn: () =>
      fetchJson<WritingVersionSummary[]>(`${BASE}/documents/${enc(docId ?? '')}/versions`),
    enabled: docId !== null,
  });
}

export function useWritingVersion(docId: string | null, version: number | null) {
  return useQuery({
    queryKey: writingKeys.version(docId ?? '', version ?? -1),
    queryFn: () =>
      fetchJson<WritingVersionDetail>(
        `${BASE}/documents/${enc(docId ?? '')}/versions/${String(version ?? -1)}`,
      ),
    enabled: docId !== null && version !== null,
    staleTime: Infinity,
  });
}

/** 存一版；与上一版相同时服务端不写（`version: null`） */
export async function createWritingVersion(
  queryClient: QueryClient,
  docId: string,
  input: { label?: string; author?: 'user' | 'ai' } = {},
): Promise<number | null> {
  const result = await mutate<{ version: number | null }>(
    `${BASE}/documents/${enc(docId)}/versions`,
    'POST',
    input,
  );
  void queryClient.invalidateQueries({ queryKey: writingKeys.versions(docId) });
  return result.version;
}

export async function restoreWritingVersion(
  queryClient: QueryClient,
  docId: string,
  version: number,
): Promise<WritingDocumentDetail> {
  const result = await mutate<{ document: WritingDocumentDetail; savedVersion: number | null }>(
    `${BASE}/documents/${enc(docId)}/versions/${String(version)}/restore`,
    'POST',
  );
  queryClient.setQueryData(writingKeys.document(docId), result.document);
  patchProjectDocument(queryClient, result.document);
  void queryClient.invalidateQueries({ queryKey: writingKeys.versions(docId) });
  return result.document;
}

/* ------------------------------------------------------------------ */
/* 检查器与 AI                                                           */
/* ------------------------------------------------------------------ */

export function inspectWriting(
  projectId: string,
  body: WritingAiRequest & { docId: string },
): Promise<WritingInspectResponse> {
  return mutate<WritingInspectResponse>(`${BASE}/projects/${enc(projectId)}/inspect`, 'POST', body);
}

export class WritingAiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'WritingAiError';
    this.code = code;
    this.status = status;
  }
}

/**
 * 发起一次 AI 动作并逐个产出 SSE 事件。HTTP 错误（比如 400 no_connection）抛 `WritingAiError`；
 * 中途 abort 时生成器安静结束（已经产出的事件照常有效）。
 */
export async function* streamWritingAi(
  docId: string,
  body: WritingAiRequest,
  signal: AbortSignal,
): AsyncGenerator<WritingAiEvent> {
  let response: Response;
  try {
    response = await fetch(`${BASE}/documents/${enc(docId)}/ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
  if (!response.ok || !response.body) {
    let code = 'http';
    let message = `HTTP ${String(response.status)}`;
    try {
      const payload = (await response.json()) as { error?: unknown; message?: unknown };
      if (typeof payload.error === 'string') code = payload.error;
      if (typeof payload.message === 'string' && payload.message) message = payload.message;
    } catch {
      // 非 JSON 错误体
    }
    throw new WritingAiError(message, code, response.status);
  }
  try {
    for await (const message of parseSse(response.body)) {
      if (!message.event) continue;
      let data: unknown;
      try {
        data = JSON.parse(message.data);
      } catch {
        continue;
      }
      yield { type: message.event, data } as WritingAiEvent;
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  }
}

interface SseMessage {
  event: string | undefined;
  data: string;
}

function parseSseBlock(block: string): SseMessage | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0 && event === undefined) return null;
  return { event, data: dataLines.join('\n') };
}

/**
 * SSE 解析（跨 chunk 断句、CRLF、注释心跳）。与对话页的解析器同一写法；
 * 不从对话页引入，免得写作页的分块把对话页的依赖拖进来。
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const trailingCr = buffer.endsWith('\r');
      let work = trailingCr ? buffer.slice(0, -1) : buffer;
      work = work.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let index = work.indexOf('\n\n');
      while (index !== -1) {
        const message = parseSseBlock(work.slice(0, index));
        work = work.slice(index + 2);
        if (message) yield message;
        index = work.indexOf('\n\n');
      }
      buffer = trailingCr ? `${work}\r` : work;
    }
    const tail = parseSseBlock(buffer.replace(/\r\n?/g, '\n').trim());
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}
