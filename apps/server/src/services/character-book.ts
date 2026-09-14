import {
  applyWorldbookEntryColumns,
  buildWorldbook,
  listWorldbookEntries,
  pickWorldbookEntryColumns,
  toWorldbookEntryColumns,
  type StWorldbook,
  type StWorldbookEntry,
  type WorldbookEntriesForm,
} from '@newtavern/compat';
import { asc, eq, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';

/**
 * 世界书表 ↔ ST JSON 的重建，以及角色卡内嵌世界书（`data.character_book`）抽表。
 * 见 docs/M3-CONTRACT.md §3.1。
 *
 * 存储约定：`lorebook_entries.extra = { stKey, raw }` 保留原始 ST 条目，
 * 重建时以 raw 为底叠加列值（applyWorldbookEntryColumns 只写「与原始派生值不同」的列），保证无损。
 */

export type CharacterRow = typeof schema.characters.$inferSelect;
export type LorebookRow = typeof schema.lorebooks.$inferSelect;

/** lorebooks.settings 的形状：书级 ST 字段（entries 之外）与条目容器形态 */
// 用 type 而非 interface：Drizzle 的 JSON 列要求可赋给 Record<string, unknown>（隐式索引签名）
export type LorebookSettings = {
  entriesForm?: WorldbookEntriesForm;
  meta?: Record<string, unknown>;
};

export type LorebookEntryExtra = {
  stKey?: string;
  raw?: StWorldbookEntry;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 由表重建 ST 世界书 JSON（导出世界书与重建 character_book 共用） */
export function worldbookFromTable(db: Db, book: LorebookRow): StWorldbook {
  const rows = db
    .select()
    .from(schema.lorebookEntries)
    .where(eq(schema.lorebookEntries.bookId, book.id))
    .orderBy(asc(sql`rowid`))
    .all();
  const settings = (book.settings ?? {}) as LorebookSettings;
  const items = rows.map((row, index) => {
    const extra = (row.extra ?? {}) as LorebookEntryExtra;
    return {
      key: extra.stKey ?? String(row.uid ?? index),
      entry: applyWorldbookEntryColumns(extra.raw ?? {}, pickWorldbookEntryColumns(row)),
    };
  });
  return buildWorldbook(
    settings.meta ?? { name: book.name },
    settings.entriesForm ?? 'object',
    items,
  );
}

/**
 * 把角色卡的 `data.character_book` 抽成 scope='char' 的书并回填 `characters.book_id`。
 * `data.character_book` **原样保留**（未修改的卡导出时仍走原始字节）。
 * 已有 book_id 或没有条目时返回 null（幂等）。
 */
export function extractCharacterBook(db: Db, character: CharacterRow): string | null {
  if (character.bookId) return null;
  const data = (character.data ?? {}) as Record<string, unknown>;
  const raw = data['character_book'];
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw['entries']) && !isRecord(raw['entries'])) return null;

  const { form, items } = listWorldbookEntries(raw as unknown as StWorldbook);
  if (items.length === 0) return null;

  const { entries: _entries, ...meta } = raw;
  const name =
    typeof raw['name'] === 'string' && raw['name'].trim()
      ? raw['name']
      : `${character.name}的世界书`;
  const settings: LorebookSettings = { entriesForm: form, meta };

  // createdAt 对齐角色导入时间：之后判断「书被编辑过」只需比较 updatedAt > createdAt
  const book = db
    .insert(schema.lorebooks)
    .values({
      name,
      scope: 'char',
      settings,
      createdAt: character.createdAt,
      updatedAt: character.createdAt,
    })
    .returning()
    .get();
  for (const item of items) {
    const extra: LorebookEntryExtra = { stKey: item.key, raw: item.entry };
    db.insert(schema.lorebookEntries)
      .values({ ...toWorldbookEntryColumns(item.entry), bookId: book.id, extra })
      .run();
  }
  db.update(schema.characters)
    .set({ bookId: book.id })
    .where(eq(schema.characters.id, character.id))
    .run();
  return book.id;
}

/**
 * 「编辑过的角色」导出时重建 `character_book`。
 *
 * M1/M3 还没有「编辑角色」路由，所以判定规则是契约 §3.1 的退化版：
 * book_id 有值且书的 updated_at **晚于**书的 created_at（抽表时被置为角色导入时间）
 * → 视为书被编辑过，用表重建；否则返回 null，导出仍走卡内原始 `character_book`。
 */
export function rebuildCharacterBook(db: Db, character: CharacterRow): StWorldbook | null {
  if (!character.bookId) return null;
  const book = db
    .select()
    .from(schema.lorebooks)
    .where(eq(schema.lorebooks.id, character.bookId))
    .get();
  if (!book) return null;
  if (book.updatedAt.getTime() <= book.createdAt.getTime()) return null;
  return worldbookFromTable(db, book);
}
