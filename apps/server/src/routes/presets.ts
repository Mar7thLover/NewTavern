import { parsePreset } from '@newtavern/compat';
import { desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { schema, type Db } from '../db/client.js';
import { ownerRegexRows } from '../services/embedded-regex.js';
import { toRegexScript } from '../services/regex-map.js';
import { DEFAULT_PRESET } from '../services/assemble.js';
import type { Importer } from '../services/importer.js';
import {
  builtinPresetData,
  clearPresetSettingsIf,
  presetColumns,
  readBuiltinPresetId,
} from '../services/presets.js';
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

/** 预设 JSON 自带 name 时与列保持一致；ST 导出的预设大多没有这个字段，不凭空添加 */
function syncDataName(data: Record<string, unknown>, name: string): void {
  if ('name' in data) data.name = name;
}

const NEW_PRESET_NAME = '新预设';

/**
 * 预设库：列表/详情/新建/复制/修改/恢复内置/删除/导出。ST JSON 导入见 routes/import.ts。
 *
 * 修改（`PUT /:id`）整份替换 `data`：用 `parsePreset`（looseObject）校验，未知字段原样保留，
 * 导出因此仍然无损；`sampling` / `apiFamily` 从新 data 重算。
 * `layoutPolicy` 列组装不读（布局模式来自会话覆盖 / 请求参数），这里不开放写入。
 * 默认预设（`defaultPresetId`）与种子预设（`builtinPresetId`）见 `services/presets.ts`。
 */
export function createPresetsRoutes(db: Db, importer: Importer) {
  const load = (id: string) =>
    db.select().from(schema.presets).where(eq(schema.presets.id, id)).get();

  return (
    new Hono()
      .get('/', (c) => {
        const rows = db.select().from(schema.presets).orderBy(desc(schema.presets.updatedAt)).all();
        return c.json(rows.map(toSummary));
      })
      /** 新建：`{ name?, from?: 'default' }`，内容是内置默认预设的深拷贝 */
      .post('/', async (c) => {
        // 请求体可省略（空体 / 非对象都按 {} 处理）
        const body = (await readJsonObject(c)) ?? {};
        if (body.from !== undefined && body.from !== 'default') {
          return c.json({ error: 'invalid', message: 'from 只支持 default' }, 400);
        }
        if (body.name !== undefined && typeof body.name !== 'string') {
          return c.json({ error: 'invalid', message: 'name 非法' }, 400);
        }
        const name = (typeof body.name === 'string' && body.name.trim()) || NEW_PRESET_NAME;
        const row = db
          .insert(schema.presets)
          .values({ name, format: DEFAULT_PRESET.format, ...presetColumns(builtinPresetData()) })
          .returning()
          .get();
        return c.json(row, 201);
      })
      .get('/:id', (c) => {
        const row = load(c.req.param('id'));
        if (!row) return c.json({ error: 'not_found' }, 404);
        return c.json(row);
      })
      /**
       * 这份预设自带的正则（导入时抽进 regex_scripts 表，scope='preset'）。
       * ST 里它们是「预设正则」，思维链美化 / 不发送思维链这类基本都靠它。
       * 与角色卡那个端点一样，不过滤 disabled。
       */
      .get('/:id/regex', (c) => {
        const row = load(c.req.param('id'));
        if (!row) return c.json({ error: 'not_found' }, 404);
        return c.json(ownerRegexRows(db, 'preset', row.id).map(toRegexScript));
      })
      .put('/:id', async (c) => {
        const id = c.req.param('id');
        const current = load(id);
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
        syncDataName(data, name);

        const row = db
          .update(schema.presets)
          .set({ name, ...presetColumns(data), updatedAt: new Date() })
          .where(eq(schema.presets.id, id))
          .returning()
          .get();
        return c.json(row);
      })
      /** 复制：data / sampling / format / apiFamily 原样，名称「<原名> 副本」 */
      .post('/:id/duplicate', (c) => {
        const source = load(c.req.param('id'));
        if (!source) return c.json({ error: 'not_found' }, 404);
        const name = `${source.name} 副本`;
        const data = structuredClone(source.data) as Record<string, unknown>;
        syncDataName(data, name);
        const row = db
          .insert(schema.presets)
          .values({
            name,
            format: source.format,
            apiFamily: source.apiFamily,
            data,
            sampling: source.sampling ? structuredClone(source.sampling) : source.sampling,
          })
          .returning()
          .get();
        return c.json(row, 201);
      })
      /** 只对种子写入的「默认预设」：data 重置为内置内容，名称不变 */
      .post('/:id/reset-builtin', (c) => {
        const id = c.req.param('id');
        const current = load(id);
        if (!current) return c.json({ error: 'not_found' }, 404);
        if (readBuiltinPresetId(db) !== id) {
          return c.json({ error: 'invalid', message: '只有内置的默认预设可以恢复内置内容' }, 400);
        }
        const row = db
          .update(schema.presets)
          .set({
            format: DEFAULT_PRESET.format,
            ...presetColumns(builtinPresetData()),
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
        clearPresetSettingsIf(db, row.id);
        return c.body(null, 204);
      })
  );
}
