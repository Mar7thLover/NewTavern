import { HttpError } from './http.js';
import type { ProviderError, ProviderErrorKind } from './types.js';

/**
 * 错误归一化：把 HTTP 状态码与各家错误体映射为 ProviderError。
 * AbortError 不在这里归一化——流里直接 `stop: 'abort'`。
 */

/** HTTP 状态码 → 错误种类 */
export function httpStatusToKind(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rateLimit';
  if (status === 529) return 'overloaded';
  if (status >= 500) return 'overloaded';
  if (status === 408) return 'network';
  return 'invalid';
}

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set<ProviderErrorKind>([
  'rateLimit',
  'overloaded',
  'network',
]);

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return RETRYABLE.has(kind);
}

/** 是否为 AbortController 取消（不同运行时名字不同） */
export function isAbortError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/** 从各家错误体里尽力提取 `{ message, type }` */
export function extractErrorBody(body: string): { message?: string; type?: string; raw: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const text = body.trim();
    return { message: text === '' ? undefined : text.slice(0, 500), raw: body };
  }
  const root = asRecord(parsed);
  if (!root) return { raw: parsed };
  // OpenAI / Anthropic：{ error: { message, type } }；Google：{ error: { message, status } }
  const err = asRecord(root.error) ?? root;
  const message =
    typeof err.message === 'string'
      ? err.message
      : typeof root.message === 'string'
        ? root.message
        : undefined;
  const type =
    typeof err.type === 'string'
      ? err.type
      : typeof err.code === 'string'
        ? err.code
        : typeof err.status === 'string'
          ? err.status
          : undefined;
  return { message, type, raw: parsed };
}

/** 各家错误 `type` 字段 → 错误种类（Anthropic/OpenAI/Google 共用） */
export function errorTypeToKind(type: string | undefined): ProviderErrorKind | undefined {
  switch (type) {
    case 'overloaded_error':
    case 'api_error':
    case 'UNAVAILABLE':
      return 'overloaded';
    case 'rate_limit_error':
    case 'insufficient_quota':
    case 'RESOURCE_EXHAUSTED':
      return 'rateLimit';
    case 'authentication_error':
    case 'permission_error':
    case 'invalid_api_key':
    case 'PERMISSION_DENIED':
    case 'UNAUTHENTICATED':
      return 'auth';
    case 'context_length_exceeded':
      return 'contextLength';
    case 'content_filter':
      return 'filter';
    default:
      return undefined;
  }
}

const CONTEXT_HINT =
  /context[\s_-]?(length|window)|too many tokens|maximum context|prompt is too long/i;

/**
 * 统一入口：HttpError / TypeError(fetch 失败) / 任意异常 → ProviderError。
 * 调用方应先用 `isAbortError` 排除中止。
 */
export function normalizeUnknownError(e: unknown): ProviderError {
  if (e instanceof HttpError) {
    const { message, type, raw } = extractErrorBody(e.body);
    let kind = errorTypeToKind(type) ?? httpStatusToKind(e.status);
    if (kind === 'invalid' && message && CONTEXT_HINT.test(message)) kind = 'contextLength';
    return {
      kind,
      message: message ?? `HTTP ${e.status}`,
      status: e.status,
      retryable: isRetryableKind(kind),
      detail: raw,
    };
  }
  if (isAbortError(e)) {
    return { kind: 'network', message: '请求已中止', retryable: false };
  }
  if (e instanceof Error) {
    // fetch 网络层失败在各运行时都是 TypeError
    const kind: ProviderErrorKind = e instanceof TypeError ? 'network' : 'invalid';
    return { kind, message: e.message || String(e), retryable: isRetryableKind(kind), detail: e };
  }
  return { kind: 'invalid', message: String(e), retryable: false, detail: e };
}
