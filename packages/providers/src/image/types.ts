import type { ProviderError, ProviderErrorKind } from '../types.js';

/**
 * 外接生图后端的统一接口。见 docs/M4-CONTRACT.md 第二部分 §D.1。
 *
 * 生图连接与对话连接共用 `connections` 表（Key 同样加密），但类型上单独一个
 * `ImageConnection`：对话侧的 `Connection.provider` 保持 `ProviderId`，
 * 不让 registry / 适配器的类型被生图后端污染（§E 修正）。
 */

export type ImageBackendId = 'image-sd' | 'image-comfy' | 'image-novelai' | 'image-openai';

export const IMAGE_BACKEND_IDS = [
  'image-sd',
  'image-comfy',
  'image-novelai',
  'image-openai',
] as const satisfies readonly ImageBackendId[];

export function isImageBackendId(value: unknown): value is ImageBackendId {
  return typeof value === 'string' && (IMAGE_BACKEND_IDS as readonly string[]).includes(value);
}

/** 各后端的默认 baseUrl（新建连接时留空就用它） */
export const IMAGE_DEFAULT_BASE_URLS: Record<ImageBackendId, string> = {
  'image-sd': 'http://127.0.0.1:7860',
  'image-comfy': 'http://127.0.0.1:8188',
  'image-novelai': 'https://image.novelai.net',
  'image-openai': 'https://api.openai.com/v1',
};

export interface ImageConnection {
  id: string;
  provider: ImageBackendId;
  label?: string;
  baseUrl: string;
  /**
   * 解密后的 Key（轮换由服务端解析）。SD WebUI 开了 `--api-auth` 时写成 `user:pass`，
   * 按 Basic 认证发送；其余后端按 Bearer。
   */
  apiKey?: string;
  headers?: Record<string, string>;
  /** 同对话连接：目前只存储，不做转发 */
  proxy?: string;
}

export interface ImageGenParams {
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  seed?: number;
  model?: string;
  /** ComfyUI：工作流 JSON（API 格式），占位 %prompt% %negative% %seed% %width% %height% %steps% %cfg% %model% */
  workflow?: Record<string, unknown>;
}

export interface GeneratedImage {
  mime: string;
  /** 不带 data: 前缀的 base64 */
  data: string;
}

export interface ImageGenResult {
  images: GeneratedImage[];
  seed?: number;
}

export interface ImageBackend {
  id: ImageBackendId;
  listModels(conn: ImageConnection): Promise<{ id: string; name?: string }[]>;
  generate(
    conn: ImageConnection,
    p: ImageGenParams,
    signal: AbortSignal,
    onProgress?: (fraction: number) => void,
  ): Promise<ImageGenResult>;
}

/**
 * 生图后端的归一化错误：本身就是 `ProviderError` 的形状（kind / message / status / retryable），
 * 同时是 Error，可以直接 throw。中止不包成它——原样抛 AbortError，调用方用 `isAbortError` 判断。
 */
export class ImageBackendError extends Error implements ProviderError {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryable: boolean;
  readonly detail?: unknown;

  constructor(error: ProviderError) {
    super(error.message);
    this.name = 'ImageBackendError';
    this.kind = error.kind;
    if (error.status !== undefined) this.status = error.status;
    this.retryable = error.retryable;
    if (error.detail !== undefined) this.detail = error.detail;
  }

  toJSON(): ProviderError {
    return {
      kind: this.kind,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
      retryable: this.retryable,
    };
  }
}
