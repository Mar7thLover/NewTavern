import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';

/**
 * 世界书全局设置与全局书选择。见 docs/M3-CONTRACT.md §3.3。
 *
 * 设置 KV：
 * - `worldInfo.globalBookIds: string[]`
 * - `worldInfo.settings`：UI 形态（预算为百分比），由本模块换算成引擎要的 token 数。
 *
 * `WISettings` 与契约 §1.1 同名同形；WI 引擎（WI 代号）还没并入 `@newtavern/core` 的
 * index 导出，所以先在服务端本地声明，SB 接入组装 v2 时改为从 core 导入。
 */

export interface WISettings {
  scanDepth: number;
  /** 已换算为 token 的预算 */
  budgetTokens: number;
  /** 0 = 无上限 */
  budgetCap: number;
  recursive: boolean;
  caseSensitive: boolean;
  matchWholeWords: boolean;
  useGroupScoring: boolean;
  /** 0 = 不限 */
  maxRecursionSteps: number;
  /** 0 = 关 */
  minActivations: number;
  minActivationsDepthMax: number;
  includeNames: boolean;
  overflowAlert?: boolean;
}

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

/** 默认值照 ST（契约 §3.3） */
export const DEFAULT_WI_UI_SETTINGS: WIUiSettings = {
  scanDepth: 2,
  budgetPercent: 25,
  budgetCap: 0,
  recursive: true,
  caseSensitive: false,
  matchWholeWords: false,
  useGroupScoring: false,
  maxRecursionSteps: 0,
  minActivations: 0,
  minActivationsDepthMax: 0,
  includeNames: false,
};

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

/** UI 形态 → 引擎形态：budgetTokens = floor(maxContext * budgetPercent / 100) */
export function toWISettings(ui: WIUiSettings, maxContext: number): WISettings {
  const { budgetPercent, ...rest } = ui;
  return {
    ...rest,
    budgetTokens: Math.max(0, Math.floor((maxContext * budgetPercent) / 100)),
  };
}

/** 读设置并换算（generate / inspect 直接用这个） */
export function readWISettings(db: Db, maxContext: number): WISettings {
  return toWISettings(readWIUiSettings(db), maxContext);
}

/** `worldInfo.globalBookIds`：不存在或类型不符时返回空数组 */
export function readGlobalBookIds(db: Db): string[] {
  const value = readSetting(db, WI_GLOBAL_BOOKS_KEY);
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === 'string');
}
