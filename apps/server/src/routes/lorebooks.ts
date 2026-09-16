import { desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { schema, type Db } from '../db/client.js';
import type { Importer } from '../services/importer.js';
import {
  LorebookInputError,
  LorebookNotFoundError,
  NEW_LOREBOOK_NAME,
  createEmptyLorebook,
  loadLorebookDetail,
  parseSaveInput,
  saveLorebook,
} from '../services/lorebook-edit.js';
import { countOpenersByBook } from '../services/openers.js';
import { sendDownload } from './download.js';

async function readJsonObject(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 世界书库：列表（含条目数）/详情（含条目）/新建/整本保存/删除/导出。导入见 routes/import.ts。
 *
 * `PUT /:id` body `{ name?, entries: EntryInput[] }`：数组就是保存后的完整条目列表（顺序即展示顺序）。
 * 有 id 的条目只写传入的字段，无 id 的按 ST 模板新建，缺席的旧条目删除。详见 services/lorebook-edit.ts。
 */
export function createLorebooksRoutes(db: Db, importer: Importer) {
  return (
    new Hono()
      .get('/', (c) => {
        const books = db
          .select()
          .from(schema.lorebooks)
          .orderBy(desc(schema.lorebooks.updatedAt))
          .all();
        const openers = countOpenersByBook(
          db,
          books.map((book) => book.id),
        );
        const result = books.map((book) => ({
          ...book,
          entryCount: db
            .select({ id: schema.lorebookEntries.id })
            .from(schema.lorebookEntries)
            .where(eq(schema.lorebookEntries.bookId, book.id))
            .all().length,
          // 新建对话页据此筛「能当开场用的书」，见 services/openers.ts
          openerCounts: openers.get(book.id) ?? { greeting: 0, prefill: 0 },
        }));
        return c.json(result);
      })
      /** 新建空世界书：`{ name? }`，缺省「新世界书」 */
      .post('/', async (c) => {
        // 请求体可省略（空体 / 非对象都按 {} 处理）
        const body = (await readJsonObject(c)) ?? {};
        if (body.name !== undefined && typeof body.name !== 'string') {
          return c.json({ error: 'invalid', message: 'name 非法' }, 400);
        }
        const name = (typeof body.name === 'string' && body.name.trim()) || NEW_LOREBOOK_NAME;
        return c.json(createEmptyLorebook(db, name), 201);
      })
      .get('/:id', (c) => {
        const detail = loadLorebookDetail(db, c.req.param('id'));
        if (!detail) return c.json({ error: 'not_found' }, 404);
        return c.json(detail);
      })
      .put('/:id', async (c) => {
        const id = c.req.param('id');
        if (!loadLorebookDetail(db, id)) return c.json({ error: 'not_found' }, 404);
        const body = await readJsonObject(c);
        if (!body) return c.json({ error: 'invalid', message: '请求体不是合法的 JSON 对象' }, 400);
        try {
          saveLorebook(db, id, parseSaveInput(body));
        } catch (e) {
          if (e instanceof LorebookNotFoundError) return c.json({ error: 'not_found' }, 404);
          if (e instanceof LorebookInputError) {
            return c.json({ error: 'invalid', message: e.message }, 400);
          }
          throw e;
        }
        return c.json(loadLorebookDetail(db, id));
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
      })
  );
}
