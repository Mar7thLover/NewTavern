/**
 * ST 世界书 JSON：entries 为以字符串数字为 key 的对象（ST 原生），也容忍数组（character_book 形态）。
 * 条目同时兼容 ST 原生字段名（key/keysecondary/order/disable）与 CCv3 character_book 字段名
 * （keys/secondary_keys/insertion_order/enabled）。
 *
 * 存储策略：原始条目整体保留，可查询/可编辑字段通过 toWorldbookEntryColumns 派生；
 * 导出时 applyWorldbookEntryColumns 只把「与原始派生值不同」的列写回原始条目，保证未编辑时无损。
 */

import { z } from 'zod';

import { isRecord, parseOrThrow } from './util.js';

const worldbookEntrySchema = z.looseObject({
  uid: z.number().optional(),
  key: z.array(z.string()).optional(),
  keys: z.array(z.string()).optional(),
  keysecondary: z.array(z.string()).optional(),
  secondary_keys: z.array(z.string()).optional(),
  comment: z.string().optional(),
  content: z.string().optional(),
});

export const stWorldbookSchema = z.looseObject({
  name: z.string().optional(),
  entries: z.union([z.record(z.string(), worldbookEntrySchema), z.array(worldbookEntrySchema)]),
});

export type StWorldbookEntry = z.infer<typeof worldbookEntrySchema>;
export type StWorldbook = z.infer<typeof stWorldbookSchema>;

export function parseWorldbook(json: unknown): StWorldbook {
  if (!isRecord(json)) {
    throw new Error('世界书 JSON 必须是对象');
  }
  return parseOrThrow(stWorldbookSchema, json, 'ST 世界书解析失败');
}

export function serializeWorldbook(book: StWorldbook): string {
  return JSON.stringify(book, null, 4);
}

export interface WorldbookEntryItem {
  /** entries 对象里的 key；数组形态为下标字符串 */
  key: string;
  entry: StWorldbookEntry;
}

export type WorldbookEntriesForm = 'object' | 'array';

export function listWorldbookEntries(book: StWorldbook): {
  form: WorldbookEntriesForm;
  items: WorldbookEntryItem[];
} {
  if (Array.isArray(book.entries)) {
    return {
      form: 'array',
      items: book.entries.map((entry, index) => ({ key: String(index), entry })),
    };
  }
  return {
    form: 'object',
    items: Object.entries(book.entries).map(([key, entry]) => ({ key, entry })),
  };
}

/** listWorldbookEntries 的逆操作：meta 为除 entries 外的书级字段 */
export function buildWorldbook(
  meta: Record<string, unknown>,
  form: WorldbookEntriesForm,
  items: readonly WorldbookEntryItem[],
): StWorldbook {
  const entries =
    form === 'array'
      ? items.map((item) => item.entry)
      : Object.fromEntries(items.map((item) => [item.key, item.entry]));
  return { ...meta, entries };
}

/** 与数据库 lorebook_entries 列一一对应的派生视图 */
export interface WorldbookEntryColumns {
  uid: number | null;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  comment: string | null;
  constant: boolean;
  selective: boolean;
  selectiveLogic: number | null;
  position: number;
  depth: number | null;
  entryOrder: number;
  probability: number | null;
  group: string | null;
  groupOverride: boolean | null;
  groupWeight: number | null;
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  useGroupScoring: boolean | null;
  automationId: string | null;
  role: string | null;
  disabled: boolean;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  excludeRecursion: boolean | null;
  preventRecursion: boolean | null;
  delayUntilRecursion: boolean | null;
  ignoreBudget: boolean | null;
  displayIndex: number | null;
}

type ColumnKey = keyof WorldbookEntryColumns;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strArr = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((item) => typeof item === 'string') ? (v as string[]) : null;

/** character_book 的 position 字符串 → ST 数字位置（0 角色定义前、1 角色定义后） */
function positionOf(v: unknown): number {
  if (v === 'before_char') return 0;
  if (v === 'after_char') return 1;
  return num(v) ?? 0;
}

/** ST role 为数字（0 system / 1 user / 2 assistant），统一为字符串存储 */
const ROLE_NAMES = ['system', 'user', 'assistant'] as const;
function roleOf(v: unknown): string | null {
  if (typeof v === 'number') return ROLE_NAMES[v] ?? null;
  return str(v);
}

/** 按优先级取第一个存在的字段名（ST 原生名在前） */
function pick(entry: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    if (entry[name] !== undefined) return entry[name];
  }
  return undefined;
}

interface FieldSpec {
  names: readonly string[];
  read: (v: unknown) => unknown;
}

const FIELDS: Record<Exclude<ColumnKey, 'disabled' | 'position' | 'role'>, FieldSpec> = {
  uid: { names: ['uid', 'id'], read: num },
  keys: { names: ['key', 'keys'], read: (v) => strArr(v) ?? [] },
  secondaryKeys: { names: ['keysecondary', 'secondary_keys'], read: (v) => strArr(v) ?? [] },
  content: { names: ['content'], read: (v) => str(v) ?? '' },
  comment: { names: ['comment', 'name'], read: str },
  constant: { names: ['constant'], read: (v) => bool(v) ?? false },
  selective: { names: ['selective'], read: (v) => bool(v) ?? false },
  selectiveLogic: { names: ['selectiveLogic'], read: num },
  depth: { names: ['depth'], read: num },
  entryOrder: { names: ['order', 'insertion_order'], read: (v) => num(v) ?? 100 },
  probability: { names: ['probability'], read: num },
  group: { names: ['group'], read: str },
  groupOverride: { names: ['groupOverride'], read: bool },
  groupWeight: { names: ['groupWeight'], read: num },
  scanDepth: { names: ['scanDepth', 'scan_depth'], read: num },
  caseSensitive: { names: ['caseSensitive', 'case_sensitive'], read: bool },
  matchWholeWords: { names: ['matchWholeWords'], read: bool },
  useGroupScoring: { names: ['useGroupScoring'], read: bool },
  automationId: { names: ['automationId'], read: str },
  sticky: { names: ['sticky'], read: num },
  cooldown: { names: ['cooldown'], read: num },
  delay: { names: ['delay'], read: num },
  excludeRecursion: { names: ['excludeRecursion'], read: bool },
  preventRecursion: { names: ['preventRecursion'], read: bool },
  delayUntilRecursion: { names: ['delayUntilRecursion'], read: bool },
  ignoreBudget: { names: ['ignoreBudget'], read: bool },
  displayIndex: { names: ['displayIndex', 'display_index'], read: num },
};

export const WORLDBOOK_ENTRY_COLUMN_KEYS: readonly ColumnKey[] = [
  ...(Object.keys(FIELDS) as ColumnKey[]),
  'position',
  'role',
  'disabled',
];

/** 从任意行对象中只挑出条目列（数据库行含 id/bookId 等额外字段） */
export function pickWorldbookEntryColumns(row: Record<string, unknown>): WorldbookEntryColumns {
  return Object.fromEntries(
    WORLDBOOK_ENTRY_COLUMN_KEYS.map((key) => [key, row[key]]),
  ) as unknown as WorldbookEntryColumns;
}

export function toWorldbookEntryColumns(entry: StWorldbookEntry): WorldbookEntryColumns {
  const raw = entry as Record<string, unknown>;
  const columns: Record<string, unknown> = {};
  for (const [column, spec] of Object.entries(FIELDS)) {
    columns[column] = spec.read(pick(raw, spec.names));
  }
  columns['position'] = positionOf(raw['position']);
  columns['role'] = roleOf(raw['role']);
  columns['disabled'] =
    raw['disable'] !== undefined ? raw['disable'] === true : raw['enabled'] === false;
  return columns as unknown as WorldbookEntryColumns;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 把列值写回原始条目：只改动与原始派生值不同的列；写入时沿用原始条目已有的字段名，
 * 原始条目没有该字段时使用 ST 原生字段名。
 */
export function applyWorldbookEntryColumns(
  entry: StWorldbookEntry,
  columns: Partial<WorldbookEntryColumns>,
): StWorldbookEntry {
  const raw = entry as Record<string, unknown>;
  const base = toWorldbookEntryColumns(entry);
  const out: Record<string, unknown> = { ...raw };
  for (const [column, value] of Object.entries(columns) as [ColumnKey, unknown][]) {
    if (value === undefined || sameValue(value, base[column])) continue;
    if (column === 'disabled') {
      if (raw['disable'] === undefined && raw['enabled'] !== undefined) out['enabled'] = !value;
      else out['disable'] = value;
    } else if (column === 'position') {
      out['position'] = value;
    } else if (column === 'role') {
      const index = ROLE_NAMES.indexOf(value as (typeof ROLE_NAMES)[number]);
      out['role'] = typeof raw['role'] === 'string' || index === -1 ? value : index;
    } else {
      const { names } = FIELDS[column];
      const existing = names.find((name) => raw[name] !== undefined) ?? names[0]!;
      out[existing] = value;
    }
  }
  return out as StWorldbookEntry;
}
