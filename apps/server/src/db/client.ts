import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

/** 打开（必要时创建）数据库并启用 WAL。传 ':memory:' 用于测试。 */
export function createDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return drizzle(sqlite, { schema });
}

export { schema };
