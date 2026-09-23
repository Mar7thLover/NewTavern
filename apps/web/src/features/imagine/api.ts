import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { parseSseStream } from '../chat/useGeneration';
import {
  fetchJson,
  mutate,
  queryKeys,
  useSetSetting,
  useSetting,
  type ChatSummary,
  type ConnectionSummary,
  type MessageNode,
} from '../../lib/api';

/**
 * 外接生图的前端数据层（docs/M4-CONTRACT.md 第二部分 §D.3）：
 * 生图连接、设置 KV `imageGen`、`POST /api/chats/:id/imagine` 的 SSE 客户端、`GET /api/jobs/:id`。
 */

export type ImageBackendId = 'image-sd' | 'image-comfy' | 'image-novelai' | 'image-openai';

export const IMAGE_BACKEND_IDS: ImageBackendId[] = [
  'image-sd',
  'image-comfy',
  'image-novelai',
  'image-openai',
];

export const IMAGE_DEFAULT_BASE_URLS: Record<ImageBackendId, string> = {
  'image-sd': 'http://127.0.0.1:7860',
  'image-comfy': 'http://127.0.0.1:8188',
  'image-novelai': 'https://image.novelai.net',
  'image-openai': 'https://api.openai.com/v1',
};

export function isImageBackendId(value: unknown): value is ImageBackendId {
  return typeof value === 'string' && (IMAGE_BACKEND_IDS as string[]).includes(value);
}

export interface ImageConnectionSummary extends Omit<ConnectionSummary, 'provider'> {
  provider: ImageBackendId;
}

export interface ImageConnectionInput {
  provider: ImageBackendId;
  label: string;
  baseUrl?: string;
  apiKeys?: string[];
  headers?: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* 连接：与对话连接同一个查询（同一个缓存），用 select 挑出生图后端          */
/* ------------------------------------------------------------------ */

function selectImageConnections(rows: ConnectionSummary[]): ImageConnectionSummary[] {
  return rows.filter((row) =>
    isImageBackendId(row.provider),
  ) as unknown as ImageConnectionSummary[];
}

export function useImageConnections() {
  return useQuery({
    queryKey: queryKeys.connections,
    queryFn: () => fetchJson<ConnectionSummary[]>('/api/connections'),
    select: selectImageConnections,
  });
}

export function useSaveImageConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: ImageConnectionInput & { id?: string }) =>
      id
        ? mutate<ImageConnectionSummary>(`/api/connections/${encodeURIComponent(id)}`, 'PUT', input)
        : mutate<ImageConnectionSummary>('/api/connections', 'POST', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.connections }),
  });
}

/* ------------------------------------------------------------------ */
/* 设置 KV `imageGen`                                                   */
/* ------------------------------------------------------------------ */

export interface ImageGenDefaults {
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  negative: string;
}

export interface ImageGenSettings {
  connectionId: string | null;
  model?: string;
  defaults: ImageGenDefaults;
  promptWriter?: { connectionId: string; model: string };
  comfyWorkflow?: Record<string, unknown>;
  stylePrefix?: string;
}

export const DEFAULT_IMAGE_GEN_DEFAULTS: ImageGenDefaults = {
  width: 512,
  height: 768,
  steps: 28,
  cfg: 7,
  sampler: '',
  negative: '',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const numberOr = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

export function normalizeImageGenSettings(value: unknown): ImageGenSettings {
  const raw = isRecord(value) ? value : {};
  const defaults = isRecord(raw.defaults) ? raw.defaults : {};
  const writer = isRecord(raw.promptWriter) ? raw.promptWriter : null;
  return {
    connectionId:
      typeof raw.connectionId === 'string' && raw.connectionId ? raw.connectionId : null,
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
    defaults: {
      width: numberOr(defaults.width, DEFAULT_IMAGE_GEN_DEFAULTS.width),
      height: numberOr(defaults.height, DEFAULT_IMAGE_GEN_DEFAULTS.height),
      steps: numberOr(defaults.steps, DEFAULT_IMAGE_GEN_DEFAULTS.steps),
      cfg: numberOr(defaults.cfg, DEFAULT_IMAGE_GEN_DEFAULTS.cfg),
      sampler: typeof defaults.sampler === 'string' ? defaults.sampler : '',
      negative: typeof defaults.negative === 'string' ? defaults.negative : '',
    },
    ...(writer && typeof writer.connectionId === 'string' && typeof writer.model === 'string'
      ? { promptWriter: { connectionId: writer.connectionId, model: writer.model } }
      : {}),
    ...(isRecord(raw.comfyWorkflow) ? { comfyWorkflow: raw.comfyWorkflow } : {}),
    ...(typeof raw.stylePrefix === 'string' && raw.stylePrefix
      ? { stylePrefix: raw.stylePrefix }
      : {}),
  };
}

export const IMAGE_GEN_KEY = 'imageGen';
export const useImageGenSettings = () => useSetting(IMAGE_GEN_KEY, normalizeImageGenSettings);
export const useSetImageGenSettings = () => useSetSetting(IMAGE_GEN_KEY, normalizeImageGenSettings);

/* ------------------------------------------------------------------ */
/* imagine SSE                                                          */
/* ------------------------------------------------------------------ */

export type ImagineMode = 'free' | 'last_message' | 'character';

export interface ImagineBody {
  mode?: ImagineMode;
  prompt?: string;
  negative?: string;
  width?: number;
  height?: number;
  parentId?: string | null;
  redrawOf?: string;
  attach?: boolean;
  lang?: 'zh-CN' | 'en';
}

export type JobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ImagineHandlers {
  onJob?: (job: { id: string; status: JobStatus }) => void;
  onPrompt?: (text: string) => void;
  onProgress?: (fraction: number) => void;
  onNode?: (node: MessageNode, chat: ChatSummary) => void;
  onAsset?: (asset: { assetId: string; mime: string; url: string }) => void;
}

export class ImagineError extends Error {
  readonly kind: string;
  constructor(message: string, kind: string) {
    super(message);
    this.name = 'ImagineError';
    this.kind = kind;
  }
}

export interface ImagineResult {
  jobId: string | null;
  node?: MessageNode;
  chat?: ChatSummary;
  assetIds: string[];
  prompt: string | null;
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * 发起一次生图并消费 SSE；成功返回结果，失败抛 ImagineError（取消时 kind='abort'）。
 * 开流前的 4xx（没选后端、没有角色…）同样抛 ImagineError，kind 取服务端的 error 码。
 */
export async function runImagine(
  chatId: string,
  body: ImagineBody,
  handlers: ImagineHandlers = {},
  signal?: AbortSignal,
): Promise<ImagineResult> {
  let res: Response;
  try {
    res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/imagine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if ((error as { name?: string }).name === 'AbortError')
      throw new ImagineError('已取消', 'abort');
    throw new ImagineError((error as Error).message, 'network');
  }
  if (!res.ok || !res.body) {
    let code = 'invalid';
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: unknown; message?: unknown };
      if (typeof data.error === 'string') code = data.error;
      if (typeof data.message === 'string' && data.message) message = data.message;
    } catch {
      // 非 JSON
    }
    throw new ImagineError(message, code);
  }

  const result: ImagineResult = { jobId: null, assetIds: [], prompt: null };
  try {
    for await (const message of parseSseStream(res.body)) {
      const data = parseJson<Record<string, unknown>>(message.data) ?? {};
      switch (message.event) {
        case 'job': {
          const job = { id: String(data.id ?? ''), status: data.status as JobStatus };
          result.jobId = job.id;
          handlers.onJob?.(job);
          break;
        }
        case 'prompt':
          result.prompt = typeof data.text === 'string' ? data.text : null;
          if (result.prompt !== null) handlers.onPrompt?.(result.prompt);
          break;
        case 'progress':
          if (typeof data.fraction === 'number') handlers.onProgress?.(data.fraction);
          break;
        case 'node': {
          const node = data.node as MessageNode;
          const chat = data.chat as ChatSummary;
          result.node = node;
          result.chat = chat;
          handlers.onNode?.(node, chat);
          break;
        }
        case 'asset': {
          const asset = data as { assetId: string; mime: string; url: string };
          result.assetIds.push(asset.assetId);
          handlers.onAsset?.(asset);
          break;
        }
        case 'error':
          throw new ImagineError(
            typeof data.message === 'string' ? data.message : '生图失败',
            typeof data.kind === 'string' ? data.kind : 'invalid',
          );
        case 'done':
          if (Array.isArray(data.assetIds)) {
            result.assetIds = data.assetIds.filter((id): id is string => typeof id === 'string');
          }
          break;
        default:
          break;
      }
    }
  } catch (error) {
    if (error instanceof ImagineError) throw error;
    if (signal?.aborted || (error as { name?: string }).name === 'AbortError') {
      throw new ImagineError('已取消', 'abort');
    }
    throw new ImagineError((error as Error).message, 'network');
  }
  if (signal?.aborted) throw new ImagineError('已取消', 'abort');
  return result;
}

/** `GET /api/jobs/:id` */
export interface JobView {
  id: string;
  kind: string;
  status: JobStatus;
  progress: number | null;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
}

export function fetchJob(id: string): Promise<JobView> {
  return fetchJson<JobView>(`/api/jobs/${encodeURIComponent(id)}`);
}

/* ------------------------------------------------------------------ */
/* 前端卡原生 API：`newtavern.generateImage()`（RPC `image.generate`）   */
/* ------------------------------------------------------------------ */

export interface CardImageRequest {
  prompt: string;
  negative?: string;
  width?: number;
  height?: number;
}

/**
 * 只生成并存资产、不写消息树（服务端 `attach:false`）。
 * 返回绝对地址：卡在沙箱 iframe 里，相对路径的解析基准不可靠。
 */
export async function cardGenerateImage(
  chatId: string,
  params: unknown,
  signal?: AbortSignal,
): Promise<{ assetUrl: string; assetId: string; prompt: string | null }> {
  const record = (isRecord(params) ? params : {}) as Partial<CardImageRequest>;
  const prompt = typeof record.prompt === 'string' ? record.prompt.trim() : '';
  if (prompt === '') throw new Error('generateImage 需要非空的 prompt');
  const size = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
  const width = size(record.width);
  const height = size(record.height);
  const result = await runImagine(
    chatId,
    {
      mode: 'free',
      prompt,
      attach: false,
      ...(typeof record.negative === 'string' ? { negative: record.negative } : {}),
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
    },
    {},
    signal,
  );
  const assetId = result.assetIds[0];
  if (!assetId) throw new Error('生图后端没有返回图片');
  const path = `/api/assets/${encodeURIComponent(assetId)}/file`;
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  return { assetUrl: new URL(path, origin).href, assetId, prompt: result.prompt };
}
