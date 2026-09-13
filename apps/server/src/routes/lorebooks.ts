import { asc, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { schema, type Db } from '../db/client.js';
import type { Importer } from '../services/importer.js';
import { sendDownload } from './download.js';

/** 世界书库：列表（含条目数）/详情（含条目）/删除/导出。导入见 routes/import.ts。 */
export function createLorebooksRoutes(db: Db, importer: Importer) {
  return new Hono()
    .get('/', (c) => {
      const books = db
        .select()
        .from(schema.lorebooks)
        .orderBy(desc(schema.lorebooks.updatedAt))
        .all();
      const result = books.map((book) => ({
        ...book,
        entryCount: db
          .select({ id: schema.lorebookEntries.id })
          .from(schema.lorebookEntries)
          .where(eq(schema.lorebookEntries.bookId, book.id))
          .all().length,
      }));
      return c.json(result);
    })
    .get('/:id', (c) => {
      const book = db
        .select()
        .from(schema.lorebooks)
        .where(eq(schema.lorebooks.id, c.req.param('id')))
        .get();
      if (!book) return c.json({ error: 'not_found' }, 404);
      const entries = db
        .select()
        .from(schema.lorebookEntries)
        .where(eq(schema.lorebookEntries.bookId, book.id))
        .orderBy(asc(schema.lorebookEntries.displayIndex))
        .all();
      return c.json({ ...book, entries });
    })
    .get('/:id/export', (c) => sendDownload(c, importer.exportLorebook(c.req.param('id'))))
    .delete('/:id', (c) => {
      const row = db
        .delete(schema.lorebooks)
        .where(eq(schema.lorebooks.id, c.req.param('id')))
        .returning()
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.body(null, 204);
    });
}
