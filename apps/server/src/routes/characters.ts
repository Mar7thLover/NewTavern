import { desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { schema, type Db } from '../db/client.js';
import type { AssetsService } from '../services/assets.js';
import {
  CharacterInputError,
  CharacterNotFoundError,
  createCharacter,
  setCharacterAvatar,
  updateCharacter,
} from '../services/character-edit.js';
import type { CharacterFormat, Importer } from '../services/importer.js';
import { ownerRegexRows } from '../services/embedded-regex.js';
import { toRegexScript } from '../services/regex-map.js';
import { deleteVersions, parseAuthor, type VersionAuthor } from '../services/versions.js';
import { sendDownload } from './download.js';
import { AVATAR_MAX_BYTES, readAvatarUpload, sniffImageMime } from './personas.js';

const EXPORT_FORMATS: readonly CharacterFormat[] = ['png', 'charx', 'json'];

type CharacterRow = typeof schema.characters.$inferSelect;

/** `GET /api/characters/:id` 与编辑接口的返回（整行；data 为完整 CCv3 data） */
export type CharacterDetail = CharacterRow;

/** `POST /api/characters` 请求体（M6 §2.1）：data 可选，按 CCv3 默认字段补齐 */
export interface CharacterCreateRequest {
  name: string;
  data?: Record<string, unknown>;
}

/** `PUT /api/characters/:id` 请求体：完整 CCv3 data（从 GET 拿到的 data 改出来的） */
export interface CharacterUpdateRequest {
  data: Record<string, unknown>;
  author?: VersionAuthor;
}

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
 * 角色库：列表/详情/新建/编辑/头像/删除/导出。导入见 routes/import.ts。
 * 编辑（M6 §2.1）的校验与写库在 services/character-edit.ts（版本恢复复用）。
 */
export function createCharactersRoutes(db: Db, importer: Importer, assets: AssetsService) {
  const findRow = (id: string) =>
    db.select().from(schema.characters).where(eq(schema.characters.id, id)).get();

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
      /** 新建 V3 空卡：`{ name, data? }` → CharacterDetail */
      .post('/', async (c) => {
        const body = (await readJsonObject(c)) ?? {};
        try {
          return c.json(createCharacter(db, body.name, body.data), 201);
        } catch (e) {
          if (e instanceof CharacterInputError) {
            return c.json({ error: 'invalid', message: e.message }, 400);
          }
          throw e;
        }
      })
      .get('/:id', (c) => {
        const row = findRow(c.req.param('id'));
        if (!row) return c.json({ error: 'not_found' }, 404);
        return c.json(row);
      })
      /** 整份替换 data：`{ data, author? }`；未知字段原样保留，写一版版本历史 */
      .put('/:id', async (c) => {
        const body = await readJsonObject(c);
        if (!body) return c.json({ error: 'invalid', message: '请求体不是合法的 JSON 对象' }, 400);
        try {
          return c.json(
            updateCharacter(db, c.req.param('id'), body.data, parseAuthor(body.author)),
          );
        } catch (e) {
          if (e instanceof CharacterNotFoundError) return c.json({ error: 'not_found' }, 404);
          if (e instanceof CharacterInputError) {
            return c.json({ error: 'invalid', message: e.message }, 400);
          }
          throw e;
        }
      })
      /**
       * 换头像（multipart 字段名 file，或原始字节）。导出 PNG 以头像为底图，
       * 所以要让导出的 PNG 带上新头像，前端应上传 **PNG**（WebP / JPEG 只用于展示与 CHARX）。
       */
      .post('/:id/avatar', async (c) => {
        const id = c.req.param('id');
        if (!findRow(id)) return c.json({ error: 'not_found' }, 404);
        const declared = Number(c.req.header('content-length') ?? 0);
        if (declared > AVATAR_MAX_BYTES + 64 * 1024) {
          return c.json({ error: 'too_large', message: '头像不能超过 5MB' }, 413);
        }
        const bytes = await readAvatarUpload(c);
        if (!bytes) return c.json({ error: 'invalid', message: '缺少图片（字段名 file）' }, 400);
        if (bytes.length > AVATAR_MAX_BYTES) {
          return c.json({ error: 'too_large', message: '头像不能超过 5MB' }, 413);
        }
        const mime = sniffImageMime(bytes);
        if (!mime) return c.json({ error: 'invalid', message: '只支持 PNG、JPEG、WebP' }, 400);
        const asset = assets.save({
          bytes,
          mime,
          kind: 'avatar',
          source: `upload:character:${id}`,
        });
        return c.json(setCharacterAvatar(db, id, asset.id));
      })
      /** 资产按内容寻址、可能被别处引用，这里只解除关联不删文件 */
      .delete('/:id/avatar', (c) => {
        const row = setCharacterAvatar(db, c.req.param('id'), null);
        if (!row) return c.json({ error: 'not_found' }, 404);
        return c.json(row);
      })
      /**
       * 这张卡自带的正则（导入时已抽进 regex_scripts 表，scope='character'）。
       * 显示侧正则要用它，所以**不过滤 disabled**——过滤由调用方按 `disabled` 做。
       */
      .get('/:id/regex', (c) => {
        const row = findRow(c.req.param('id'));
        if (!row) return c.json({ error: 'not_found' }, 404);
        return c.json(ownerRegexRows(db, 'character', row.id).map(toRegexScript));
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
        deleteVersions(db, 'character', row.id);
        return c.body(null, 204);
      })
  );
}
