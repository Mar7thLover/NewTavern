import { isNull } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { extractCharacterBook } from './character-book.js';

/**
 * 启动时的一次性回填（幂等）。见 docs/M3-CONTRACT.md §3.1。
 * M1 导入的角色卡没有抽表，这里补上：`book_id IS NULL` 且 `data.character_book.entries` 非空的卡。
 */
export function backfillCharacterBooks(db: Db): { characters: number } {
  const rows = db.select().from(schema.characters).where(isNull(schema.characters.bookId)).all();
  let characters = 0;
  for (const row of rows) {
    if (extractCharacterBook(db, row)) characters += 1;
  }
  if (characters > 0) {
    console.log(`[newtavern] 回填角色卡内嵌世界书：${characters} 张`);
  }
  return { characters };
}
