import type { Part } from '@newtavern/core';

import type { BuildOptions, ModelCapabilities, ResolvedAsset } from './types.js';

/**
 * 多模态（image / document part）渲染的共用逻辑与请求体脱敏。见 docs/M4-CONTRACT.md §3.1 / §3.2。
 *
 * 各适配器只关心「这一块最终长什么样」，丢弃规则（能力、角色、资产缺失）与告警文案统一在这里：
 * - caps.imageIn 为 false：丢弃全部图片，汇总告警「模型不支持图片输入，已丢弃 N 张图片」；
 * - caps.documentIn 为 false：丢弃全部 PDF，汇总告警；
 * - 该角色的消息不接受媒体（例如 OpenAI 的 assistant 消息）：丢弃并按角色汇总告警；
 * - 没有 resolver（检查器预览、黄金测试）：渲染为 `asset:<id>` 占位，不告警；
 * - resolver 返回 undefined：丢弃并告警「找不到资产 <id>」；
 * - 文本类文档本应由服务端组装前内联；万一到达，解码为文本块。
 */

export type MediaPart = Extract<Part, { type: 'image' | 'document' }>;

export function isMediaPart(part: Part): part is MediaPart {
  return part.type === 'image' || part.type === 'document';
}

/**
 * 只有媒体、且媒体全被丢弃的消息，渲染后内容为空（Anthropic / Gemini 会 400）。
 * 照 ST `convertClaudeMessages` 对空文本的做法，用零宽空格占位。
 */
export const EMPTY_TEXT_PLACEHOLDER = '​';

/** 文档 mime 的三类：PDF、文本类（text/*、application/json）、其他（不支持） */
export type DocumentClass = 'pdf' | 'text' | 'other';

export function classifyDocumentMime(mime: string): DocumentClass {
  const base = (mime.split(';')[0] ?? '').trim().toLowerCase();
  if (base === 'application/pdf') return 'pdf';
  if (base.startsWith('text/') || base === 'application/json') return 'text';
  return 'other';
}

export function toDataUrl(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

/** 占位 URL：没有 resolver 时使用 */
export function assetPlaceholder(assetId: string): string {
  return `asset:${assetId}`;
}

const DATA_URL_RE = /^data:([^;,]+)((?:;[^;,]*)*);base64,(.*)$/is;

/** 解析 `data:<mime>;base64,<data>`；不是 base64 data URL 时返回 undefined */
export function parseDataUrl(url: string): { mime: string; base64: string } | undefined {
  const m = DATA_URL_RE.exec(url.trim());
  if (!m?.[1] || m[3] === undefined) return undefined;
  return { mime: m[1].toLowerCase(), base64: m[3] };
}

/** base64 → UTF-8 文本；非法 base64 返回 undefined */
export function decodeBase64Utf8(base64: string): string | undefined {
  try {
    const binary = atob(base64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return undefined;
  }
}

/** 媒体块的来源：内联数据，或预览用的占位 URL */
export type MediaSource =
  { type: 'inline'; base64: string; dataUrl: string } | { type: 'placeholder'; url: string };

export type RenderedMedia =
  | { kind: 'image'; mime: string; source: MediaSource }
  | { kind: 'pdf'; mime: string; filename: string; source: MediaSource }
  | { kind: 'text'; text: string };

/** 取来源里可以直接放进 URL 字段的串（data URL 或 `asset:<id>`） */
export function sourceUrl(source: MediaSource): string {
  return source.type === 'inline' ? source.dataUrl : source.url;
}

export interface MediaRoleContext {
  /** 该角色的消息能否带图片 / PDF */
  accepts: boolean;
  /** 告警里展示的角色名（assistant / system / systemInstruction …） */
  role: string;
}

export interface MediaRendererOptions {
  caps: ModelCapabilities;
  resolveAsset?: BuildOptions['resolveAsset'];
  /** 适配器名，用于告警文案（「OpenAI Chat」「Anthropic」…） */
  label: string;
  /** 告警写入的数组（与 ProviderRequest.warnings 共用） */
  warnings: string[];
}

export interface MediaRenderer {
  /** 解析一个 image / document part；返回 undefined 表示已丢弃（告警已记录或已计数） */
  render(part: MediaPart, role: MediaRoleContext): RenderedMedia | undefined;
  /** 把累计的丢弃计数写成汇总告警；每次 buildRequest 末尾调用一次 */
  flush(): void;
}

export function createMediaRenderer(opts: MediaRendererOptions): MediaRenderer {
  const { caps, resolveAsset, label, warnings } = opts;
  let imagesUnsupported = 0;
  let pdfsUnsupported = 0;
  /** 角色 → 被拒的媒体数（保持首次出现顺序） */
  const roleDropped = new Map<string, number>();

  function resolve(assetId: string): ResolvedAsset | undefined {
    const asset = resolveAsset?.(assetId);
    if (asset === undefined) warnings.push(`找不到资产 ${assetId}，已丢弃`);
    return asset;
  }

  function source(asset: ResolvedAsset, mime: string): MediaSource {
    return { type: 'inline', base64: asset.base64, dataUrl: toDataUrl(mime, asset.base64) };
  }

  function rejectRole(role: MediaRoleContext): void {
    roleDropped.set(role.role, (roleDropped.get(role.role) ?? 0) + 1);
  }

  function renderImage(part: MediaPart, role: MediaRoleContext): RenderedMedia | undefined {
    if (!caps.imageIn) {
      imagesUnsupported += 1;
      return undefined;
    }
    if (!role.accepts) {
      rejectRole(role);
      return undefined;
    }
    if (!resolveAsset) {
      return {
        kind: 'image',
        mime: part.mime,
        source: { type: 'placeholder', url: assetPlaceholder(part.assetId) },
      };
    }
    const asset = resolve(part.assetId);
    if (!asset) return undefined;
    const mime = asset.mime || part.mime;
    return { kind: 'image', mime, source: source(asset, mime) };
  }

  function renderDocument(part: MediaPart, role: MediaRoleContext): RenderedMedia | undefined {
    const cls = classifyDocumentMime(part.mime);
    if (cls === 'text') {
      // 文本类文档应由服务端在组装前内联（§3.3）；到达这里就按文本块兜底
      if (!resolveAsset) return { kind: 'text', text: assetPlaceholder(part.assetId) };
      const asset = resolve(part.assetId);
      if (!asset) return undefined;
      const text = decodeBase64Utf8(asset.base64);
      if (text === undefined) {
        warnings.push(`文档 ${part.assetId} 无法按 UTF-8 文本解码，已丢弃`);
        return undefined;
      }
      return { kind: 'text', text };
    }
    if (cls === 'other') {
      warnings.push(`不支持的文档类型 ${part.mime}，已丢弃 ${part.assetId}`);
      return undefined;
    }
    if (!caps.documentIn) {
      pdfsUnsupported += 1;
      return undefined;
    }
    if (!role.accepts) {
      rejectRole(role);
      return undefined;
    }
    const fallbackName = `${part.assetId}.pdf`;
    if (!resolveAsset) {
      return {
        kind: 'pdf',
        mime: 'application/pdf',
        filename: part.name ?? fallbackName,
        source: { type: 'placeholder', url: assetPlaceholder(part.assetId) },
      };
    }
    const asset = resolve(part.assetId);
    if (!asset) return undefined;
    const mime = 'application/pdf';
    return {
      kind: 'pdf',
      mime,
      filename: asset.name ?? part.name ?? fallbackName,
      source: source(asset, mime),
    };
  }

  return {
    render(part, role) {
      return part.type === 'image' ? renderImage(part, role) : renderDocument(part, role);
    },
    flush() {
      if (imagesUnsupported > 0) {
        warnings.push(`模型不支持图片输入，已丢弃 ${imagesUnsupported} 张图片`);
      }
      if (pdfsUnsupported > 0) {
        warnings.push(`模型不支持 PDF 输入，已丢弃 ${pdfsUnsupported} 个 PDF`);
      }
      for (const [role, count] of roleDropped) {
        warnings.push(`${label} 的 ${role} 消息不接受图片 / PDF，已丢弃 ${count} 个`);
      }
      imagesUnsupported = 0;
      pdfsUnsupported = 0;
      roleDropped.clear();
    },
  };
}

/**
 * imageOutput 的生效值：显式 true / false 优先，undefined 时按 `defaultOn`。
 * 显式开启而目录没有标注 imageOut 时仍然开启（用户说了算），但记一条告警。
 */
export function resolveImageOutput(
  opts: BuildOptions | undefined,
  caps: ModelCapabilities,
  defaultOn: boolean,
  model: string,
  warnings: string[],
): boolean {
  const explicit = opts?.imageOutput;
  if (explicit === undefined) return defaultOn;
  if (explicit && !caps.imageOut) {
    warnings.push(`目录没有标注 ${model} 支持图片输出，仍按请求开启`);
  }
  return explicit;
}

// ─────────────────────────────── 脱敏 ───────────────────────────────

/** 长 base64 的阈值（字符数，严格大于才替换） */
const LONG_BASE64_MIN = 512;
const LONG_BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;
/** 字符串内任意位置的 base64 data URL（mime 参数如 `;name=x` 一并吞掉） */
const INLINE_DATA_URL_RE =
  /data:([\w.+-]+\/[\w.+-]+)((?:;[\w.+-]+(?:=[^;,\s]*)?)*);base64,([A-Za-z0-9+/_-]+={0,2})/g;

/** base64 串解码后的字节数（不实际解码） */
function base64ByteLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

function redactString(value: string): string {
  if (value.length > LONG_BASE64_MIN && LONG_BASE64_RE.test(value)) {
    return `<base64 省略 ${base64ByteLength(value)} 字节>`;
  }
  if (!value.includes('data:')) return value;
  return value.replace(
    INLINE_DATA_URL_RE,
    (_all, mime: string, _params: string, data: string) =>
      `data:${mime};base64,<省略 ${base64ByteLength(data)} 字节>`,
  );
}

/**
 * 把请求体里的内联媒体替换成占位串，供落库与检查器展示。纯函数，不改入参。
 * - 任意字符串里的 `data:<mime>;base64,<…>` → `data:<mime>;base64,<省略 N 字节>`；
 * - 整串是长 base64（>512 字符且仅 base64 字符，如 Anthropic `source.data`、Gemini `inlineData.data`、
 *   Responses 生图 `result`）→ `<base64 省略 N 字节>`。
 * N 是解码后的字节数。
 */
export function redactInlineMedia(body: unknown): unknown {
  if (typeof body === 'string') return redactString(body);
  if (Array.isArray(body)) return body.map((item) => redactInlineMedia(item));
  if (typeof body === 'object' && body !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) out[key] = redactInlineMedia(value);
    return out;
  }
  return body;
}
