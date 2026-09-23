import { isAbortError, isRetryableKind, normalizeUnknownError } from '../errors.js';
import { HttpError } from '../http.js';
import type { ProviderErrorKind } from '../types.js';
import { ImageBackendError, type ImageConnection } from './types.js';

/**
 * 生图后端共用的小工具：请求、错误归一化、轮询等待、图片嗅探、zip 解包。
 * 只用全局 fetch / DecompressionStream，不引入运行时依赖。
 */

/** 去掉 baseUrl 结尾的斜杠 */
export function baseOf(conn: ImageConnection): string {
  return conn.baseUrl.replace(/\/+$/, '');
}

/** 发请求：合并 `conn.headers`（调用方给的优先），非 2xx 读 body 后抛 HttpError */
export async function imageFetch(
  conn: ImageConnection,
  url: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown },
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { ...conn.headers, ...init.headers };
  let body: string | undefined;
  if (init.body !== undefined) {
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    headers['content-type'] ??= 'application/json';
  }
  const res = await fetch(url, { method: init.method ?? 'GET', headers, body, signal });
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    const record: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      record[k] = v;
    });
    throw new HttpError(res.status, text, record);
  }
  return res;
}

export async function imageGetJson(
  conn: ImageConnection,
  url: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await imageFetch(conn, url, { headers }, signal);
  return (await res.json()) as unknown;
}

/** Bearer（有 Key 时） */
export function bearer(conn: ImageConnection): Record<string, string> {
  return conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {};
}

/**
 * 任意异常 → ImageBackendError；中止原样抛出（调用方要区分「用户取消」与「失败」）。
 * `prefix` 用来在消息前标注后端名，便于用户看出是哪一层出的错。
 */
export function toImageError(e: unknown, prefix?: string): Error {
  if (isAbortError(e)) return e as Error;
  if (e instanceof ImageBackendError) return e;
  const normalized = normalizeUnknownError(e);
  if (e instanceof HttpError) {
    const extra = describeImageErrorBody(e.body);
    if (extra.message && (!normalized.message || /^HTTP \d+$/.test(normalized.message))) {
      normalized.message = extra.message;
    }
    if (extra.filter) {
      normalized.kind = 'filter';
      normalized.retryable = false;
    }
  }
  // fetch 连不上（ECONNREFUSED 等）：Node 的消息是 "fetch failed"，补一句人话
  let message = normalized.message;
  if (normalized.kind === 'network' && /fetch failed/i.test(message)) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    message = `无法连接到生图后端${cause?.code ? `（${cause.code}）` : ''}`;
  }
  return new ImageBackendError({
    ...normalized,
    message: prefix ? `${prefix}：${message}` : message,
  });
}

/**
 * 生图后端特有的错误体：SD WebUI（FastAPI）是 `{ error, detail, errors }`，
 * `detail` 也可能是校验错误数组；OpenAI 的安全拦截是 `code: 'content_policy_violation'`。
 */
export function describeImageErrorBody(body: string): { message?: string; filter: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { filter: false };
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const nested = (
    typeof root.error === 'object' && root.error !== null ? root.error : {}
  ) as Record<string, unknown>;
  const filter =
    nested.code === 'content_policy_violation' ||
    root.code === 'content_policy_violation' ||
    nested.type === 'content_filter';
  const pieces: string[] = [];
  if (typeof root.error === 'string') pieces.push(root.error);
  if (typeof root.detail === 'string') pieces.push(root.detail);
  else if (Array.isArray(root.detail)) {
    for (const item of root.detail) {
      const msg = (item as { msg?: unknown; loc?: unknown }).msg;
      const loc = (item as { loc?: unknown }).loc;
      if (typeof msg === 'string') {
        pieces.push(Array.isArray(loc) ? `${loc.join('.')}: ${msg}` : msg);
      }
    }
  }
  if (typeof root.errors === 'string' && root.errors !== root.detail) pieces.push(root.errors);
  return { ...(pieces.length > 0 ? { message: pieces.join('：') } : {}), filter };
}

export function imageError(
  kind: ProviderErrorKind,
  message: string,
  detail?: unknown,
): ImageBackendError {
  return new ImageBackendError({
    kind,
    message,
    retryable: isRetryableKind(kind),
    ...(detail === undefined ? {} : { detail }),
  });
}

/** 可中止的等待 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 中止原因统一成 AbortError（`controller.abort()` 不带参数时 reason 已经是它） */
export function abortErrorOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (isAbortError(reason)) return reason as Error;
  return new DOMException('Aborted', 'AbortError');
}

/** 把 `data:image/png;base64,` 前缀去掉（有的 SD 分支会带上） */
export function stripDataUrl(value: string): { data: string; mime?: string } {
  const match = /^data:([^;,]+)?(?:;[^,]*)?,/.exec(value);
  if (!match) return { data: value };
  return { data: value.slice(match[0].length), ...(match[1] ? { mime: match[1] } : {}) };
}

export function base64ToBytes(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, 'base64'));
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/** 按文件头判断图片类型；认不出返回 fallback */
export function sniffImageMime(bytes: Uint8Array, fallback = 'image/png'): string {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return 'image/webp';
  }
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return 'image/gif';
  return fallback;
}

/** base64 图片 → `{ mime, data }`（mime 以文件头为准） */
export function imageFromBase64(value: string, declared?: string): { mime: string; data: string } {
  const stripped = stripDataUrl(value.trim());
  const head = base64ToBytes(stripped.data.slice(0, 32));
  return {
    mime: sniffImageMime(head, stripped.mime ?? declared ?? 'image/png'),
    data: stripped.data,
  };
}

/** 随机种子：32 位非负整数（各后端都接受） */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff);
}

/* ------------------------------------------------------------------ */
/* zip：只读，只支持 stored / deflate（NovelAI 返回的就是这两种）          */
/* ------------------------------------------------------------------ */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** 读中央目录（从末尾找 EOCD） */
export function listZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  // EOCD 至少 22 字节，最多再跟 65535 字节注释
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到目录结尾）');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new Error('zip 目录损坏');
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 取出一个条目的内容 */
export async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (view.getUint32(at, true) !== 0x04034b50) throw new Error('zip 条目头损坏');
  const nameLength = view.getUint16(at + 26, true);
  const extraLength = view.getUint16(at + 28, true);
  const start = at + 30 + nameLength + extraLength;
  const raw = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return raw.slice();
  if (entry.method === 8) return inflateRaw(raw);
  throw new Error(`不支持的 zip 压缩方式：${entry.method}`);
}

/** 第一个匹配扩展名的条目（NovelAI：image_0.png） */
export async function extractFirstFromZip(
  bytes: Uint8Array,
  extensions: readonly string[],
): Promise<{ name: string; bytes: Uint8Array } | null> {
  const entries = listZipEntries(bytes);
  const entry = entries.find((item) =>
    extensions.some((ext) => item.name.toLowerCase().endsWith(ext)),
  );
  if (!entry) return null;
  return { name: entry.name, bytes: await readZipEntry(bytes, entry) };
}
