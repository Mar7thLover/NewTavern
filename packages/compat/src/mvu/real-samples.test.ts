/**
 * 用本机真实 SillyTavern 世界书做的 MVU 初始化抽验（可选，默认跳过）。
 *
 *   NT_ST_DATA_DIR=/path/to/data/default-user pnpm --filter @newtavern/compat test -- mvu/real-samples
 *
 * 与 `st/real-samples.test.ts` 同一套规矩：只读 `worlds/`，不读 secrets/settings，
 * 断言只看「能不能解析出变量表、有几个字段」，不打印任何条目内容。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { emptyMvuData } from './engine.js';
import { initializeMvu, isInitVarEntry, type InitVarEntry } from './init.js';

const dataDir = process.env.NT_ST_DATA_DIR;
const available = dataDir !== undefined && existsSync(dataDir);

interface StWorldbook {
  entries?: Record<string, { comment?: string; content?: string }>;
}

function readBooks(): { name: string; entries: InitVarEntry[] }[] {
  const dir = join(dataDir as string, 'worlds');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(dir, file), 'utf8')) as StWorldbook;
      return {
        name: basename(file, '.json'),
        entries: Object.values(raw.entries ?? {}).map((entry) => ({
          comment: entry.comment ?? '',
          content: entry.content ?? '',
        })),
      };
    });
}

describe.skipIf(!available)('真实世界书的 [InitVar]', () => {
  it('每本带 [InitVar] 的书都能解析出非空变量表', () => {
    const books = readBooks().filter((book) => book.entries.some((entry) => isInitVarEntry(entry)));
    // 本机没有 MVU 卡时这条退化成「没有样本」，不算失败
    for (const book of books) {
      const result = initializeMvu(emptyMvuData(), [book], {
        // 卡里的 `{{user}}` 之类在这里没有上下文，替换成占位符即可
        substituteMacros: (text) => text.replace(/{{[^}]*}}/g, '占位'),
      });
      expect(result.errors, `${book.name} 的 [InitVar] 解析报错`).toEqual([]);
      expect(Object.keys(result.data.stat_data).length, `${book.name} 的变量表是空的`).toBeGreaterThan(0);
      expect(result.data.initialized_lorebooks[book.name]).toBeDefined();
    }
  });
});
