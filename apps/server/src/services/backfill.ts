import { isNull } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { extractCharacterBook } from './character-book.js';
import { extractEmbeddedRegex } from './embedded-regex.js';

/**
 * 启动时的一次性回填（幂等）。见 docs/M3-CONTRACT.md §3.1 / §3.2。
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

/**
 * 回填「卡 / 预设 / 世界书自带的正则」（§3.2 修正，2026-09-18）。
 *
 * 启用状态刻意分两种，避免一次升级把别人的对话改了模样：
 * - **角色卡**自带的正则在这次改动之前**本来就在生效**（组装时直接读卡），
 *   所以按原件里的开关回填，保持现状；
 * - **预设 / 世界书**自带的以前从没生效过，回填成关闭，让用户自己在
 *   「设置 · 正则脚本」里决定开不开（新导入的会弹窗问）。
 */
export function backfillEmbeddedRegex(db: Db): { character: number; preset: number; book: number } {
  const counts = { character: 0, preset: 0, book: 0 };

  for (const row of db.select().from(schema.characters).all()) {
    counts.character += extractEmbeddedRegex(db, {
      scope: 'character',
      ownerId: row.id,
      ownerName: row.name,
      data: row.data,
      enabled: true,
    });
  }
  for (const row of db.select().from(schema.presets).all()) {
    counts.preset += extractEmbeddedRegex(db, {
      scope: 'preset',
      ownerId: row.id,
      ownerName: row.name,
      data: row.data,
    });
  }
  for (const row of db.select().from(schema.lorebooks).all()) {
    const settings = (row.settings ?? {}) as { meta?: unknown };
    counts.book += extractEmbeddedRegex(db, {
      scope: 'book',
      ownerId: row.id,
      ownerName: row.name,
      // 世界书的原始 JSON 存在 settings.meta 里（entries 之外的字段）
      data: settings.meta,
    });
  }

  const total = counts.character + counts.preset + counts.book;
  if (total > 0) {
    console.log(
      `[newtavern] 回填自带正则：角色卡 ${counts.character} 条（保持原状态）、` +
        `预设 ${counts.preset} 条、世界书 ${counts.book} 条（后两类默认关闭，在设置里开）`,
    );
  }
  return counts;
}
