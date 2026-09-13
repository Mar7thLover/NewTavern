import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * KV 设置表：连接档案之外的全局配置、全局系统提示词覆盖层等。
 * 领域表（characters / presets / lorebooks / chats / message_nodes …）自 M1 起添加，
 * 完整清单见 docs/PLAN.md §3.3。
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
});
