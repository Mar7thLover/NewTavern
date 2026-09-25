import {
  toWorldbookEntryColumns,
  type StWorldbookEntry,
  type WorldbookEntryColumns,
} from '@newtavern/compat';
import { asc, eq, getTableColumns, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { StudioMarker } from '../db/schema.js';
import type { LorebookEntryExtra, LorebookRow, LorebookSettings } from './character-book.js';

/**
 * 世界书编辑：新建空书、整本批量保存（`PUT /api/lorebooks/:id`）。
 *
 * 存储约定不变（docs/M3-CONTRACT.md §3.1）：`extra = { stKey, raw }` 保存原始 ST 条目，
 * 编辑只改列，导出时 `applyWorldbookEntryColumns` 把「与 raw 派生值不同」的列叠回 raw，
 * 未改动的字段（含未知字段）原样保留。
 *
 * 例外：`useProbability` / `vectorized` / `outletName` / 递归等级（数字形态的
 * `delayUntilRecursion`）没有独立列，只能直接写进 `extra.raw`。
 */

export const NEW_LOREBOOK_NAME = '新世界书';

export type EntryRow = typeof schema.lorebookEntries.$inferSelect;
type Json = Record<string, unknown>;

/**
 * ST 1.18 新条目模板：`public/scripts/world-info.js` 的 `newWorldInfoEntryDefinition`
 * 去掉 `excludeFromTemplate` 项（characterFilter*）后的默认值；`createWorldInfoEntry` 生成
 * `{ uid, ...structuredClone(newWorldInfoEntryTemplate) }`，uid 在最前。
 */
export function newStEntryTemplate(uid: number): StWorldbookEntry {
  return {
    uid,
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    triggers: [],
  };
}

/* ------------------------------------------------------------------ */
/* 输入校验                                                             */
/* ------------------------------------------------------------------ */

export type EditableColumn = Exclude<keyof WorldbookEntryColumns, 'uid' | 'displayIndex'>;
export type RawField = 'useProbability' | 'vectorized' | 'outletName';

const isInt = (v: unknown, min: number, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const nullable =
  (check: (v: unknown) => boolean) =>
  (v: unknown): boolean =>
    v === null || check(v);
const isBool = (v: unknown): boolean => typeof v === 'boolean';
const isStr = (v: unknown): boolean => typeof v === 'string';
const isStrArr = (v: unknown): boolean => Array.isArray(v) && v.every(isStr);
const MAX = 1_000_000;

/** 每列的类型与取值范围（范围与 ST 条目编辑界面的 min/max 一致） */
const COLUMN_RULES: Record<EditableColumn, { check: (v: unknown) => boolean; hint: string }> = {
  keys: { check: isStrArr, hint: '字符串数组' },
  secondaryKeys: { check: isStrArr, hint: '字符串数组' },
  content: { check: isStr, hint: '字符串' },
  comment: { check: nullable(isStr), hint: '字符串或 null' },
  constant: { check: isBool, hint: '布尔值' },
  selective: { check: isBool, hint: '布尔值' },
  selectiveLogic: { check: nullable((v) => isInt(v, 0, 3)), hint: '0–3 的整数' },
  position: { check: (v) => isInt(v, 0, 7), hint: '0–7 的整数' },
  depth: { check: nullable((v) => isInt(v, 0, 9999)), hint: '0–9999 的整数' },
  entryOrder: { check: (v) => isInt(v, 0, MAX), hint: '非负整数' },
  probability: { check: nullable((v) => isInt(v, 0, 100)), hint: '0–100 的整数' },
  group: { check: nullable(isStr), hint: '字符串或 null' },
  groupOverride: { check: nullable(isBool), hint: '布尔值或 null' },
  groupWeight: { check: nullable((v) => isInt(v, 1, MAX)), hint: '正整数' },
  scanDepth: { check: nullable((v) => isInt(v, 0, 1000)), hint: '0–1000 的整数' },
  caseSensitive: { check: nullable(isBool), hint: '布尔值或 null' },
  matchWholeWords: { check: nullable(isBool), hint: '布尔值或 null' },
  useGroupScoring: { check: nullable(isBool), hint: '布尔值或 null' },
  automationId: { check: nullable(isStr), hint: '字符串或 null' },
  role: {
    check: (v) => v === null || v === 'system' || v === 'user' || v === 'assistant',
    hint: 'system / user / assistant 或 null',
  },
  disabled: { check: isBool, hint: '布尔值' },
  sticky: { check: nullable((v) => isInt(v, 0, MAX)), hint: '非负整数' },
  cooldown: { check: nullable((v) => isInt(v, 0, MAX)), hint: '非负整数' },
  delay: { check: nullable((v) => isInt(v, 0, MAX)), hint: '非负整数' },
  excludeRecursion: { check: nullable(isBool), hint: '布尔值或 null' },
  preventRecursion: { check: nullable(isBool), hint: '布尔值或 null' },
  // 布尔；数字（≥1）是 ST 的递归等级，没有独立列，写进 raw
  delayUntilRecursion: {
    check: (v) => v === null || isBool(v) || isInt(v, 1, MAX),
    hint: '布尔值、正整数或 null',
  },
  ignoreBudget: { check: nullable(isBool), hint: '布尔值或 null' },
};

const RAW_RULES: Record<RawField, { check: (v: unknown) => boolean; hint: string }> = {
  useProbability: { check: isBool, hint: '布尔值' },
  vectorized: { check: isBool, hint: '布尔值' },
  outletName: { check: isStr, hint: '字符串' },
};

export interface EntryInput {
  id?: string;
  columns: Partial<Record<EditableColumn, unknown>>;
  raw: Partial<Record<RawField, unknown>>;
  /**
   * 新条目的 uid / 原始条目（M6 §2.2 / §3）：版本恢复时，快照里存在、但当前已被删掉的条目
   * 按快照里的 uid 与原始 ST 条目重建（未知字段不丢）；PUT 里无 id 的条目带了 uid 时沿用它
   * （extra 为 null）。uid 已被占用时另分配。
   */
  restore?: { uid: number | null; extra: LorebookEntryExtra | null };
}

export interface SaveInput {
  name?: string;
  entries: EntryInput[];
}

export class LorebookInputError extends Error {}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 校验 PUT 请求体；只校验传入的键，缺席的列保持原值 */
export function parseSaveInput(body: Json): SaveInput {
  const out: SaveInput = { entries: [] };
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      throw new LorebookInputError('name 不能为空');
    }
    out.name = body.name.trim();
  }
  if (!Array.isArray(body.entries)) throw new LorebookInputError('缺少 entries 数组');
  const seen = new Set<string>();
  body.entries.forEach((item, index) => {
    const where = `entries[${index}]`;
    if (!isRecord(item)) throw new LorebookInputError(`${where} 必须是对象`);
    const entry: EntryInput = { columns: {}, raw: {} };
    let uid: number | undefined;
    for (const [key, value] of Object.entries(item)) {
      if (key === 'uid') {
        // 只读字段：新条目（无 id）带了 uid 就尽量沿用（工作台 AI 协作者 add_entry 给出的 uid），
        // 已有条目带 uid 在下面报错（uid 不可改）
        if (value !== null && !(typeof value === 'number' && Number.isInteger(value) && value >= 0)) {
          throw new LorebookInputError(`${where}.uid 应为非负整数`);
        }
        if (typeof value === 'number') uid = value;
      } else if (key === 'id') {
        if (typeof value !== 'string' || value === '') {
          throw new LorebookInputError(`${where}.id 非法`);
        }
        if (seen.has(value)) throw new LorebookInputError(`${where}.id 重复：${value}`);
        seen.add(value);
        entry.id = value;
      } else if (key in COLUMN_RULES) {
        const rule = COLUMN_RULES[key as EditableColumn];
        if (!rule.check(value)) throw new LorebookInputError(`${where}.${key} 应为${rule.hint}`);
        entry.columns[key as EditableColumn] = value;
      } else if (key in RAW_RULES) {
        const rule = RAW_RULES[key as RawField];
        if (!rule.check(value)) throw new LorebookInputError(`${where}.${key} 应为${rule.hint}`);
        entry.raw[key as RawField] = value;
      } else {
        throw new LorebookInputError(`${where}.${key} 不是可编辑字段`);
      }
    }
    // 已有条目的 uid 不可改（改了会让导出的 ST 条目 key 与 uid 脱节），显式报错而不是静默忽略
    if (entry.id !== undefined && uid !== undefined) {
      throw new LorebookInputError(`${where}.uid 不可修改`);
    }
    if (entry.id === undefined && uid !== undefined) entry.restore = { uid, extra: null };
    out.entries.push(entry);
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* 读取                                                                 */
/* ------------------------------------------------------------------ */

/** 条目的展示顺序：ST `displayIndex ?? uid`，同值按插入顺序 */
const DISPLAY_ORDER = [
  asc(sql`coalesce(${schema.lorebookEntries.displayIndex}, ${schema.lorebookEntries.uid})`),
  asc(sql`rowid`),
];

export function loadLorebookDetail(db: Db, id: string) {
  const book = db.select().from(schema.lorebooks).where(eq(schema.lorebooks.id, id)).get();
  if (!book) return undefined;
  const entries = db
    .select()
    .from(schema.lorebookEntries)
    .where(eq(schema.lorebookEntries.bookId, book.id))
    .orderBy(...DISPLAY_ORDER)
    .all();
  return { ...book, entries };
}

export function createEmptyLorebook(db: Db, name: string, studio: StudioMarker | null = null) {
  // ST `createNewWorldInfo` 的文件模板就是 `{ entries: {} }`：书级字段为空，条目用对象形态
  const settings: LorebookSettings = { entriesForm: 'object', meta: {} };
  const row = db
    .insert(schema.lorebooks)
    .values({ name, scope: 'global', settings, studio })
    .returning()
    .get();
  return { ...row, entries: [] as EntryRow[] };
}

/* ------------------------------------------------------------------ */
/* displayIndex                                                         */
/* ------------------------------------------------------------------ */

/**
 * 给「按数组顺序」的条目分配 displayIndex，**尽量少改**：
 * 保留一组已有值（`displayIndex ?? uid`）的最长子序列，使 `值 - 下标` 单调不减——
 * 这正是「保留它们、其余条目能插进去且严格递增」的充要条件；其余条目按相邻保留值顺推。
 * 返回 `null` 的位置表示保留原值（列不动）。
 */
export function planDisplayIndexes(values: readonly (number | null)[]): (number | null)[] {
  const n = values.length;
  // 最长不减子序列（patience sorting + 回溯），只在有值的位置上找
  const tailValue: number[] = [];
  const tailIndex: number[] = [];
  const prev = new Array<number>(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    const key = v - i;
    let lo = 0;
    let hi = tailValue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tailValue[mid]! <= key) lo = mid + 1;
      else hi = mid;
    }
    tailValue[lo] = key;
    tailIndex[lo] = i;
    prev[i] = lo > 0 ? tailIndex[lo - 1]! : -1;
  }
  const kept = new Set<number>();
  for (let i = tailIndex.length > 0 ? tailIndex[tailIndex.length - 1]! : -1; i >= 0; i = prev[i]!) {
    kept.add(i);
  }

  const out: (number | null)[] = new Array<number | null>(n).fill(null);
  if (kept.size === 0) {
    for (let i = 0; i < n; i++) out[i] = i;
    return out;
  }
  const keptList = [...kept].sort((a, b) => a - b);
  const first = keptList[0]!;
  for (let i = 0; i < first; i++) out[i] = values[first]! - (first - i);
  let anchor = first;
  for (let i = first + 1; i < n; i++) {
    if (kept.has(i)) anchor = i;
    else out[i] = values[anchor]! + (i - anchor);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 批量保存                                                             */
/* ------------------------------------------------------------------ */

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 数字形态的 delayUntilRecursion（递归等级）进 raw，列置 null；布尔照常写列 */
export function splitDelayUntilRecursion(columns: EntryInput['columns'], raw: Json): void {
  const value = columns.delayUntilRecursion;
  if (typeof value === 'number') {
    raw.delayUntilRecursion = value;
    columns.delayUntilRecursion = null;
  }
}

/** ST 1.18 所有条目都按 selective 处理：填了次关键词就把 selective 打开，免得过滤不生效 */
export function ensureSelective(columns: EntryInput['columns'], current: boolean): void {
  const secondary = columns.secondaryKeys;
  if (Array.isArray(secondary) && secondary.length > 0 && !current && columns.selective !== false) {
    columns.selective = true;
  }
}

export class LorebookNotFoundError extends Error {}

/**
 * 整本保存（一个事务）：已有 id → 只写传入的列；无 id → 按 ST 模板新建；缺席的旧条目 → 删除；
 * displayIndex 按数组顺序重排（见 `planDisplayIndexes`）。
 */
export function saveLorebook(db: Db, bookId: string, input: SaveInput) {
  return db.transaction((tx) => {
    const book = tx.select().from(schema.lorebooks).where(eq(schema.lorebooks.id, bookId)).get();
    if (!book) throw new LorebookNotFoundError();

    const rows = tx
      .select({ ...getTableColumns(schema.lorebookEntries), rowid: sql<number>`rowid` })
      .from(schema.lorebookEntries)
      .where(eq(schema.lorebookEntries.bookId, bookId))
      .orderBy(...DISPLAY_ORDER)
      .all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const [index, entry] of input.entries.entries()) {
      if (entry.id !== undefined && !byId.has(entry.id)) {
        throw new LorebookInputError(`entries[${index}].id 不属于这本世界书：${entry.id}`);
      }
    }

    const now = new Date();
    const keepIds = new Set(input.entries.flatMap((entry) => (entry.id ? [entry.id] : [])));
    for (const row of rows) {
      if (!keepIds.has(row.id)) {
        tx.delete(schema.lorebookEntries).where(eq(schema.lorebookEntries.id, row.id)).run();
      }
    }

    // 顺序没变、也没有新条目时 displayIndex 一个都不动（含重复值、缺值的书也保持原样）
    const currentOrder = rows.filter((row) => keepIds.has(row.id)).map((row) => row.id);
    const unchangedOrder =
      input.entries.every((entry) => entry.id !== undefined) &&
      sameJson(
        currentOrder,
        input.entries.map((entry) => entry.id),
      );
    const plan = unchangedOrder
      ? input.entries.map(() => null)
      : planDisplayIndexes(
          input.entries.map((entry) => {
            const row = entry.id ? byId.get(entry.id) : undefined;
            return row ? (row.displayIndex ?? row.uid) : null;
          }),
        );

    // 新条目 uid：本书最大 uid（含 stKey 里的数字，避免对象形态 key 撞车）+ 1
    let nextUid = 0;
    for (const row of rows) {
      const stKey = Number((row.extra as LorebookEntryExtra | null)?.stKey);
      nextUid = Math.max(nextUid, (row.uid ?? -1) + 1, Number.isInteger(stKey) ? stKey + 1 : 0);
    }

    // 版本恢复重建已删条目时，快照里的 uid 只在没被留下的条目占用时才复用
    const usedUids = new Set(
      rows.filter((row) => keepIds.has(row.id) && row.uid !== null).map((row) => row.uid as number),
    );

    input.entries.forEach((entry, index) => {
      const columns = { ...entry.columns };
      const displayIndex = plan[index];
      const row = entry.id ? byId.get(entry.id) : undefined;

      if (row) {
        const extra = structuredClone((row.extra ?? {}) as LorebookEntryExtra);
        const raw = { ...((extra.raw ?? {}) as Json) };
        splitDelayUntilRecursion(columns, raw);
        ensureSelective(columns, row.selective);
        for (const [key, value] of Object.entries(entry.raw)) raw[key] = value;
        const rawChanged = !sameJson(raw, extra.raw ?? {});
        const set: Json = { ...columns };
        if (displayIndex !== null && displayIndex !== row.displayIndex) {
          set.displayIndex = displayIndex;
        }
        if (rawChanged) set.extra = { ...extra, raw };
        if (Object.keys(set).length === 0) return;
        tx.update(schema.lorebookEntries)
          .set({ ...set, updatedAt: now })
          .where(eq(schema.lorebookEntries.id, row.id))
          .run();
        return;
      }

      const restoreUid = entry.restore?.uid;
      const reuse =
        typeof restoreUid === 'number' && Number.isInteger(restoreUid) && !usedUids.has(restoreUid);
      const uid = reuse ? restoreUid : nextUid++;
      usedUids.add(uid);
      nextUid = Math.max(nextUid, uid + 1);
      const restoredRaw = entry.restore?.extra?.raw;
      const raw = (
        restoredRaw ? { ...structuredClone(restoredRaw), uid } : newStEntryTemplate(uid)
      ) as Json;
      splitDelayUntilRecursion(columns, raw);
      ensureSelective(columns, true);
      for (const [key, value] of Object.entries(entry.raw)) raw[key] = value;
      const stKey = (reuse ? entry.restore?.extra?.stKey : undefined) ?? String(uid);
      const extra: LorebookEntryExtra = { stKey, raw: raw as StWorldbookEntry };
      tx.insert(schema.lorebookEntries)
        .values({
          ...toWorldbookEntryColumns(raw as StWorldbookEntry),
          ...columns,
          uid,
          displayIndex: displayIndex ?? null,
          bookId,
          extra,
        } as typeof schema.lorebookEntries.$inferInsert)
        .run();
    });

    const name = input.name ?? book.name;
    const settings = syncMetaName(book, name);
    tx.update(schema.lorebooks)
      .set({ name, ...(settings ? { settings } : {}), updatedAt: now })
      .where(eq(schema.lorebooks.id, bookId))
      .run();
  });
}

/** 书级 meta 自带 name 时与列保持一致；ST 世界书文件大多没有这个字段，不凭空添加 */
export function syncMetaName(book: LorebookRow, name: string): LorebookSettings | undefined {
  const settings = (book.settings ?? {}) as LorebookSettings;
  const meta = settings.meta;
  if (!meta || !('name' in meta) || meta.name === name) return undefined;
  return { ...settings, meta: { ...meta, name } };
}

/* ------------------------------------------------------------------ */
/* 版本快照（M6 §2.2）                                                   */
/* ------------------------------------------------------------------ */

/** 快照里的一条：PUT 的可编辑字段 + id / uid + 原始 ST 条目（恢复已删条目时用） */
export type LorebookSnapshotEntry = {
  id: string;
  uid: number | null;
  extra: LorebookEntryExtra;
} & {
  [K in EditableColumn | RawField]?: unknown;
};

export interface LorebookSnapshot {
  name: string;
  entries: LorebookSnapshotEntry[];
}

export const EDITABLE_COLUMNS = Object.keys(COLUMN_RULES) as EditableColumn[];
export const RAW_FIELDS = Object.keys(RAW_RULES) as RawField[];

/**
 * 世界书的版本数据：`{ name, entries }`，条目取 PUT 的可编辑字段（与编辑器草稿同形），
 * 另带 id / uid / extra。不含 createdAt / updatedAt，内容不变时两次快照 JSON 相同。
 */
export function lorebookSnapshot(db: Db, id: string): LorebookSnapshot | undefined {
  const detail = loadLorebookDetail(db, id);
  if (!detail) return undefined;
  return {
    name: detail.name,
    entries: detail.entries.map((row) => {
      const extra = (row.extra ?? {}) as LorebookEntryExtra;
      const raw = (extra.raw ?? {}) as Json;
      const entry: LorebookSnapshotEntry = { id: row.id, uid: row.uid, extra };
      for (const key of EDITABLE_COLUMNS) entry[key] = row[key];
      // 递归等级（数字）只在 raw 里，列为 null
      if (row.delayUntilRecursion === null && typeof raw.delayUntilRecursion === 'number') {
        entry.delayUntilRecursion = raw.delayUntilRecursion;
      }
      for (const key of RAW_FIELDS) {
        if (raw[key] !== undefined && RAW_RULES[key].check(raw[key])) entry[key] = raw[key];
      }
      return entry;
    }),
  };
}

/**
 * 快照 → `saveLorebook` 的输入。快照来自本库，不再逐字段校验；
 * 当前书里已不存在的条目去掉 id、带上 `restore`，按原 uid / 原始条目重建。
 */
export function snapshotToSaveInput(db: Db, bookId: string, snapshot: unknown): SaveInput {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.entries)) {
    throw new LorebookInputError('版本数据不是世界书快照');
  }
  const existing = new Set(
    db
      .select({ id: schema.lorebookEntries.id })
      .from(schema.lorebookEntries)
      .where(eq(schema.lorebookEntries.bookId, bookId))
      .all()
      .map((row) => row.id),
  );
  const entries = snapshot.entries.filter(isRecord).map((item): EntryInput => {
    const columns: EntryInput['columns'] = {};
    const raw: EntryInput['raw'] = {};
    for (const key of EDITABLE_COLUMNS) if (key in item) columns[key] = item[key];
    for (const key of RAW_FIELDS) if (key in item) raw[key] = item[key];
    const id = typeof item.id === 'string' ? item.id : undefined;
    if (id !== undefined && existing.has(id)) return { id, columns, raw };
    return {
      columns,
      raw,
      restore: {
        uid: typeof item.uid === 'number' ? item.uid : null,
        extra: isRecord(item.extra) ? (item.extra as LorebookEntryExtra) : null,
      },
    };
  });
  const name =
    typeof snapshot.name === 'string' && snapshot.name.trim() ? snapshot.name.trim() : undefined;
  return { ...(name ? { name } : {}), entries };
}
