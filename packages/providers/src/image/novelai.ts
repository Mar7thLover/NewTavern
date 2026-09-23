import type { ImageBackend, ImageGenParams } from './types.js';
import {
  baseOf,
  bearer,
  bytesToBase64,
  extractFirstFromZip,
  imageError,
  imageFetch,
  randomSeed,
  sniffImageMime,
  toImageError,
} from './util.js';

/**
 * NovelAI 生图：`POST {base}/ai/generate-image`（Bearer = 持久 API Token），返回 zip，取第一张 png。
 * 请求体照 ST `src/endpoints/novelai.js` 的形状（params_version 3，带 v4_prompt 字段；
 * V3 模型会忽略 v4 字段）。NovelAI 没有模型列表接口，`listModels` 返回内置清单。
 */

const LABEL = 'NovelAI';

export const NOVELAI_MODELS: { id: string; name: string }[] = [
  { id: 'nai-diffusion-4-5-full', name: 'NAI Diffusion V4.5 Full' },
  { id: 'nai-diffusion-4-5-curated', name: 'NAI Diffusion V4.5 Curated' },
  { id: 'nai-diffusion-4-full', name: 'NAI Diffusion V4 Full' },
  { id: 'nai-diffusion-4-curated-preview', name: 'NAI Diffusion V4 Curated' },
  { id: 'nai-diffusion-3', name: 'NAI Diffusion Anime V3' },
  { id: 'nai-diffusion-furry-3', name: 'NAI Diffusion Furry V3' },
];

const DEFAULT_MODEL = 'nai-diffusion-4-5-full';

/** NovelAI 要求尺寸是 64 的倍数 */
function snap64(value: number): number {
  return Math.max(64, Math.round(value / 64) * 64);
}

export function buildNovelAiPayload(p: ImageGenParams, seed: number): Record<string, unknown> {
  const negative = p.negative ?? '';
  return {
    action: 'generate',
    input: p.prompt,
    model: p.model || DEFAULT_MODEL,
    parameters: {
      params_version: 3,
      width: snap64(p.width),
      height: snap64(p.height),
      scale: p.cfg ?? 5,
      sampler: p.sampler || 'k_euler_ancestral',
      steps: p.steps ?? 28,
      seed,
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: false,
      negative_prompt: negative,
      noise_schedule: 'karras',
      prefer_brownian: true,
      add_original_image: false,
      legacy: false,
      legacy_v3_extend: false,
      use_coords: false,
      characterPrompts: [],
      v4_prompt: {
        caption: { base_caption: p.prompt, char_captions: [] },
        use_coords: false,
        use_order: true,
      },
      v4_negative_prompt: { caption: { base_caption: negative, char_captions: [] } },
    },
  };
}

export function createNovelAiBackend(): ImageBackend {
  return {
    id: 'image-novelai',

    listModels() {
      return Promise.resolve(NOVELAI_MODELS.map((model) => ({ ...model })));
    },

    async generate(conn, p, signal, onProgress) {
      if (!conn.apiKey) throw imageError('auth', `${LABEL}：没有配置 API Token`);
      const seed = p.seed ?? randomSeed();
      onProgress?.(0);
      try {
        const res = await imageFetch(
          conn,
          `${baseOf(conn)}/ai/generate-image`,
          { method: 'POST', headers: bearer(conn), body: buildNovelAiPayload(p, seed) },
          signal,
        );
        const bytes = new Uint8Array(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') ?? '';
        let image: Uint8Array;
        if (/zip/i.test(contentType) || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
          const entry = await extractFirstFromZip(bytes, ['.png', '.webp', '.jpg', '.jpeg']);
          if (!entry) throw imageError('invalid', `${LABEL}：返回的压缩包里没有图片`);
          image = entry.bytes;
        } else if (/^image\//i.test(contentType)) {
          image = bytes;
        } else {
          throw imageError('invalid', `${LABEL}：无法识别的返回（${contentType || '无类型'}）`);
        }
        onProgress?.(1);
        return { images: [{ mime: sniffImageMime(image), data: bytesToBase64(image) }], seed };
      } catch (e) {
        throw toImageError(e, LABEL);
      }
    },
  };
}

export const novelAiBackend = createNovelAiBackend();
