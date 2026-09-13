/**
 * ST 正则脚本（regex extension）模型：单个脚本或脚本数组，未知字段保留。
 */

import { z } from 'zod';

import { isRecord, parseOrThrow } from './util.js';

/** placement 取值：1 用户输入、2 AI 输出、3 斜杠命令、5 世界书、6 推理 */
export const REGEX_PLACEMENT = {
  userInput: 1,
  aiOutput: 2,
  slashCommand: 3,
  worldInfo: 5,
  reasoning: 6,
} as const;

export const stRegexScriptSchema = z.looseObject({
  id: z.string().optional(),
  scriptName: z.string(),
  findRegex: z.string(),
  replaceString: z.string().optional(),
  trimStrings: z.array(z.string()).optional(),
  placement: z.array(z.number()).optional(),
  disabled: z.boolean().optional(),
  markdownOnly: z.boolean().optional(),
  promptOnly: z.boolean().optional(),
  runOnEdit: z.boolean().optional(),
  // 旧版为 boolean，新版为 0/1/2
  substituteRegex: z.union([z.number(), z.boolean()]).optional(),
  minDepth: z.number().nullish(),
  maxDepth: z.number().nullish(),
});

export type StRegexScript = z.infer<typeof stRegexScriptSchema>;

export function parseRegexScript(json: unknown): StRegexScript {
  if (!isRecord(json)) {
    throw new Error('正则脚本 JSON 必须是对象');
  }
  return parseOrThrow(stRegexScriptSchema, json, 'ST 正则脚本解析失败');
}

/** 接受单个脚本或脚本数组，统一返回数组 */
export function parseRegexScripts(json: unknown): StRegexScript[] {
  if (Array.isArray(json)) {
    return json.map((item, index) => {
      try {
        return parseRegexScript(item);
      } catch (e) {
        throw new Error(`第 ${index + 1} 个正则脚本：${(e as Error).message}`);
      }
    });
  }
  return [parseRegexScript(json)];
}

export function serializeRegexScript(script: StRegexScript): string {
  return JSON.stringify(script, null, 4);
}

export function serializeRegexScripts(scripts: readonly StRegexScript[]): string {
  return JSON.stringify(scripts, null, 4);
}

export type RegexDirection = 'prompt' | 'display' | 'both';

/** markdownOnly → 仅显示；promptOnly → 仅提示词；都不勾选 → 两者 */
export function regexDirection(script: StRegexScript): RegexDirection {
  if (script.markdownOnly && !script.promptOnly) return 'display';
  if (script.promptOnly && !script.markdownOnly) return 'prompt';
  return 'both';
}
