import path from 'node:path';

import type { Part, PromptIR } from '@newtavern/core';
import { classifyDocumentMime, type ResolvedAsset } from '@newtavern/providers';
import type * as UnpdfModule from 'unpdf';

import type { AssetRow, AssetsService } from './assets.js';

/**
 * 多模态服务端的共用逻辑（docs/M4-CONTRACT.md §3.3）：
 * 上传判定、PDF 文本抽取、附件 → parts、发请求时的资产解析器。
 * 组装前内联见 `media-inline.ts`，清理见 `media-gc.ts`。
 */

/** 单个上传文件上限 */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** PDF 抽取文本存进 `assets.meta.text` 的上限（字符） */
export const PDF_TEXT_LIMIT = 500_000;
/** PDF 抽取的时间上限：超时按「抽取失败」处理（不报错，`meta.text` 为空） */
const PDF_EXTRACT_TIMEOUT_MS = 30_000;

/** 文本类附件：只认扩展名（内容必须能按 UTF-8 解码）。mime 须落在 `text/*` 或 `application/json`，内联判定才认得 */
const TEXT_EXTENSIONS: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'text/xml',
  '.html': 'text/html',
};

export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

/** 给前端 `accept` 用的清单（与判定规则同源） */
export const UPLOAD_ACCEPT = [...IMAGE_MIMES, 'application/pdf', ...Object.keys(TEXT_EXTENSIONS)];

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

/** 按文件头识别图片类型，不信任客户端给的 content-type / 扩展名 */
export function sniffImageMime(bytes: Uint8Array): ImageMime | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return 'image/webp';
  }
  // GIF87a / GIF89a
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) && (bytes[4] === 0x37 || bytes[4] === 0x39)) {
    if (bytes[5] === 0x61) return 'image/gif';
  }
  return null;
}

/** `%PDF-`：规范允许出现在前 1024 字节内（前面可能有垃圾字节） */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i <= limit; i += 1) {
    if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d], i)) return true;
  }
  return false;
}

/** 严格 UTF-8 解码（去 BOM）；不是合法 UTF-8 或含 NUL 时返回 undefined */
export function decodeUtf8Text(bytes: Uint8Array): string | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
  if (text.includes(String.fromCharCode(0))) return undefined;
  return text;
}

export type UploadClass =
  | { category: 'image'; mime: ImageMime }
  | { category: 'pdf'; mime: 'application/pdf' }
  | { category: 'text'; mime: string; text: string };

/**
 * 上传判定：图片与 PDF 看魔数（与扩展名无关），文本类看扩展名 + 能否按 UTF-8 解码。
 * 其余返回 null（路由回 415）。
 */
export function classifyUpload(bytes: Uint8Array, fileName: string): UploadClass | null {
  const image = sniffImageMime(bytes);
  if (image) return { category: 'image', mime: image };
  if (looksLikePdf(bytes)) return { category: 'pdf', mime: 'application/pdf' };
  const mime = TEXT_EXTENSIONS[path.extname(fileName).toLowerCase()];
  if (!mime) return null;
  const text = decodeUtf8Text(bytes);
  if (text === undefined) return null;
  return { category: 'text', mime, text };
}

/** unpdf 是可选依赖：装不上 / 加载失败时返回 null，调用方按「抽取失败」处理 */
type Unpdf = typeof UnpdfModule;
let unpdfPromise: Promise<Unpdf | null> | null = null;
function loadUnpdf(): Promise<Unpdf | null> {
  unpdfPromise ??= import('unpdf').catch(() => null);
  return unpdfPromise;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

/**
 * 抽取 PDF 文本（逐页，页间空一行，截断到 {@link PDF_TEXT_LIMIT}）。
 * 失败（加密、损坏、依赖缺失、超时）一律返回 undefined，不抛。
 */
export async function extractPdfText(
  bytes: Uint8Array,
): Promise<{ text: string; pages: number } | undefined> {
  const unpdf = await loadUnpdf();
  if (!unpdf) return undefined;
  const run = async () => {
    // pdf.js 会转移（detach）传入的 ArrayBuffer：给它一份拷贝，原字节还要落盘
    const pdf = await unpdf.getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
    try {
      const { totalPages, text } = await unpdf.extractText(pdf, { mergePages: false });
      const joined = text
        .map((page) => page.trim())
        .filter((page) => page !== '')
        .join('\n\n');
      return { text: joined.slice(0, PDF_TEXT_LIMIT), pages: totalPages };
    } finally {
      // 释放 worker 侧资源（loadingTask.destroy 会连带销毁文档）
      void pdf.loadingTask.destroy().catch(() => undefined);
    }
  };
  return withTimeout(run(), PDF_EXTRACT_TIMEOUT_MS);
}

function metaString(asset: AssetRow, key: string): string | undefined {
  const value = asset.meta?.[key];
  return typeof value === 'string' ? value : undefined;
}

export function assetName(asset: AssetRow): string | undefined {
  return metaString(asset, 'name');
}

/** 能作附件的资产 → part 类型；不能作附件（例如 mime 不认识）时返回 null */
export function attachmentPartOf(asset: AssetRow, nameOverride?: string): Part | null {
  const name = nameOverride ?? assetName(asset);
  const named = name ? { name } : {};
  if ((IMAGE_MIMES as readonly string[]).includes(asset.mime)) {
    return { type: 'image', assetId: asset.id, mime: asset.mime, ...named };
  }
  const cls = classifyDocumentMime(asset.mime);
  if (cls === 'pdf' || cls === 'text') {
    return { type: 'document', assetId: asset.id, mime: asset.mime, ...named };
  }
  return null;
}

export class AttachmentError extends Error {}

/**
 * 请求体里的 `attachments` → 媒体 parts（按传入顺序）。
 * 元素是 assetId 字符串；也接受 `{ id, name? }`（同一文件换名重传时，名字以这次为准）。
 * 缺省 / null → 空数组；形状不对、资产不存在、类型不能作附件 → 抛 {@link AttachmentError}。
 */
export function parseAttachments(assets: AssetsService, raw: unknown): Part[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new AttachmentError('attachments 须为数组');
  return raw.map((item) => {
    let id: unknown = item;
    let name: string | undefined;
    if (typeof item === 'object' && item !== null) {
      const obj = item as { id?: unknown; assetId?: unknown; name?: unknown };
      id = obj.id ?? obj.assetId;
      if (typeof obj.name === 'string' && obj.name.trim() !== '') name = obj.name;
    }
    if (typeof id !== 'string' || id === '') throw new AttachmentError('attachments 元素非法');
    const asset = assets.getById(id);
    if (!asset) throw new AttachmentError(`附件不存在：${id}`);
    const part = attachmentPartOf(asset, name);
    if (!part) throw new AttachmentError(`该文件类型不能作为附件：${asset.mime}`);
    return part;
  });
}

export function isMediaPart(part: Part): part is Extract<Part, { type: 'image' | 'document' }> {
  return part.type === 'image' || part.type === 'document';
}

/**
 * 有媒体时去掉空文本 part：只有附件、没写字的消息不带 `{ type:'text', text:'' }`
 * （Anthropic 会拒绝空文本块）。没有媒体时保持原样（空消息照旧是一个空文本 part）。
 */
export function compactMediaParts(parts: Part[]): Part[] {
  if (!parts.some(isMediaPart)) return parts;
  return parts.filter((part) => part.type !== 'text' || part.text !== '');
}

/** 新消息的 parts：`[text, ...媒体]`；文本为空且有附件时不放文本 part */
export function messageParts(text: string, media: Part[]): Part[] {
  return compactMediaParts([{ type: 'text', text }, ...media]);
}

/** IR 里引用到的全部资产 id（image / document part） */
export function collectAssetIds(ir: PromptIR): Set<string> {
  const ids = new Set<string>();
  for (const segment of ir.segments) {
    for (const part of segment.parts) {
      if (isMediaPart(part)) ids.add(part.assetId);
    }
  }
  return ids;
}

/**
 * 发请求用的资产解析器：只解析 IR 里出现过的 id，首次用到时读文件并缓存（同一轮重试复用）。
 * 行不存在或文件丢失 → undefined（适配器丢弃并告警「找不到资产」）。
 */
export function createAssetResolver(
  assets: AssetsService,
  ir: PromptIR,
): (assetId: string) => ResolvedAsset | undefined {
  const allowed = collectAssetIds(ir);
  const cache = new Map<string, ResolvedAsset | undefined>();
  return (assetId) => {
    if (!allowed.has(assetId)) return undefined;
    if (cache.has(assetId)) return cache.get(assetId);
    const row = assets.getById(assetId);
    const bytes = row ? assets.readBytes(row) : undefined;
    const resolved =
      row && bytes
        ? {
            mime: row.mime,
            base64: bytes.toString('base64'),
            ...(assetName(row) ? { name: assetName(row) } : {}),
          }
        : undefined;
    cache.set(assetId, resolved);
    return resolved;
  };
}

/**
 * 模型输出图片的 mime：以文件头为准；认不出时只接受事件里声明的 PNG / JPEG / WebP / GIF
 * （SVG 之类能执行脚本的格式不落库，免得从资产端点同源打开）。
 */
export function generatedImageMime(bytes: Uint8Array, declared: string): ImageMime | null {
  const sniffed = sniffImageMime(bytes);
  if (sniffed) return sniffed;
  const base = (declared.split(';')[0] ?? '').trim().toLowerCase();
  return (IMAGE_MIMES as readonly string[]).includes(base) ? (base as ImageMime) : null;
}
