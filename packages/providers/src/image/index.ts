import { comfyBackend } from './comfy.js';
import { novelAiBackend } from './novelai.js';
import { openAiImageBackend } from './openai.js';
import { sdBackend } from './sd.js';
import type { ImageBackend, ImageBackendId } from './types.js';

/**
 * 外接生图后端（docs/M4-CONTRACT.md 第二部分 §D.1）。
 * 与对话适配器的 registry 分开：生图后端没有 buildRequest / stream，也不参与能力目录。
 */

export * from './comfy.js';
export * from './novelai.js';
export * from './openai.js';
export * from './sd.js';
export * from './types.js';
export {
  extractFirstFromZip,
  listZipEntries,
  readZipEntry,
  sniffImageMime,
  type ZipEntry,
} from './util.js';

const builtin: Record<ImageBackendId, ImageBackend> = {
  'image-sd': sdBackend,
  'image-comfy': comfyBackend,
  'image-novelai': novelAiBackend,
  'image-openai': openAiImageBackend,
};

/** 测试替身：按 id 覆盖（传 null 恢复内置） */
const overrides = new Map<ImageBackendId, ImageBackend>();

export function getImageBackend(id: ImageBackendId): ImageBackend {
  return overrides.get(id) ?? builtin[id];
}

export function setImageBackendOverride(id: ImageBackendId, backend: ImageBackend | null): void {
  if (backend) overrides.set(id, backend);
  else overrides.delete(id);
}
