import type { Connection, ProviderRequest } from './types.js';

/** 非 2xx 响应：带状态码与已读取的 body 文本，交给 errors.ts 归一化 */
export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly headers: Record<string, string>;

  constructor(status: number, body: string, headers: Record<string, string> = {}) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

/**
 * 发起提供商请求：合并 `conn.headers`（req.headers 优先），非 2xx 读取 body 后抛 HttpError。
 * 只用全局 fetch，不引入运行时依赖；`conn.proxy` 在 M2 仅存储，不做转发。
 */
export async function providerFetch(
  conn: Connection,
  req: ProviderRequest,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = { ...conn.headers, ...req.headers };
  const res = await fetch(req.url, {
    method: req.method,
    headers,
    body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
    signal,
  });
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    throw new HttpError(res.status, text, headersToRecord(res.headers));
  }
  return res;
}

/** GET 版本，用于 listModels 之类的探测 */
export async function providerGet(
  conn: Connection,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { ...conn.headers, ...headers },
    signal,
  });
  if (!res.ok) {
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    throw new HttpError(res.status, text, headersToRecord(res.headers));
  }
  return (await res.json()) as unknown;
}

/** 去掉 baseUrl 结尾的斜杠 */
export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
