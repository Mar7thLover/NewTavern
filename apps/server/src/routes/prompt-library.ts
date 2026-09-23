import { desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { schema, type Db } from '../db/client.js';

/**
 * 提示库（M6 §2.3）：可复用的提示片段。
 * `GET /`（`?q=` 按名称与内容模糊匹配、`?tag=` 按标签）、`POST /`、`PUT /:id`、`DELETE /:id`。
 */

export type PromptRole = 'system' | 'user' | 'assistant';

/** 列表 / 详情的形状（前端复用） */
export interface PromptLibraryItem {
  id: string;
  name: string;
  content: string;
  role: PromptRole | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** POST（name 必填）/ PUT（全部可选）的请求体 */
export interface PromptLibraryInput {
  name?: string;
  content?: string;
  role?: PromptRole | null;
  tags?: string[];
}

type Row = typeof schema.promptLibrary.$inferSelect;
type Patch = Partial<typeof schema.promptLibrary.$inferInsert>;

const ROLES: readonly PromptRole[] = ['system', 'user', 'assistant'];

class InputError extends Error {}

function toItem(row: Row): PromptLibraryItem {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    role: ROLES.includes(row.role as PromptRole) ? (row.role as PromptRole) : null,
    tags: row.tags,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseInput(body: Record<string, unknown>): Patch {
  const patch: Patch = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      throw new InputError('name 不能为空');
    }
    patch.name = body.name.trim();
  }
  if (body.content !== undefined) {
    if (typeof body.content !== 'string') throw new InputError('content 必须是字符串');
    patch.content = body.content;
  }
  if (body.role !== undefined) {
    if (body.role !== null && !ROLES.includes(body.role as PromptRole)) {
      throw new InputError('role 只能是 system / user / assistant 或 null');
    }
    patch.role = body.role as PromptRole | null;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== 'string')) {
      throw new InputError('tags 必须是字符串数组');
    }
    patch.tags = [...new Set((body.tags as string[]).map((tag) => tag.trim()).filter(Boolean))];
  }
  return patch;
}

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

export function createPromptLibraryRoutes(db: Db) {
  return new Hono()
    .get('/', (c) => {
      const q = (c.req.query('q') ?? '').trim().toLowerCase();
      const tag = (c.req.query('tag') ?? '').trim();
      // 片段数量不大，取全表后在内存里过滤（中文不受 SQLite LIKE 的大小写规则影响）
      const rows = db
        .select()
        .from(schema.promptLibrary)
        .orderBy(desc(schema.promptLibrary.updatedAt))
        .all();
      const items = rows
        .filter(
          (row) =>
            q === '' || row.name.toLowerCase().includes(q) || row.content.toLowerCase().includes(q),
        )
        .filter((row) => tag === '' || row.tags.includes(tag))
        .map(toItem);
      return c.json(items);
    })
    .post('/', async (c) => {
      const body = await readJsonObject(c);
      if (!body) return c.json({ error: 'invalid', message: '请求体不是合法的 JSON 对象' }, 400);
      let patch: Patch;
      try {
        patch = parseInput(body);
      } catch (e) {
        if (e instanceof InputError) return c.json({ error: 'invalid', message: e.message }, 400);
        throw e;
      }
      if (!patch.name) return c.json({ error: 'invalid', message: '缺少 name' }, 400);
      const row = db
        .insert(schema.promptLibrary)
        .values({ ...patch, name: patch.name })
        .returning()
        .get();
      return c.json(toItem(row), 201);
    })
    .put('/:id', async (c) => {
      const body = await readJsonObject(c);
      if (!body) return c.json({ error: 'invalid', message: '请求体不是合法的 JSON 对象' }, 400);
      let patch: Patch;
      try {
        patch = parseInput(body);
      } catch (e) {
        if (e instanceof InputError) return c.json({ error: 'invalid', message: e.message }, 400);
        throw e;
      }
      const row = db
        .update(schema.promptLibrary)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.promptLibrary.id, c.req.param('id')))
        .returning()
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.json(toItem(row));
    })
    .delete('/:id', (c) => {
      const row = db
        .delete(schema.promptLibrary)
        .where(eq(schema.promptLibrary.id, c.req.param('id')))
        .returning()
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.body(null, 204);
    });
}
