import catalogJson from './catalog.json' with { type: 'json' };
import type { ModelCapabilities, ProviderId } from './types.js';

/**
 * 模型能力目录：defaults → providers[id] → models[] 逐条匹配 → conn.modelOverrides。
 * catalog.json 是数据化的，缺项靠保守默认值兜底，避免"新模型 = 崩"。
 */

export interface CatalogModelEntry {
  provider: string;
  /** glob：仅支持 `*` 通配，大小写不敏感 */
  match: string;
  capabilities: Partial<ModelCapabilities>;
}

export interface Catalog {
  version: number;
  updated: string;
  defaults: ModelCapabilities;
  providers: Record<string, { capabilities: Partial<ModelCapabilities> }>;
  models: CatalogModelEntry[];
}

const catalog = catalogJson as unknown as Catalog;

export function loadCatalog(): Catalog {
  return catalog;
}

/** 把 glob 转成锚定正则；只有 `*` 有特殊含义 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

const globCache = new Map<string, RegExp>();

export function globMatch(pattern: string, value: string): boolean {
  let re = globCache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    globCache.set(pattern, re);
  }
  return re.test(value);
}

function merge(
  base: ModelCapabilities,
  patch: Partial<ModelCapabilities> | undefined,
): ModelCapabilities {
  if (!patch) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * 查询某 provider + 模型的能力。`overrides` 是 `conn.modelOverrides[model]`，优先级最高。
 * 纯函数（目录是编译期 JSON），可在 buildRequest 里安全调用。
 */
export function lookupCapabilities(
  providerId: ProviderId | string,
  model: string,
  overrides?: Partial<ModelCapabilities>,
): ModelCapabilities {
  let caps: ModelCapabilities = { ...catalog.defaults };
  caps = merge(caps, catalog.providers[providerId]?.capabilities);
  for (const entry of catalog.models) {
    if (entry.provider !== providerId) continue;
    if (!globMatch(entry.match, model)) continue;
    caps = merge(caps, entry.capabilities);
  }
  return merge(caps, overrides);
}

/** 目录里登记的模型条目（供 `GET /api/models/catalog`） */
export function catalogModels(providerId?: ProviderId | string): CatalogModelEntry[] {
  return providerId ? catalog.models.filter((m) => m.provider === providerId) : catalog.models;
}

/** 默认输出上限：契约 §1.2 —— `min(4096, maxOutput)` */
export function defaultMaxTokens(caps: ModelCapabilities): number {
  return Math.min(4096, caps.maxOutput);
}
