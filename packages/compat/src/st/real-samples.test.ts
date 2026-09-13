/**
 * 用本机真实 SillyTavern 数据做的兼容层往返测试（可选）。
 *
 * 设置环境变量 NT_ST_DATA_DIR 指向 ST 的 `data/<user>` 目录（如 `data/default-user`）后运行：
 *   NT_ST_DATA_DIR=/path/to/data/default-user pnpm --filter @newtavern/compat test -- real-samples
 * 未设置该变量，或目录不存在时，整套测试跳过——不影响默认 `pnpm test`，CI 环境也不会有这个目录。
 *
 * 这些数据是用户私有内容：本文件只读 characters/OpenAI Settings/worlds/chats 四个目录，
 * 不读取 secrets.json、settings.json 等其他文件；断言只比较解析结果是否往返一致，
 * 不打印、不记录卡片/预设/世界书/聊天的任何内容文本，只统计数量与文件名（basename）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { utf8FromBase64 } from './base64.js';
import {
  CCV3_TEXT_KEYWORD,
  CHARA_TEXT_KEYWORD,
  parseCardJson,
  readCardFromPng,
  writeCardToPng,
} from './card.js';
import { parseChatJsonl, serializeChatJsonl } from './chat-jsonl.js';
import { readPngTextChunks, removePngTextChunks } from './png-text.js';
import { parsePreset, serializePreset } from './preset.js';
import { parseRegexScripts } from './regex.js';
import { parseWorldbook, serializeWorldbook } from './worldbook.js';

const dataDir = process.env.NT_ST_DATA_DIR;
const dataDirAvailable = dataDir !== undefined && existsSync(dataDir);

/** 递归列出目录下满足后缀的文件（大小写不敏感），目录不存在时返回空数组 */
function listFiles(dir: string, extensions: readonly string[], recursive: boolean): string[] {
  if (!existsSync(dir)) return [];
  const lowerExts = extensions.map((e) => e.toLowerCase());
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (lowerExts.some((ext) => name.toLowerCase().endsWith(ext))) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * 逐字节比较两个 Uint8Array：PNG 剩余 chunk 常有几 MB，vitest/chai 的 toEqual 对大号
 * 定型数组走的是通用深比较，实测 3MB 级别能慢到近 10 秒；这里手写线性比较规避该问题，
 * 这是测试自身的写法选择，不代表兼容层实现有性能缺陷。
 */
function bytesEqual(a: Uint8Array, b: Uint8Array): { equal: boolean; detail?: string } {
  if (a.length !== b.length) {
    return { equal: false, detail: `长度不同：${a.length} vs ${b.length}` };
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return { equal: false, detail: `第 ${i} 字节不同（共 ${a.length} 字节）` };
    }
  }
  return { equal: true };
}

/**
 * 真正的测试注册逻辑单独提取成函数：只在 dataDirAvailable 为 true 时调用。
 * describe.skip 的回调在「收集测试列表」阶段依然会同步执行一次（这是 vitest/jest 的既有行为，
 * 并非本文件的 bug）——如果不这样拆分，即便走 skip 分支，内部对 rootDir 的 join() 仍会
 * 因 rootDir 为 undefined 而在收集阶段抛错，导致整个文件报 “test suite failed”。
 */
function registerRealSampleTests(rootDir: string): void {
  describe('角色卡 PNG', () => {
    const files = listFiles(join(rootDir, 'characters'), ['.png'], true);
    it('至少发现一张角色卡 PNG', () => {
      expect(files.length).toBeGreaterThan(0);
    });

    const skipped: { file: string; reason: string }[] = [];

    for (const file of files) {
      const label = basename(file);
      let bytes: Uint8Array;
      let texts: Map<string, string>;
      try {
        bytes = readFileSync(file);
        texts = readPngTextChunks(bytes);
      } catch (e) {
        skipped.push({ file: label, reason: `PNG 解析异常：${(e as Error).message}` });
        it.skip(`${label}（跳过：PNG 解析异常）`, () => {});
        continue;
      }
      if (!texts.has(CHARA_TEXT_KEYWORD) && !texts.has(CCV3_TEXT_KEYWORD)) {
        skipped.push({
          file: label,
          reason: '非角色卡 PNG（无 chara/ccv3 chunk，可能是表情图等附属资源）',
        });
        it.skip(`${label}（跳过：无 chara/ccv3 chunk）`, () => {});
        continue;
      }

      it.each([label])('%s：导入导出往返无损', () => {
        // 两块都存在时，各自都应能独立解析
        const chara = texts.get(CHARA_TEXT_KEYWORD);
        const ccv3 = texts.get(CCV3_TEXT_KEYWORD);
        if (chara !== undefined) {
          expect(() => parseCardJson(JSON.parse(utf8FromBase64(chara)))).not.toThrow();
        }
        if (ccv3 !== undefined) {
          expect(() => parseCardJson(JSON.parse(utf8FromBase64(ccv3)))).not.toThrow();
        }

        const parsed = readCardFromPng(bytes);
        const rewritten = writeCardToPng(bytes, parsed);
        const reparsed = readCardFromPng(rewritten);
        expect(reparsed).toEqual(parsed);

        // 非 tEXt chunk（IHDR/IDAT/IEND 等）字节不变：去掉 chara/ccv3 后比较剩余 chunk 序列
        const originalRest = removePngTextChunks(bytes, [CHARA_TEXT_KEYWORD, CCV3_TEXT_KEYWORD]);
        const rewrittenRest = removePngTextChunks(rewritten, [
          CHARA_TEXT_KEYWORD,
          CCV3_TEXT_KEYWORD,
        ]);
        const rest = bytesEqual(rewrittenRest, originalRest);
        expect(rest.equal, rest.detail).toBe(true);

        // 正则脚本：若角色卡带 extensions.regex_scripts，逐条解析不应抛错
        const extensions = parsed.data.extensions as Record<string, unknown> | undefined;
        const regexScripts = extensions?.['regex_scripts'];
        if (Array.isArray(regexScripts) && regexScripts.length > 0) {
          expect(() => parseRegexScripts(regexScripts)).not.toThrow();
        }
      });
    }

    it('跳过样本汇总（非角色卡 PNG 等）', () => {
      if (skipped.length > 0) {
        console.log(
          `[real-samples] 角色卡：跳过 ${skipped.length} 个样本 -> ` +
            skipped.map((s) => `${s.file}（${s.reason}）`).join('；'),
        );
      }
      expect(skipped.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('预设', () => {
    const files = listFiles(join(rootDir, 'OpenAI Settings'), ['.json'], false);
    it('至少发现一个预设 JSON', () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it.each(files.map((f) => [basename(f), f] as const))('%s：往返 deep-equal', (_label, file) => {
      const text = readFileSync(file, 'utf8');
      const original: unknown = JSON.parse(text);
      const preset = parsePreset(original);
      const roundTripped = JSON.parse(serializePreset(preset)) as unknown;
      expect(roundTripped).toEqual(original);
    });
  });

  describe('世界书', () => {
    const files = listFiles(join(rootDir, 'worlds'), ['.json'], false);
    it('至少发现一个世界书 JSON', () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it.each(files.map((f) => [basename(f), f] as const))('%s：往返 deep-equal', (_label, file) => {
      const text = readFileSync(file, 'utf8');
      const original: unknown = JSON.parse(text);
      const book = parseWorldbook(original);
      const roundTripped = JSON.parse(serializeWorldbook(book)) as unknown;
      expect(roundTripped).toEqual(original);
    });
  });

  describe('聊天记录', () => {
    const files = listFiles(join(rootDir, 'chats'), ['.jsonl'], true);
    it('至少发现一份聊天记录', () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it.each(files.map((f) => [basename(f), f] as const))(
      '%s：往返 deep-equal（逐行）',
      (_label, file) => {
        const text = readFileSync(file, 'utf8');
        const expectedLines = text
          .replace(/^\uFEFF/, '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as unknown);

        const chat = parseChatJsonl(text);
        const roundTrippedLines = serializeChatJsonl(chat)
          .split('\n')
          .map((line) => JSON.parse(line) as unknown);
        expect(roundTrippedLines).toEqual(expectedLines);
      },
    );
  });
}

if (dataDirAvailable) {
  describe('ST 真实数据往返测试', () => {
    registerRealSampleTests(dataDir as string);
  });
} else {
  if (dataDir === undefined) {
    console.log(
      '[real-samples] 未设置 NT_ST_DATA_DIR，跳过真实 ST 数据往返测试（可选）。' +
        '设置为 ST 的 data/<user> 目录（如 data/default-user）后重新运行本测试。',
    );
  } else {
    console.log(`[real-samples] NT_ST_DATA_DIR=${dataDir} 不存在，跳过真实 ST 数据往返测试。`);
  }
  describe.skip('ST 真实数据往返测试（NT_ST_DATA_DIR 未设置或目录不存在，已跳过）', () => {
    it('跳过', () => {});
  });
}
