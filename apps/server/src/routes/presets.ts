import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

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

/** 预设库：列表/详情/删除/导出。ST JSON 导入见 routes/import.ts。 */
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
