import {
  redactInlineMedia,
  type BuildOptions,
  type ProviderAdapter,
  type ProviderRequest,
} from '@newtavern/providers';

import type { PromptIR } from './assemble.js';

/** extra.request 体积上限（按脱敏后的 body 计），超出只存 body 长度（契约 §3.5） */
const REQUEST_STORE_LIMIT = 200 * 1024;

/** 同 providers `ThinkingOptions`：`enabled:false` = 关闭推理 */
export interface ThinkingOptions {
  enabled?: boolean;
  effort?: string;
  budgetTokens?: number;
}

/** 多模态相关的 buildRequest 选项（M4 §3.3「发请求」） */
export interface MediaRequestOptions {
  /** 资产解析器；缺省（检查器预览）时适配器输出 `asset:<id>` 占位 */
  resolveAsset?: BuildOptions['resolveAsset'];
  /** 聊天覆盖项 `overrides.imageOutput`；undefined = 按适配器默认 */
  imageOutput?: boolean;
}

/** 统一的 buildRequest 调用点（把聊天覆盖项里的 thinking / imageOutput 与资产解析器传下去） */
export function buildProviderRequest(
  adapter: ProviderAdapter,
  ir: PromptIR,
  conn: Parameters<ProviderAdapter['buildRequest']>[1],
  model: string,
  thinking?: ThinkingOptions,
  media?: MediaRequestOptions,
): ProviderRequest {
  const opts: BuildOptions = {
    ...(thinking ? { thinking } : {}),
    ...(media?.resolveAsset ? { resolveAsset: media.resolveAsset } : {}),
    ...(typeof media?.imageOutput === 'boolean' ? { imageOutput: media.imageOutput } : {}),
  };
  return adapter.buildRequest(ir, conn, model, Object.keys(opts).length > 0 ? opts : undefined);
}

/**
 * 落库用：去掉 headers（含鉴权信息，绝不落库/外发），内联媒体（data URL、长 base64）替换成占位串，
 * 脱敏后仍过大时只留长度。
 */
export function requestForStorage(req: ProviderRequest | null): Record<string, unknown> | null {
  if (!req) return null;
  const redacted = redactInlineMedia(req.body ?? null);
  const body = JSON.stringify(redacted);
  if (body.length > REQUEST_STORE_LIMIT) {
    return { method: req.method, url: req.url, bodyLength: body.length, truncated: true };
  }
  return { method: req.method, url: req.url, body: redacted };
}

/** 检查器用：保留 warnings，同样去 headers，不做体积截断 */
export function requestForInspect(req: ProviderRequest): Record<string, unknown> {
  return {
    method: req.method,
    url: req.url,
    body: req.body,
    ...(req.warnings ? { warnings: req.warnings } : {}),
  };
}
