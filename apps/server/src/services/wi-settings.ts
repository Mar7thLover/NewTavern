import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { WISettings } from './assemble.js';

/**
 * 世界书全局设置与全局书选择。见 docs/M3-CONTRACT.md §3.3 / §9 WI-10 / §9 AS-7。
 *
 * 设置 KV：
 * - `worldInfo.globalBookIds: string[]`
 * - `worldInfo.settings`：UI 形态（预算为百分比），由本模块换算成引擎要的 token 数。
 *
 * `WISettings` 从 `@newtavern/core` 导入（WI 引擎已并入 core 的 index 导出，
 * 契约 §9 [SA→SB] 要求 SB 接入时删掉服务端的本地声明）。
 */

export type { WISettings };

/** 设置 KV 里存的 UI 形态：预算是上下文百分比 */
export interface WIUiSettings {
  scanDepth: number;
  budgetPercent: number;
  budgetCap: number;
  recursive: boolean;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  useGroupScoring: boolean;
  maxRecursionSteps: number;
  minActivations: number;
  minActivationsDepthMax: number;
  includeNames: boolean;
}

export const WI_SETTINGS_KEY = 'worldInfo.settings';
export const WI_GLOBAL_BOOKS_KEY = 'worldInfo.globalBookIds';

/**
 * 默认值照 ST 1.18 源码（`public/scripts/world-info.js` 顶部的 `export let world_info_*`）：
 * depth 2 / budget 25% / cap 0 / recursive **false** / caseSensitive false /
 * matchWholeWords **false** / useGroupScoring false / maxRecursionSteps 0 /
 * minActivations 0 / minActivationsDepthMax 0 / includeNames **true**。
 *
 * 契约 §9 WI-10 与 [WEB→SB] 要求把旧的契约值（recursive true / includeNames false）改过来；
 * 与前端 `DEFAULT_WORLD_INFO_SETTINGS` 一致。
 */
export const DEFAULT_WI_UI_SETTINGS: WIUiSettings = {
  scanDepth: 2,
  budgetPercent: 25,
  budgetCap: 0,
  recursive: false,
  caseSensitive: false,
  matchWholeWords: false,
  useGroupScoring: false,
  maxRecursionSteps: 0,
  minActivations: 0,
  minActivationsDepthMax: 0,
  includeNames: true,
};

/** ST `world_info_character_strategy` 默认 `character_first`（1） */
const DEFAULT_CHARACTER_STRATEGY = 1;

function readSetting(db: Db, key: string): unknown {
  return db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value ?? null;
}

const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

/** 与默认值合并：缺失或类型不符的字段一律回落默认值 */
export function mergeWIUiSettings(value: unknown): WIUiSettings {
  const s = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const d = DEFAULT_WI_UI_SETTINGS;
  return {
    scanDepth: num(s.scanDepth, d.scanDepth),
    budgetPercent: num(s.budgetPercent, d.budgetPercent),
    budgetCap: num(s.budgetCap, d.budgetCap),
    recursive: bool(s.recursive, d.recursive),
    caseSensitive: bool(s.caseSensitive, d.caseSensitive),
    matchWholeWords: bool(s.matchWholeWords, d.matchWholeWords),
    useGroupScoring: bool(s.useGroupScoring, d.useGroupScoring),
    maxRecursionSteps: num(s.maxRecursionSteps, d.maxRecursionSteps),
    minActivations: num(s.minActivations, d.minActivations),
    minActivationsDepthMax: num(s.minActivationsDepthMax, d.minActivationsDepthMax),
    includeNames: bool(s.includeNames, d.includeNames),
  };
}

export function readWIUiSettings(db: Db): WIUiSettings {
  return mergeWIUiSettings(readSetting(db, WI_SETTINGS_KEY));
}

/**
 * ST `checkWorldInfo` 的预算换算（契约 §9 AS-7，与 `tools/golden/src/map.ts` 的
 * `wiBudgetTokens` 同一实现）：
 * `budget = Math.round(budgetPercent × (maxContext − maxResponse) / 100) || 1`。
 */
export function wiBudgetTokens(
  budgetPercent: number,
  maxContext: number,
  maxResponse: number,
): number {
  return Math.round((budgetPercent * (maxContext - maxResponse)) / 100) || 1;
}

/** UI 形态 → 引擎形态 */
export function toWISettings(
  ui: WIUiSettings,
  context: { maxContext: number; maxResponse: number },
): WISettings {
  const { budgetPercent, ...rest } = ui;
  return {
    ...rest,
    budgetTokens: wiBudgetTokens(budgetPercent, context.maxContext, context.maxResponse),
    overflowAlert: false,
    characterStrategy: DEFAULT_CHARACTER_STRATEGY,
  };
}

/** 读设置并换算（generate / inspect 直接用这个） */
export function readWISettings(
  db: Db,
  context: { maxContext: number; maxResponse: number },
): WISettings {
  return toWISettings(readWIUiSettings(db), context);
}

/** `worldInfo.globalBookIds`：不存在或类型不符时返回空数组 */
export function readGlobalBookIds(db: Db): string[] {
  const value = readSetting(db, WI_GLOBAL_BOOKS_KEY);
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string');
}
