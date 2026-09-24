import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resources } from '@newtavern/i18n';
import { describe, expect, it } from 'vitest';

/**
 * 词条覆盖：源码里 `t('命名空间.键')` 的字面量键在中英两份词典里都要有。
 * 2026-09-22 收尾轮落地的背景 / 立绘 / 主题变体 / 变量管理器 / 提示条等界面一度整块缺词条
 * （界面上直接露出 `backgrounds.upload` 这类键名），这里兜住。
 * 只查下列命名空间（其余模块由各自的代理维护，进行中的改动不在这里卡）。
 */

const NAMESPACES = [
  'backgrounds',
  'sprites',
  'themeVariants',
  'variableEditor',
  'toast',
  'scripts',
  'imageGen',
  'migration',
  'cards',
];

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

function has(dict: unknown, key: string): boolean {
  const get = (k: string) =>
    k
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
        dict,
      );
  return ['', '_one', '_other'].some((suffix) => get(key + suffix) !== undefined);
}

describe('词条覆盖', () => {
  it('这些命名空间里用到的字面量键中英都有', () => {
    const missing: string[] = [];
    const pattern = new RegExp(`\\bt\\(\\s*['"]((?:${NAMESPACES.join('|')})\\.[\\w.-]+)['"]`, 'g');
    for (const file of sourceFiles(ROOT)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(pattern)) {
        const key = match[1] as string;
        for (const [lang, bundle] of Object.entries(resources)) {
          const dict = (bundle as { translation?: unknown }).translation ?? bundle;
          if (!has(dict, key)) missing.push(`${lang}: ${key}（${path.relative(ROOT, file)}）`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
