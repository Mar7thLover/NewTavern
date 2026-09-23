import type { ImageBackend, ImageConnection, ImageGenParams } from './types.js';
import {
  baseOf,
  bearer,
  bytesToBase64,
  imageError,
  imageFetch,
  imageFromBase64,
  imageGetJson,
  sniffImageMime,
  toImageError,
} from './util.js';

/**
 * OpenAI 兼容的 images 接口：`POST {api}/images/generations`（要 `b64_json`），模型用 `{api}/models`。
 *
 * baseUrl 两种写法都认：带版本段（`https://api.openai.com/v1`，与对话连接一致）就直接拼，
 * 不带（`https://example.com`）就补 `/v1`。
 * gpt-image 系列不认 `response_format`（总是回 b64_json），只给 DALL·E 与其他兼容端点带上。
 * 接口没有负面词与种子：负面词丢弃，种子不回报。
 */

const LABEL = 'OpenAI Images';

export function openAiApiBase(conn: ImageConnection): string {
  const base = baseOf(conn);
  return /\/v\d+[a-z]*$/i.test(base) ? base : `${base}/v1`;
}

export function buildOpenAiImagePayload(p: ImageGenParams): Record<string, unknown> {
  const model = p.model || 'gpt-image-1';
  return {
    model,
    prompt: p.prompt,
    n: 1,
    size: `${p.width}x${p.height}`,
    ...(/^gpt-image/i.test(model) ? {} : { response_format: 'b64_json' }),
  };
}

export function createOpenAiImageBackend(): ImageBackend {
  return {
    id: 'image-openai',

    async listModels(conn) {
      try {
        const json = (await imageGetJson(conn, `${openAiApiBase(conn)}/models`, bearer(conn))) as {
          data?: unknown;
        };
        if (!Array.isArray(json.data)) return [];
        return json.data
          .map((row) => {
            const id = (row as { id?: unknown }).id;
            return typeof id === 'string' ? { id } : null;
          })
          .filter((row): row is { id: string } => row !== null);
      } catch (e) {
        throw toImageError(e, LABEL);
      }
    },

    async generate(conn, p, signal, onProgress) {
      onProgress?.(0);
      try {
        const res = await imageFetch(
          conn,
          `${openAiApiBase(conn)}/images/generations`,
          { method: 'POST', headers: bearer(conn), body: buildOpenAiImagePayload(p) },
          signal,
        );
        const json = (await res.json()) as { data?: { b64_json?: unknown; url?: unknown }[] };
        const images: { mime: string; data: string }[] = [];
        for (const item of json.data ?? []) {
          if (typeof item.b64_json === 'string' && item.b64_json !== '') {
            images.push(imageFromBase64(item.b64_json));
          } else if (typeof item.url === 'string' && item.url !== '') {
            // 有的兼容端点无视 response_format 只给链接：服务端代取，前端只见资产
            const imageRes = await imageFetch(conn, item.url, {}, signal);
            const bytes = new Uint8Array(await imageRes.arrayBuffer());
            images.push({ mime: sniffImageMime(bytes), data: bytesToBase64(bytes) });
          }
        }
        if (images.length === 0) throw imageError('invalid', `${LABEL}：没有返回图片`, json);
        onProgress?.(1);
        return { images };
      } catch (e) {
        throw toImageError(e, LABEL);
      }
    },
  };
}

export const openAiImageBackend = createOpenAiImageBackend();
