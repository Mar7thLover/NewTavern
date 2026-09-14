import type { ProviderAdapter, ProviderRequest } from '@newtavern/providers';

import type { PromptIR } from './assemble.js';

/** extra.request 体积上限，超出只存 body 长度（契约 §3.5） */
const REQUEST_STORE_LIMIT = 200 * 1024;

export interface ThinkingOptions {
  effort?: string;
  budgetTokens?: number;
}

/** 统一的 buildRequest 调用点（把聊天覆盖项里的 thinking 传下去） */
export function buildProviderRequest(
  adapter: ProviderAdapter,
  ir: PromptIR,
  conn: Parameters<ProviderAdapter['buildRequest']>[1],
  model: string,
  thinking?: ThinkingOptions,
): ProviderRequest {
  return adapter.buildRequest(ir, conn, model, thinking ? { thinking } : undefined);
}

/** 去掉 headers（含鉴权信息，绝不落库/外发），过大时只留长度 */
export function requestForStorage(req: ProviderRequest | null): Record<string, unknown> | null {
  if (!req) return null;
  const body = JSON.stringify(req.body ?? null);
  if (body.length > REQUEST_STORE_LIMIT) {
    return { method: req.method, url: req.url, bodyLength: body.length, truncated: true };
  }
  return { method: req.method, url: req.url, body: req.body };
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
