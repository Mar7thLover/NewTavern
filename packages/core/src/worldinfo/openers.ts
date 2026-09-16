/**
 * 世界书自带的开场白（opener）。
 *
 * 两个来源，互不混用：
 *
 * - **greeting**：CCv3 装饰器 `@@is_greeting <n>`。这是规范里专门表示「这条不是世界书内容，
 *   而是角色的第 n 条开场白」的写法，`scanWorldInfo` 会把它直接拒掉（reason `greeting`），
 *   内容只在这里取用。序号即 swipe 顺序，`@@is_greeting` 不带参数时视作第 0 条。
 * - **prefill**：条目 `role = assistant`（ST `extension_prompt_roles` 的 2）。它在组装里
 *   是**真的** assistant prefill（@depth 注入，depth 0 时落在末尾），这里并不改变那条链路，
 *   只是额外把它的内容作为「可以从这段之后开始」的开场白候选提供给新建对话页。
 *
 * 两者同时存在时 greeting 排在前面（它是显式声明的开场白，prefill 只是推测）。
 */

import { applyDecorators } from './decorators.js';
import type { WIBook, WIEntry } from './types.js';

export type BookOpenerKind = 'greeting' | 'prefill';

export interface BookOpener {
  bookId: string;
  bookName: string;
  /** `WIEntry.id`，形如 `${bookId}:${uid}` */
  entryId: string;
  kind: BookOpenerKind;
  /** greeting = `@@is_greeting` 的序号；prefill = 条目的 @depth（缺省 0） */
  index: number;
  /** 条目标题（ST comment），空则回落到书名 */
  label: string;
  /** 已剥掉装饰器行的正文 */
  content: string;
}

/** 该条目能否作为开场白来源；返回 undefined 表示不能 */
function openerKind(entry: WIEntry): BookOpenerKind | undefined {
  if (entry.disabled) return undefined;
  if (entry.content.trim() === '') return undefined;
  if (entry.isGreeting !== undefined) return 'greeting';
  return entry.role === 2 ? 'prefill' : undefined;
}

/**
 * 从若干本书里收集开场白候选。
 *
 * 顺序 = greeting（按 `@@is_greeting` 序号）在前、prefill（按 @depth 由浅到深）在后，
 * 同组内按传入的书顺序、书内条目顺序稳定排列 —— 即新建对话时的 swipe 顺序。
 */
export function collectBookOpeners(books: readonly WIBook[]): BookOpener[] {
  const found: { opener: BookOpener; bookSeq: number; entrySeq: number }[] = [];

  books.forEach((book, bookSeq) => {
    book.entries.forEach((raw, entrySeq) => {
      const entry = applyDecorators(raw);
      const kind = openerKind(entry);
      if (kind === undefined) return;
      found.push({
        bookSeq,
        entrySeq,
        opener: {
          bookId: book.id,
          bookName: book.name,
          entryId: entry.id,
          kind,
          index: kind === 'greeting' ? (entry.isGreeting ?? 0) : (entry.depth ?? 0),
          label: entry.comment?.trim() || book.name,
          content: entry.content,
        },
      });
    });
  });

  return found
    .sort((a, b) => {
      if (a.opener.kind !== b.opener.kind) return a.opener.kind === 'greeting' ? -1 : 1;
      if (a.opener.index !== b.opener.index) return a.opener.index - b.opener.index;
      if (a.bookSeq !== b.bookSeq) return a.bookSeq - b.bookSeq;
      return a.entrySeq - b.entrySeq;
    })
    .map((item) => item.opener);
}
