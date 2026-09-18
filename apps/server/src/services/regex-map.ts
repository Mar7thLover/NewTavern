import type { StRegexScript } from '@newtavern/compat';

import type { schema } from '../db/client.js';

/**
 * 正则脚本的对外形状（docs/M3-CONTRACT.md §2.1 `RegexScript`）与数据库列之间的双向映射。
 *
 * DB 只有一个 `direction` 列，对外是 `promptOnly` / `markdownOnly` 两个布尔：
 * `prompt` ↔ promptOnly=true、`display` ↔ markdownOnly=true、`both` ↔ 两者皆 false。
 */

export type RegexScriptRow = typeof schema.regexScripts.$inferSelect;
export type RegexDirection = 'prompt' | 'display' | 'both';
/** 与 `regex_scripts.scope` 一致：global = 用户自己的，其余是自带的（导入时抽表） */
export type RegexScope = 'global' | 'character' | 'preset' | 'book';

export interface RegexScript {
  id: string;
  name: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  /** 1 USER_INPUT, 2 AI_OUTPUT, 3 SLASH_COMMAND, 5 WORLD_INFO, 6 REASONING */
  placement: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  /** 0 NONE / 1 RAW / 2 ESCAPED */
  substituteRegex: 0 | 1 | 2;
  minDepth: number | null;
  maxDepth: number | null;
  scope: RegexScope;
}

/** DB direction → 对外两个布尔 */
export function directionToFlags(direction: RegexDirection): {
  promptOnly: boolean;
  markdownOnly: boolean;
} {
  return { promptOnly: direction === 'prompt', markdownOnly: direction === 'display' };
}

/** 对外两个布尔 → DB direction（两者同时为真视为 both，与 ST 的 getRegexedString 过滤一致） */
export function flagsToDirection(flags: {
  promptOnly?: boolean | null;
  markdownOnly?: boolean | null;
}): RegexDirection {
  if (flags.markdownOnly && !flags.promptOnly) return 'display';
  if (flags.promptOnly && !flags.markdownOnly) return 'prompt';
  return 'both';
}

function normalizeSubstitute(value: unknown): 0 | 1 | 2 {
  if (value === true) return 1;
  if (value === 1 || value === 2) return value;
  return 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function numberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
    : [];
}

export function toRegexScript(row: RegexScriptRow): RegexScript {
  return {
    id: row.id,
    name: row.scriptName,
    findRegex: row.findRegex,
    replaceString: row.replaceString,
    trimStrings: row.trimStrings ?? [],
    placement: row.placement,
    disabled: row.disabled,
    runOnEdit: row.runOnEdit,
    substituteRegex: normalizeSubstitute(row.substituteRegex),
    minDepth: row.minDepth,
    maxDepth: row.maxDepth,
    scope: row.scope,
    ...directionToFlags(row.direction),
  };
}

/** 对外形状 → DB 列（不含 id / scope / displayOrder / extra，由调用方补） */
export function toRegexColumns(
  script: Omit<RegexScript, 'id' | 'scope'>,
): Omit<typeof schema.regexScripts.$inferInsert, 'id'> {
  return {
    scriptName: script.name,
    findRegex: script.findRegex,
    replaceString: script.replaceString,
    trimStrings: script.trimStrings,
    placement: script.placement,
    direction: flagsToDirection(script),
    disabled: script.disabled,
    runOnEdit: script.runOnEdit,
    substituteRegex: script.substituteRegex,
    minDepth: script.minDepth,
    maxDepth: script.maxDepth,
  };
}

/**
 * ST 正则脚本（导入文件里的单条，或卡内 `data.extensions.regex_scripts` 的一项）→ 对外形状。
 * 宽松解析：缺少 scriptName/findRegex 视为无效，返回 null。
 */
export function stRegexToScript(raw: unknown, id: string, scope: RegexScope): RegexScript | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const st = raw as Partial<StRegexScript> & Record<string, unknown>;
  if (typeof st.scriptName !== 'string' || typeof st.findRegex !== 'string') return null;
  return {
    id,
    name: st.scriptName,
    findRegex: st.findRegex,
    replaceString: typeof st.replaceString === 'string' ? st.replaceString : '',
    trimStrings: stringArray(st.trimStrings),
    placement: numberArray(st.placement),
    disabled: st.disabled === true,
    markdownOnly: st.markdownOnly === true,
    promptOnly: st.promptOnly === true,
    runOnEdit: st.runOnEdit === true,
    substituteRegex: normalizeSubstitute(st.substituteRegex),
    minDepth: numberOrNull(st.minDepth),
    maxDepth: numberOrNull(st.maxDepth),
    scope,
  };
}

/**
 * 角色卡内嵌正则：直接从卡数据里读（`data.extensions.regex_scripts`）。
 *
 * **组装与显示都不再走这里**——自带正则在导入时已抽进 `regex_scripts` 表
 * （`services/embedded-regex.ts`），这个函数只留给抽表与回填用，
 * 免得同一条脚本跑两遍。
 */
export function characterRegexScripts(characterId: string, data: unknown): RegexScript[] {
  const extensions = (data as { extensions?: unknown } | null)?.extensions;
  const list = (extensions as { regex_scripts?: unknown } | undefined)?.regex_scripts;
  if (!Array.isArray(list)) return [];
  return list
    .map((item, index) => stRegexToScript(item, `${characterId}:${index}`, 'character'))
    .filter((script): script is RegexScript => script !== null);
}
