import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { schema, type Db } from '../db/client.js';
import type { CharacterFormat, Importer } from '../services/importer.js';
import { characterRegexScripts } from '../services/regex-map.js';
import { sendDownload } from './download.js';

const EXPORT_FORMATS: readonly CharacterFormat[] = ['png', 'charx', 'json'];

type CharacterRow = typeof schema.characters.$inferSelect;

function toSummary(row: CharacterRow) {
  return {
    id: row.id,
    name: row.name,
    spec: row.spec,
    tags: row.tags,
    avatarAssetId: row.avatarAssetId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 角色库：列表/详情/删除/导出。导入见 routes/import.ts。 */
export function createCharactersRoutes(db: Db, importer: Importer) {
  return (
    new Hono()
      .get('/', (c) => {
        const rows = db
          .select()
          .from(schema.characters)
          .orderBy(desc(schema.characters.updatedAt))
          .all();
        return c.json(rows.map(toSummary));
      })
      .get('/:id', (c) => {
        const row = db
          .select()
          .from(schema.characters)
          .where(eq(schema.characters.id, c.req.param('id')))
          .get();
        if (!row) return c.json({ error: 'not_found' }, 404);
        return c.json(row);
      })
      // 卡内嵌正则：data.extensions.regex_scripts → 契约 §2.1 形状（scope='character'）
      .get('/:id/regex', (c) => {
        const row = db
          .select()
          .from(schema.characters)
          .where(eq(schema.characters.id, c.req.param('id')))
          .get();
        if (!row) return c.json({ error: 'not_found' }, 404);
        return c.json(characterRegexScripts(row.id, row.data));
      })
      .get('/:id/export', (c) => {
        const format = (c.req.query('format') ?? 'png') as CharacterFormat;
        if (!EXPORT_FORMATS.includes(format)) {
          return c.json({ error: 'invalid', message: `不支持的导出格式：${format}` }, 400);
        }
        return sendDownload(c, importer.exportCharacter(c.req.param('id'), format));
      })
      .delete('/:id', (c) => {
        const row = db
          .delete(schema.characters)
          .where(eq(schema.characters.id, c.req.param('id')))
          .returning()
          .get();
        if (!row) return c.json({ error: 'not_found' }, 404);
        return c.body(null, 204);
      })
  );
}
