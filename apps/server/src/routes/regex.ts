import { asc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { schema, type Db } from '../db/client.js';
import {
  nextGlobalOrder,
  ownerNames,
  setOwnerRegexEnabled,
  type EmbeddedScope,
} from '../services/embedded-regex.js';
import {
  flagsToDirection,
  toRegexScript,
  type RegexScript,
  type RegexScriptRow,
} from '../services/regex-map.js';

/**
 * 正则脚本 CRUD、排序与「自带脚本」的启停。见 docs/M3-CONTRACT.md §3.2（含 2026-09-18 修正）。
 *
 * 表里有四类：`global` 是用户自己导入 / 新建的；`character` / `preset` / `book`
 * 是卡 / 预设 / 世界书自带、导入时抽进来的（`services/embedded-regex.ts`）。
 * `GET /` 默认只给 global（显示侧正则要的就是它）；`?scope=all` 给全部并带来源名。
 */

type ScriptInput = Omit<RegexScript, 'id' | 'scope'>;

const SUBSTITUTE_VALUES = [0, 1, 2];

function listScripts(db: Db): RegexScript[] {
  return db
    .select()
    .from(schema.regexScripts)
    .where(eq(schema.regexScripts.scope, 'global'))
    .orderBy(asc(schema.regexScripts.displayOrder), asc(schema.regexScripts.createdAt))
    .all()
    .map(toRegexScript);
}

/** 带来源信息的脚本（设置页按来源分组用） */
export interface OwnedRegexScript extends RegexScript {
  ownerId: string | null;
  /** 角色卡 / 预设 / 世界书的当前名字（来源已删除时用抽表时记下的） */
  ownerName: string | null;
}

function listAllScripts(db: Db): OwnedRegexScript[] {
  const rows = db
    .select()
    .from(schema.regexScripts)
    .orderBy(asc(schema.regexScripts.displayOrder), asc(schema.regexScripts.createdAt))
    .all();
  const names = ownerNames(db, rows);
  return rows.map((row) => {
    const extra = (row.extra ?? {}) as { ownerName?: string };
    return {
      ...toRegexScript(row),
      ownerId: row.ownerId,
      ownerName:
        row.scope === 'global' || !row.ownerId
          ? null
          : (names.get(`${row.scope}:${row.ownerId}`) ?? extra.ownerName ?? null),
    };
  });
}

const EMBEDDED_SCOPES: readonly EmbeddedScope[] = ['character', 'preset', 'book'];

function isEmbeddedScope(value: unknown): value is EmbeddedScope {
  return typeof value === 'string' && (EMBEDDED_SCOPES as readonly string[]).includes(value);
}

/** 校验请求体；partial=true 时只校验出现过的字段。返回错误消息或字段增量 */
function readBody(
  body: Record<string, unknown>,
  partial: boolean,
): { error: string } | { patch: Partial<ScriptInput> } {
  const patch: Partial<ScriptInput> = {};
  if (body.name !== undefined || !partial) {
    if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'name 非法' };
    patch.name = body.name;
  }
  if (body.findRegex !== undefined || !partial) {
    if (typeof body.findRegex !== 'string' || !body.findRegex) return { error: 'findRegex 非法' };
    patch.findRegex = body.findRegex;
  }
  if (body.replaceString !== undefined) {
    if (typeof body.replaceString !== 'string') return { error: 'replaceString 非法' };
    patch.replaceString = body.replaceString;
  }
  if (body.trimStrings !== undefined) {
    if (!Array.isArray(body.trimStrings) || body.trimStrings.some((s) => typeof s !== 'string')) {
      return { error: 'trimStrings 非法' };
    }
    patch.trimStrings = body.trimStrings as string[];
  }
  if (body.placement !== undefined) {
    if (!Array.isArray(body.placement) || body.placement.some((p) => typeof p !== 'number')) {
      return { error: 'placement 非法' };
    }
    patch.placement = body.placement as number[];
  }
  for (const key of ['disabled', 'markdownOnly', 'promptOnly', 'runOnEdit'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return { error: `${key} 非法` };
    patch[key] = value;
  }
  if (body.substituteRegex !== undefined) {
    if (!SUBSTITUTE_VALUES.includes(body.substituteRegex as number)) {
      return { error: 'substituteRegex 非法' };
    }
    patch.substituteRegex = body.substituteRegex as 0 | 1 | 2;
  }
  for (const key of ['minDepth', 'maxDepth'] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (value !== null && typeof value !== 'number') return { error: `${key} 非法` };
    patch[key] = (value as number | null) ?? null;
  }
  return { patch };
}

/** 对外字段增量 → DB 列增量（direction 需要 promptOnly/markdownOnly 的完整状态） */
function toColumns(
  patch: Partial<ScriptInput>,
  current?: RegexScriptRow,
): Partial<typeof schema.regexScripts.$inferInsert> {
  const columns: Partial<typeof schema.regexScripts.$inferInsert> = {};
  if (patch.name !== undefined) columns.scriptName = patch.name;
  if (patch.findRegex !== undefined) columns.findRegex = patch.findRegex;
  if (patch.replaceString !== undefined) columns.replaceString = patch.replaceString;
  if (patch.trimStrings !== undefined) columns.trimStrings = patch.trimStrings;
  if (patch.placement !== undefined) columns.placement = patch.placement;
  if (patch.disabled !== undefined) columns.disabled = patch.disabled;
  if (patch.runOnEdit !== undefined) columns.runOnEdit = patch.runOnEdit;
  if (patch.substituteRegex !== undefined) columns.substituteRegex = patch.substituteRegex;
  if (patch.minDepth !== undefined) columns.minDepth = patch.minDepth;
  if (patch.maxDepth !== undefined) columns.maxDepth = patch.maxDepth;
  if (patch.promptOnly !== undefined || patch.markdownOnly !== undefined) {
    const base = current ? toRegexScript(current) : { promptOnly: false, markdownOnly: false };
    columns.direction = flagsToDirection({
      promptOnly: patch.promptOnly ?? base.promptOnly,
      markdownOnly: patch.markdownOnly ?? base.markdownOnly,
    });
  }
  return columns;
}

async function readJson(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    return ((await c.req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function createRegexRoutes(db: Db) {
  return (
    new Hono()
      .get('/', (c) =>
        c.json(c.req.query('scope') === 'all' ? listAllScripts(db) : listScripts(db)),
      )
      /**
       * 一次开关某个来源自带的全部脚本（导入时的「是否启用」问句、设置页的来源开关）。
       * 第一次启用按原件状态恢复；之后关闭会记住逐条状态，再次启用原样恢复。
       */
      .post('/owner', async (c) => {
        const body = await readJson(c);
        if (!body) return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
        if (!isEmbeddedScope(body.scope))
          return c.json({ error: 'invalid', message: 'scope 非法' }, 400);
        if (typeof body.ownerId !== 'string' || body.ownerId === '') {
          return c.json({ error: 'invalid', message: 'ownerId 非法' }, 400);
        }
        if (typeof body.enabled !== 'boolean') {
          return c.json({ error: 'invalid', message: 'enabled 非法' }, 400);
        }
        const changed = setOwnerRegexEnabled(db, body.scope, body.ownerId, body.enabled);
        return c.json({ changed, scripts: listAllScripts(db) });
      })
      .post('/', async (c) => {
        const body = await readJson(c);
        if (!body) return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
        const parsed = readBody(body, false);
        if ('error' in parsed) return c.json({ error: 'invalid', message: parsed.error }, 400);
        const row = db
          .insert(schema.regexScripts)
          .values({
            scriptName: parsed.patch.name as string,
            findRegex: parsed.patch.findRegex as string,
            scope: 'global',
            displayOrder: nextGlobalOrder(db),
            ...toColumns(parsed.patch),
          })
          .returning()
          .get();
        return c.json(toRegexScript(row), 201);
      })
      // /order 必须在 /:id 之前注册
      .put('/order', async (c) => {
        const body = await readJson(c);
        if (!body) return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
        const ids = body.ids;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
          return c.json({ error: 'invalid', message: 'ids 非法' }, 400);
        }
        (ids as string[]).forEach((id, index) => {
          db.update(schema.regexScripts)
            .set({ displayOrder: index, updatedAt: new Date() })
            .where(eq(schema.regexScripts.id, id))
            .run();
        });
        return c.json(listScripts(db));
      })
      .put('/:id', async (c) => {
        const current = db
          .select()
          .from(schema.regexScripts)
          .where(eq(schema.regexScripts.id, c.req.param('id')))
          .get();
        if (!current) return c.json({ error: 'not_found' }, 404);
        const body = await readJson(c);
        if (!body) return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
        const parsed = readBody(body, true);
        if ('error' in parsed) return c.json({ error: 'invalid', message: parsed.error }, 400);
        const row = db
          .update(schema.regexScripts)
          .set({ ...toColumns(parsed.patch, current), updatedAt: new Date() })
          .where(eq(schema.regexScripts.id, current.id))
          .returning()
          .get();
        return c.json(toRegexScript(row));
      })
      .delete('/:id', (c) => {
        const row = db
          .delete(schema.regexScripts)
          .where(eq(schema.regexScripts.id, c.req.param('id')))
          .returning()
          .get();
        if (!row) return c.json({ error: 'not_found' }, 404);
        return c.body(null, 204);
      })
  );
}
