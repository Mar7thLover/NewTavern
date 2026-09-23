import fs from 'node:fs';
import { createRequire } from 'node:module';

import { parseWritingTemplates, type WritingTemplates } from '@newtavern/core';

import type { WritingLanguage } from './writing.js';

/**
 * 读 `packages/i18n/prompts/writing.{zh-CN,en}.md`（M7 契约 §2.1），解析后按语言缓存。
 * 开发时改了模板要重启服务端才生效（与其它内置提示词一致）。
 */

const require = createRequire(import.meta.url);
const cache = new Map<WritingLanguage, WritingTemplates>();

export function writingTemplatePath(lang: WritingLanguage): string {
  return require.resolve(`@newtavern/i18n/prompts/writing.${lang}.md`);
}

export function loadWritingTemplates(lang: WritingLanguage): WritingTemplates {
  const hit = cache.get(lang);
  if (hit) return hit;
  const templates = parseWritingTemplates(fs.readFileSync(writingTemplatePath(lang), 'utf8'));
  cache.set(lang, templates);
  return templates;
}
