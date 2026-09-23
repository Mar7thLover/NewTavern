import type { ImageBackend, ImageConnection, ImageGenParams } from './types.js';
import {
  baseOf,
  imageError,
  imageFetch,
  imageFromBase64,
  imageGetJson,
  toImageError,
} from './util.js';

/**
 * SD WebUI（AUTOMATIC1111）/ Forge：`/sdapi/v1/*`。
 * - 生成：`POST /sdapi/v1/txt2img`，结果 `images: base64[]`，种子在 `info`（JSON 字符串）里；
 * - 模型：`GET /sdapi/v1/sd-models`，按 `title` 切换（`override_settings.sd_model_checkpoint`）；
 * - 进度：生成期间轮询 `GET /sdapi/v1/progress?skip_current_image=true`。
 */

export interface SdBackendOptions {
  /** 进度轮询间隔（毫秒） */
  pollMs?: number;
}

const LABEL = 'SD WebUI';

/** `--api-auth user:pass` → Basic；没有冒号时当 Bearer（有些反代这么配） */
function authHeaders(conn: ImageConnection): Record<string, string> {
  const key = conn.apiKey;
  if (!key) return {};
  if (key.includes(':')) {
    return { authorization: `Basic ${Buffer.from(key, 'utf8').toString('base64')}` };
  }
  return { authorization: `Bearer ${key}` };
}

/** 请求体：只放用户给了的字段，其余交给 WebUI 的默认值 */
export function buildSdPayload(p: ImageGenParams): Record<string, unknown> {
  return {
    prompt: p.prompt,
    negative_prompt: p.negative ?? '',
    width: p.width,
    height: p.height,
    ...(p.steps === undefined ? {} : { steps: p.steps }),
    ...(p.cfg === undefined ? {} : { cfg_scale: p.cfg }),
    ...(p.sampler ? { sampler_name: p.sampler } : {}),
    seed: p.seed ?? -1,
    batch_size: 1,
    n_iter: 1,
    send_images: true,
    save_images: false,
    ...(p.model
      ? {
          override_settings: { sd_model_checkpoint: p.model },
          override_settings_restore_afterwards: true,
        }
      : {}),
  };
}

function seedFromInfo(info: unknown): number | undefined {
  let parsed: unknown = info;
  if (typeof info === 'string') {
    try {
      parsed = JSON.parse(info);
    } catch {
      return undefined;
    }
  }
  const seed = (parsed as { seed?: unknown } | null)?.seed;
  return typeof seed === 'number' && Number.isFinite(seed) ? seed : undefined;
}

export function createSdBackend(options: SdBackendOptions = {}): ImageBackend {
  const pollMs = options.pollMs ?? 1000;
  return {
    id: 'image-sd',

    async listModels(conn) {
      try {
        const json = await imageGetJson(
          conn,
          `${baseOf(conn)}/sdapi/v1/sd-models`,
          authHeaders(conn),
        );
        if (!Array.isArray(json)) return [];
        return json
          .map((row) => {
            const record = row as { title?: unknown; model_name?: unknown };
            if (typeof record.title !== 'string') return null;
            return {
              id: record.title,
              ...(typeof record.model_name === 'string' ? { name: record.model_name } : {}),
            };
          })
          .filter((row): row is { id: string; name?: string } => row !== null);
      } catch (e) {
        throw toImageError(e, LABEL);
      }
    },

    async generate(conn, p, signal, onProgress) {
      const base = baseOf(conn);
      const headers = authHeaders(conn);
      // 进度轮询与生成请求并行；生成结束（或失败）后停掉
      let polling = true;
      let lastFraction = 0;
      const poll = async () => {
        while (polling && !signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          if (!polling || signal.aborted) break;
          try {
            const json = (await imageGetJson(
              conn,
              `${base}/sdapi/v1/progress?skip_current_image=true`,
              headers,
              signal,
            )) as { progress?: unknown };
            const fraction = typeof json.progress === 'number' ? json.progress : NaN;
            // WebUI 在两次任务之间会回 0；只报递增的值
            if (polling && Number.isFinite(fraction) && fraction > lastFraction && fraction < 1) {
              lastFraction = fraction;
              onProgress?.(fraction);
            }
          } catch {
            // 进度只是锦上添花：轮询失败不影响生成
          }
        }
      };
      onProgress?.(0);
      const poller = onProgress ? poll() : Promise.resolve();
      try {
        const res = await imageFetch(
          conn,
          `${base}/sdapi/v1/txt2img`,
          { method: 'POST', headers, body: buildSdPayload(p) },
          signal,
        );
        const json = (await res.json()) as { images?: unknown; info?: unknown };
        const images = Array.isArray(json.images)
          ? json.images.filter((item): item is string => typeof item === 'string' && item !== '')
          : [];
        if (images.length === 0) throw imageError('invalid', `${LABEL}：没有返回图片`, json);
        onProgress?.(1);
        const seed = seedFromInfo(json.info) ?? p.seed;
        return {
          images: images.map((item) => imageFromBase64(item)),
          ...(seed === undefined || seed < 0 ? {} : { seed }),
        };
      } catch (e) {
        throw toImageError(e, LABEL);
      } finally {
        // 不等轮询收尾（它最多再睡一个间隔就自己退出），免得结果被拖慢
        polling = false;
        void poller;
      }
    },
  };
}

export const sdBackend = createSdBackend();
