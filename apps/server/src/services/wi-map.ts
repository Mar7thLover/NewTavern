import {
  applyWorldbookEntryColumns,
  pickWorldbookEntryColumns,
  toWorldbookEntryColumns,
  type StWorldbookEntry,
} from '@newtavern/compat';
import { asc, inArray, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { AssembleDepthPrompt, WIBook, WIEntry } from './assemble.js';

/**
 * 世界书表 → 组装流水线的 `WIBook`（M3 契约 §6 第一条）。
 *
 * 条目映射与黄金测试 `tools/golden/src/map.ts` 的 `mapWorldbookEntry` **同源**（跨包 import
 * `tools/**` 不可行，故抄一份）：先用 `applyWorldbookEntryColumns(extra.raw, 列)` 把数据库行
 * 还原成 ST 原始条目——列覆盖 raw，所以被编辑过的字段生效，而 `useProbability` /
 * `vectorized` / `match*` / `outletName` / `triggers` / `characterFilter` 这些没有独立列的
 * 字段仍能从 raw 取到——再走与黄金测试逐字节一致的字段映射。
 */

export type WIScope = WIBook['scope'];
export type LorebookRow = typeof schema.lorebooks.$inferSelect;
export type LorebookEntryRow = typeof schema.lorebookEntries.$inferSelect;

const ROLE_NAMES = ['system', 'user', 'assistant'] as const;

function roleToWiRole(value: unknown): WIEntry['role'] {
  if (typeof value === 'number') return value === 1 || value === 2 ? value : 0;
  if (typeof value === 'string') {
    const index = ROLE_NAMES.indexOf(value as (typeof ROLE_NAMES)[number]);
    return index <= 0 ? 0 : (index as 1 | 2);
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

/** ST 条目 → `WIEntry`（与 `tools/golden/src/map.ts` 的 `mapWorldbookEntry` 一致） */
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
    source: { bookName: bookName, scope },
  };
}

/** 数据库行 → ST 原始条目（列覆盖 `extra.raw`，与 `worldbookFromTable` 同策略） */
export function rowToStEntry(row: LorebookEntryRow): StWorldbookEntry {
  const extra = (row.extra ?? {}) as { raw?: StWorldbookEntry };
  return applyWorldbookEntryColumns(
    extra.raw ?? {},
    pickWorldbookEntryColumns(row as unknown as Record<string, unknown>),
  );
}

/** 一本书（含条目）→ `WIBook`；`scope` 由「这本书在本次组装里的绑定方式」决定，不看表里的列 */
export function bookFromRows(
  book: LorebookRow,
  rows: readonly LorebookEntryRow[],
  scope: WIScope,
): WIBook {
  return {
    id: book.id,
    name: book.name,
    scope,
    entries: rows.map((row, index) =>
      mapWorldbookEntry(rowToStEntry(row), book.id, book.name, scope, index),
    ),
  };
}

function loadEntries(db: Db, bookIds: readonly string[]): Map<string, LorebookEntryRow[]> {
  const out = new Map<string, LorebookEntryRow[]>();
  if (bookIds.length === 0) return out;
  const rows = db
    .select()
    .from(schema.lorebookEntries)
    .where(inArray(schema.lorebookEntries.bookId, [...bookIds]))
    .orderBy(asc(sql`rowid`))
    .all();
  for (const row of rows) {
    const bucket = out.get(row.bookId);
    if (bucket) bucket.push(row);
    else out.set(row.bookId, [row]);
  }
  return out;
}

export interface WIBookSelection {
  /** 设置 KV `worldInfo.globalBookIds` */
  globalBookIds: readonly string[];
  /** `chat_lorebooks` */
  chatBookIds: readonly string[];
  /** `characters.book_id`（ST 的 `extensions.world` 语义） */
  characterBookId: string | null;
  /** `personas.lorebook_id`（ST `persona_description_lorebook`） */
  personaBookId?: string | null;
}

/**
 * 按 AS-13 的优先级组装 `lorebooks`：全局 > 聊天 > persona > 角色，**同名只保留优先级最高的一本**
 * （WI-11：重名去重由服务端做，引擎不管）。同一本书被绑定多次也只算一次。
 * persona 的位置依据 ST `world-info.js`：`getPersonaLore` 跳过与聊天书/全局书同名的书，
 * `getCharacterLore` 跳过与 persona 书同名的书。
 */
export function loadWIBooks(db: Db, selection: WIBookSelection): WIBook[] {
  const wanted: { id: string; scope: WIScope }[] = [];
  const seenId = new Set<string>();
  const push = (id: string | null, scope: WIScope): void => {
    if (!id || seenId.has(id)) return;
    seenId.add(id);
    wanted.push({ id, scope });
  };
  for (const id of selection.globalBookIds) push(id, 'global');
  for (const id of selection.chatBookIds) push(id, 'chat');
  push(selection.personaBookId ?? null, 'persona');
  push(selection.characterBookId, 'char');
  if (wanted.length === 0) return [];

  const books = db
    .select()
    .from(schema.lorebooks)
    .where(
      inArray(
        schema.lorebooks.id,
        wanted.map((item) => item.id),
      ),
    )
    .all();
  const byId = new Map(books.map((book) => [book.id, book]));
  const entries = loadEntries(
    db,
    wanted.map((item) => item.id),
  );

  const out: WIBook[] = [];
  const seenName = new Set<string>();
  for (const item of wanted) {
    const book = byId.get(item.id);
    if (!book || seenName.has(book.name)) continue;
    seenName.add(book.name);
    out.push(bookFromRows(book, entries.get(book.id) ?? [], item.scope));
  }
  return out;
}

/**
 * 卡 `extensions.depth_prompt` → `AssembleInputV2.characterDepthPrompt`
 * （与 `tools/golden/src/map.ts` 的 `mapCharacterDepthPrompt` 一致）。
 */
export function mapCharacterDepthPrompt(
  extensions: Record<string, unknown> | undefined,
): AssembleDepthPrompt | null {
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
