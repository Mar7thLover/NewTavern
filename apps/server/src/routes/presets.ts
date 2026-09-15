import { extractPresetSampling, parsePreset, presetApiFamily } from '@newtavern/compat';
import { desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { schema, type Db } from '../db/client.js';
import type { Importer } from '../services/importer.js';
import { sendDownload } from './download.js';

type PresetRow = typeof schema.presets.$inferSelect;

function toSummary(row: PresetRow) {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    apiFamily: row.apiFamily,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
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

/**
 * 预设库：列表/详情/修改/删除/导出。ST JSON 导入见 routes/import.ts。
 *
 * 修改（`PUT /:id`）整份替换 `data`：用 `parsePreset`（looseObject）校验，未知字段原样保留，
 * 导出因此仍然无损；`sampling` / `apiFamily` 从新 data 重算。
 * `layoutPolicy` 列组装不读（布局模式来自会话覆盖 / 请求参数），这里不开放写入。
 */
export function createPresetsRoutes(db: Db, importer: Importer) {
  return new Hono()
    .get('/', (c) => {
      const rows = db.select().from(schema.presets).orderBy(desc(schema.presets.updatedAt)).all();
      return c.json(rows.map(toSummary));
    })
    .get('/:id', (c) => {
      const row = db
        .select()
        .from(schema.presets)
        .where(eq(schema.presets.id, c.req.param('id')))
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.json(row);
    })
    .put('/:id', async (c) => {
      const id = c.req.param('id');
      const current = db.select().from(schema.presets).where(eq(schema.presets.id, id)).get();
      if (!current) return c.json({ error: 'not_found' }, 404);
      const body = await readJsonObject(c);
      if (!body) return c.json({ error: 'invalid', message: '请求体不是合法的 JSON 对象' }, 400);

      let name = current.name;
      if (body.name !== undefined) {
        if (typeof body.name !== 'string' || body.name.trim() === '') {
          return c.json({ error: 'invalid', message: 'name 不能为空' }, 400);
        }
        name = body.name.trim();
      }
      if (body.data === undefined) return c.json({ error: 'invalid', message: '缺少 data' }, 400);

      let data: ReturnType<typeof parsePreset>;
      try {
        data = parsePreset(body.data);
      } catch (e) {
        return c.json({ error: 'invalid', message: (e as Error).message }, 400);
      }
      // 预设 JSON 自带 name 时与列保持一致；ST 导出的预设大多没有这个字段，不凭空添加
      if ('name' in data) data.name = name;

      const row = db
        .update(schema.presets)
        .set({
          name,
          data,
          sampling: extractPresetSampling(data),
          apiFamily: presetApiFamily(data),
          updatedAt: new Date(),
        })
        .where(eq(schema.presets.id, id))
        .returning()
        .get();
      return c.json(row);
    })
    .get('/:id/export', (c) => sendDownload(c, importer.exportPreset(c.req.param('id'))))
    .delete('/:id', (c) => {
      const row = db
        .delete(schema.presets)
        .where(eq(schema.presets.id, c.req.param('id')))
        .returning()
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.body(null, 204);
    });
}
