import { collectBookOpeners, type BookOpener } from '@newtavern/core';
import { asc, inArray, sql } from 'drizzle-orm';

import { bookFromRows, type LorebookEntryRow } from './wi-map.js';
import { schema, type Db } from '../db/client.js';

/**
 * 世界书自带的开场白：把库里的书读成 `WIBook` 后交给 core 的 `collectBookOpeners`。
 *
 * 判定规则与排序都在 core（`worldinfo/openers.ts`）里，这里只负责取数据。
 * 新建对话时用它把开场白铺成根节点的 swipe 兄弟，世界书库/新建对话页用计数决定是否展示。
 */

export type { BookOpener } from '@newtavern/core';

function loadEntriesByBook(db: Db, bookIds: readonly string[]): Map<string, LorebookEntryRow[]> {
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

/** 按传入顺序收集这些书的开场白；不存在的 id 直接跳过 */
export function loadBookOpeners(db: Db, bookIds: readonly string[]): BookOpener[] {
  const unique = [...new Set(bookIds)];
  if (unique.length === 0) return [];

  const rows = db.select().from(schema.lorebooks).where(inArray(schema.lorebooks.id, unique)).all();
  const byId = new Map(rows.map((book) => [book.id, book]));
  const entries = loadEntriesByBook(db, unique);

  const books = unique.flatMap((id) => {
    const book = byId.get(id);
    return book ? [bookFromRows(book, entries.get(id) ?? [], 'chat')] : [];
  });
  return collectBookOpeners(books);
}

export interface OpenerCounts {
  greeting: number;
  prefill: number;
}

/** 世界书列表用：每本书的开场白条数，按来源分开计 */
export function countOpenersByBook(db: Db, bookIds: readonly string[]): Map<string, OpenerCounts> {
  const out = new Map<string, OpenerCounts>();
  for (const id of bookIds) out.set(id, { greeting: 0, prefill: 0 });
  for (const opener of loadBookOpeners(db, bookIds)) {
    const counts = out.get(opener.bookId);
    if (counts) counts[opener.kind] += 1;
  }
  return out;
}
