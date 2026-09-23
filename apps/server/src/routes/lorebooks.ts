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
import { DraftInputError } from '../services/studio-draft.js';
import {
  simulateLorebook,
  type SimulateActivated,
  type SimulateResult,
  type SimulateSkipped,
} from '../services/studio-simulate.js';
import { parseAuthor, recordCurrentVersion } from '../services/versions.js';
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

/** `POST /api/lorebooks/:id/simulate` 的请求体（M6 §2.5；前端复用） */
export interface LorebookSimulateRequest {
  text: string;
  /** 草稿条目，形态同 PUT 的 entries；缺省用已保存的条目 */
  entries?: Record<string, unknown>[];
  /** 覆盖全局扫描深度 */
  scanDepth?: number;
}
export type { SimulateActivated, SimulateResult as LorebookSimulateResponse, SimulateSkipped };

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
        const created = createEmptyLorebook(db, name);
        recordCurrentVersion(db, 'lorebook', created.id);
        return c.json(created, 201);
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
          // 每次保存写一版（与上一版相同则不写，M6 §2.2）
          recordCurrentVersion(db, 'lorebook', id, parseAuthor(body.author));
        } catch (e) {
          if (e instanceof LorebookNotFoundError) return c.json({ error: 'not_found' }, 404);
          if (e instanceof LorebookInputError) {
            return c.json({ error: 'invalid', message: e.message }, 400);
          }
          throw e;
        }
        return c.json(loadLorebookDetail(db, id));
      })
      /**
       * 触发模拟（M6 §2.5）：`{ text, entries?, scanDepth? }` → 把 text 当作一条用户消息扫描这本书一次。
       * 不推进时间态、不落库；entries 给了就用草稿条目。
       */
      .post('/:id/simulate', async (c) => {
        const id = c.req.param('id');
        if (!loadLorebookDetail(db, id)) return c.json({ error: 'not_found' }, 404);
        const body = await readJsonObject(c);
        if (!body) return c.json({ error: 'invalid', message: '请求体不是合法的 JSON 对象' }, 400);
        if (typeof body.text !== 'string') {
          return c.json({ error: 'invalid', message: 'text 必须是字符串' }, 400);
        }
        const scanDepth = body.scanDepth;
        if (
          scanDepth !== undefined &&
          scanDepth !== null &&
          !(typeof scanDepth === 'number' && Number.isInteger(scanDepth) && scanDepth >= 0)
        ) {
          return c.json({ error: 'invalid', message: 'scanDepth 应为非负整数' }, 400);
        }
        try {
          const entries =
            body.entries === undefined || body.entries === null
              ? undefined
              : parseSaveInput({ entries: body.entries }).entries;
          const result = simulateLorebook(db, id, {
            text: body.text,
            ...(entries ? { entries } : {}),
            ...(typeof scanDepth === 'number' ? { scanDepth } : {}),
          });
          if (!result) return c.json({ error: 'not_found' }, 404);
          return c.json(result);
        } catch (e) {
          if (e instanceof LorebookInputError || e instanceof DraftInputError) {
            return c.json({ error: 'invalid', message: e.message }, 400);
          }
          throw e;
        }
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
