/**
 * ST 原始数据 → 契约类型的映射（M3 契约 §8.1 的 `[FX→AS]`）。
 *
 * 黄金测试与服务端（SB）共用同一套字段名映射，因此单独成文件。
 * ST 侧字段名以 `public/scripts/world-info.js`（`world_info_*` 设置、条目列）与
 * `public/scripts/extensions/regex/engine.js`（脚本字段）为准。
 */

import {
  listWorldbookEntries,
  parseWorldbook,
  toWorldbookEntryColumns,
  type StWorldbook,
  type StWorldbookEntry,
} from '@newtavern/compat';
import type { RegexScript, WIBook, WIEntry, WIRole, WIScope, WISettings } from '@newtavern/core';

/** ST `world_info_settings` 的键（cases.json 的 `inputs.settings` 用的就是这套原名） */
export interface StWorldInfoSettings {
  world_info_depth?: number;
  world_info_budget?: number;
  world_info_budget_cap?: number;
  world_info_recursive?: boolean;
  world_info_case_sensitive?: boolean;
  world_info_match_whole_words?: boolean;
  world_info_use_group_scoring?: boolean;
  world_info_max_recursion_steps?: number;
  world_info_min_activations?: number;
  world_info_min_activations_depth_max?: number;
  world_info_include_names?: boolean;
  world_info_overflow_alert?: boolean;
  world_info_character_strategy?: number;
}

/** ST 的出厂默认值（`public/scripts/world-info.js` 顶部的 `let world_info_*`） */
export const ST_WI_DEFAULTS: Required<
  Omit<StWorldInfoSettings, 'world_info_overflow_alert' | 'world_info_character_strategy'>
> & {
  world_info_overflow_alert: boolean;
  world_info_character_strategy: number;
} = {
  world_info_depth: 2,
  world_info_budget: 25,
  world_info_budget_cap: 0,
  world_info_recursive: false,
  world_info_case_sensitive: false,
  world_info_match_whole_words: false,
  world_info_use_group_scoring: false,
  world_info_max_recursion_steps: 0,
  world_info_min_activations: 0,
  world_info_min_activations_depth_max: 0,
  world_info_include_names: true,
  world_info_overflow_alert: false,
  world_info_character_strategy: 1,
};

/**
 * ST `checkWorldInfo`：`budget = Math.round(world_info_budget * maxContext / 100) || 1`，
 * 其中 `maxContext = getMaxContextTokens() - getMaxResponseTokens()`
 * （chat completion 下即 `openai_max_context - openai_max_tokens`）。
 */
export function wiBudgetTokens(
  budgetPercent: number,
  maxContext: number,
  maxResponse: number,
): number {
  return Math.round((budgetPercent * (maxContext - maxResponse)) / 100) || 1;
}

export function mapWiSettings(
  raw: StWorldInfoSettings,
  context: { maxContext: number; maxResponse: number },
): WISettings {
  const merged = { ...ST_WI_DEFAULTS, ...raw };
  return {
    scanDepth: merged.world_info_depth,
    budgetTokens: wiBudgetTokens(merged.world_info_budget, context.maxContext, context.maxResponse),
    budgetCap: merged.world_info_budget_cap,
    recursive: merged.world_info_recursive,
    caseSensitive: merged.world_info_case_sensitive,
    matchWholeWords: merged.world_info_match_whole_words,
    useGroupScoring: merged.world_info_use_group_scoring,
    maxRecursionSteps: merged.world_info_max_recursion_steps,
    minActivations: merged.world_info_min_activations,
    minActivationsDepthMax: merged.world_info_min_activations_depth_max,
    includeNames: merged.world_info_include_names,
    overflowAlert: merged.world_info_overflow_alert,
    characterStrategy: merged.world_info_character_strategy as 0 | 1 | 2,
  };
}

const ROLE_NAMES = ['system', 'user', 'assistant'] as const;

function roleToWiRole(value: unknown): WIRole | null {
  if (typeof value === 'number') return value === 1 || value === 2 ? value : 0;
  if (typeof value === 'string') {
    const index = ROLE_NAMES.indexOf(value as (typeof ROLE_NAMES)[number]);
    return index <= 0 ? 0 : (index as WIRole);
  }
  return null;
}

function boolOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;
}

/** ST 条目 → `WIEntry`；compat 的派生列覆盖大多数字段，其余从原始条目直接取 */
export function mapWorldbookEntry(
  raw: StWorldbookEntry,
  bookId: string,
  bookName: string,
  scope: WIScope,
  fallbackUid: number,
): WIEntry {
  const columns = toWorldbookEntryColumns(raw);
  const record = raw as Record<string, unknown>;
  const uid = columns.uid ?? fallbackUid;
  const delayUntilRecursion = record.delayUntilRecursion;
  const characterFilter = record.characterFilter;

  return {
    id: `${bookId}:${uid}`,
    bookId,
    uid,
    keys: columns.keys,
    secondaryKeys: columns.secondaryKeys,
    content: columns.content,
    ...(columns.comment === null ? {} : { comment: columns.comment }),
    constant: columns.constant,
    selective: columns.selective,
    selectiveLogic: (columns.selectiveLogic ?? 0) as 0 | 1 | 2 | 3,
    position: columns.position as WIEntry['position'],
    ...(columns.depth === null ? {} : { depth: columns.depth }),
    order: columns.entryOrder,
    ...(columns.probability === null ? {} : { probability: columns.probability }),
    ...(boolOrUndefined(record.useProbability) === undefined
      ? {}
      : { useProbability: record.useProbability === true }),
    ...(columns.group === null ? {} : { group: columns.group }),
    ...(columns.groupOverride === null ? {} : { groupOverride: columns.groupOverride }),
    ...(columns.groupWeight === null ? {} : { groupWeight: columns.groupWeight }),
    scanDepth: columns.scanDepth,
    caseSensitive: columns.caseSensitive,
    matchWholeWords: columns.matchWholeWords,
    useGroupScoring: columns.useGroupScoring,
    ...(columns.automationId === null ? {} : { automationId: columns.automationId }),
    role: roleToWiRole(record.role),
    disabled: columns.disabled,
    sticky: columns.sticky,
    cooldown: columns.cooldown,
    delay: columns.delay,
    ...(columns.excludeRecursion === null ? {} : { excludeRecursion: columns.excludeRecursion }),
    ...(columns.preventRecursion === null ? {} : { preventRecursion: columns.preventRecursion }),
    ...(typeof delayUntilRecursion === 'boolean' || typeof delayUntilRecursion === 'number'
      ? { delayUntilRecursion }
      : {}),
    ...(columns.ignoreBudget === null ? {} : { ignoreBudget: columns.ignoreBudget }),
    ...(boolOrUndefined(record.vectorized) === undefined
      ? {}
      : { vectorized: record.vectorized === true }),
    ...(boolOrUndefined(record.matchPersonaDescription) === undefined
      ? {}
      : { matchPersonaDescription: record.matchPersonaDescription === true }),
    ...(boolOrUndefined(record.matchCharacterDescription) === undefined
      ? {}
      : { matchCharacterDescription: record.matchCharacterDescription === true }),
    ...(boolOrUndefined(record.matchCharacterPersonality) === undefined
      ? {}
      : { matchCharacterPersonality: record.matchCharacterPersonality === true }),
    ...(boolOrUndefined(record.matchCharacterDepthPrompt) === undefined
      ? {}
      : { matchCharacterDepthPrompt: record.matchCharacterDepthPrompt === true }),
    ...(boolOrUndefined(record.matchScenario) === undefined
      ? {}
      : { matchScenario: record.matchScenario === true }),
    ...(boolOrUndefined(record.matchCreatorNotes) === undefined
      ? {}
      : { matchCreatorNotes: record.matchCreatorNotes === true }),
    ...(typeof record.outletName === 'string' ? { outletName: record.outletName } : {}),
    ...(stringArray(record.triggers) === undefined
      ? {}
      : { triggers: stringArray(record.triggers) as string[] }),
    ...(characterFilter && typeof characterFilter === 'object'
      ? {
          characterFilter: {
            isExclude: (characterFilter as { isExclude?: boolean }).isExclude === true,
            names: stringArray((characterFilter as { names?: unknown }).names) ?? [],
            tags: stringArray((characterFilter as { tags?: unknown }).tags) ?? [],
          },
        }
      : {}),
    source: { bookName, scope },
  };
}

/** ST 世界书 JSON → `WIBook`（bookId 用书名，与 ST 的 `world` 字段一致） */
export function mapWorldbook(json: unknown, scope: WIScope, fallbackName: string): WIBook {
  const parsed: StWorldbook = parseWorldbook(json);
  const name = parsed.name ?? fallbackName;
  const { items } = listWorldbookEntries(parsed);
  return {
    id: name,
    name,
    scope,
    entries: items.map((item, index) => mapWorldbookEntry(item.entry, name, name, scope, index)),
  };
}

/** ST 正则脚本 JSON → `RegexScript` */
export function mapRegexScript(
  raw: Record<string, unknown>,
  scope: 'global' | 'character',
  index: number,
): RegexScript {
  const substitute = raw.substituteRegex;
  return {
    id: typeof raw.id === 'string' ? raw.id : `${scope}:${index}`,
    name: typeof raw.scriptName === 'string' ? raw.scriptName : `${scope}-${index}`,
    findRegex: typeof raw.findRegex === 'string' ? raw.findRegex : '',
    replaceString: typeof raw.replaceString === 'string' ? raw.replaceString : '',
    trimStrings: stringArray(raw.trimStrings) ?? [],
    placement: Array.isArray(raw.placement)
      ? raw.placement.filter((item): item is number => typeof item === 'number')
      : [],
    disabled: raw.disabled === true,
    markdownOnly: raw.markdownOnly === true,
    promptOnly: raw.promptOnly === true,
    runOnEdit: raw.runOnEdit === true,
    // ST 旧版是布尔：true → 1 (RAW)、false → 0 (NONE)
    substituteRegex: substitute === true ? 1 : substitute === 2 ? 2 : substitute === 1 ? 1 : 0,
    minDepth: numberOrUndefined(raw.minDepth) ?? null,
    maxDepth: numberOrUndefined(raw.maxDepth) ?? null,
    scope,
  };
}

/** 卡 `extensions.depth_prompt` → `AssembleInputV2.characterDepthPrompt` */
export function mapCharacterDepthPrompt(
  extensions: Record<string, unknown> | undefined,
): { text: string; depth: number; role: WIRole } | null {
  const raw = extensions?.depth_prompt;
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const text = typeof record.prompt === 'string' ? record.prompt : '';
  if (text.trim() === '') return null;
  return {
    text,
    depth: numberOrUndefined(record.depth) ?? 4,
    role: roleToWiRole(record.role) ?? 0,
  };
}
