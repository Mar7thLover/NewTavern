import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import type { Db } from './client.js';

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
);

/** 启动时执行 SQL 迁移（drizzle-kit generate 产物，提交入库） */
export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder });
}
