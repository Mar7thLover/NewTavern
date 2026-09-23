import { asc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { schema, type Db } from '../db/client.js';
import type { AssetsService } from '../services/assets.js';
import { clearDefaultPersonaIf } from '../services/personas.js';

type PersonaRow = typeof schema.personas.$inferSelect;

const DESCRIPTION_POSITIONS: readonly PersonaRow['descriptionPosition'][] = [
  'in_prompt',
  'top_an',
  'bottom_an',
  'at_depth',
  'none',
];
const ROLES: readonly PersonaRow['role'][] = ['system', 'user', 'assistant'];
/** ST `MAX_INJECTION_DEPTH` */
const MAX_DEPTH = 10000;
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

interface PersonaBody {
  name?: unknown;
  description?: unknown;
  title?: unknown;
  position?: unknown;
  descriptionPosition?: unknown;
  depth?: unknown;
  role?: unknown;
  lorebookId?: unknown;
}

function parseBody(db: Db, body: PersonaBody) {
  const patch: Partial<typeof schema.personas.$inferInsert> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') throw new Error('name 非法');
    patch.name = body.name.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') throw new Error('description 非法');
    patch.description = body.description;
  }
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') throw new Error('title 非法');
    patch.title = body.title.trim();
  }
  if (body.position !== undefined) {
    if (typeof body.position !== 'number') throw new Error('position 非法');
    patch.position = body.position;
  }
  if (body.descriptionPosition !== undefined) {
    const value = body.descriptionPosition as PersonaRow['descriptionPosition'];
    if (!DESCRIPTION_POSITIONS.includes(value)) throw new Error('descriptionPosition 非法');
    patch.descriptionPosition = value;
  }
  if (body.depth !== undefined) {
    if (
      typeof body.depth !== 'number' ||
      !Number.isInteger(body.depth) ||
      body.depth < 0 ||
      body.depth > MAX_DEPTH
    ) {
      throw new Error(`depth 须为 0–${MAX_DEPTH} 的整数`);
    }
    patch.depth = body.depth;
  }
  if (body.role !== undefined) {
    const value = body.role as PersonaRow['role'];
    if (!ROLES.includes(value)) throw new Error('role 非法');
    patch.role = value;
  }
  if (body.lorebookId !== undefined) {
    if (body.lorebookId === null) {
      patch.lorebookId = null;
    } else {
      if (typeof body.lorebookId !== 'string') throw new Error('lorebookId 非法');
      const book = db
        .select({ id: schema.lorebooks.id })
        .from(schema.lorebooks)
        .where(eq(schema.lorebooks.id, body.lorebookId))
        .get();
      if (!book) throw new Error(`世界书不存在：${body.lorebookId}`);
      patch.lorebookId = book.id;
    }
  }
  return patch;
}

/** 按文件头识别图片类型，不信任客户端给的 content-type */
export function sniffImageMime(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  // RIFF....WEBP
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/** multipart（字段名 file）或原始字节 */
export async function readAvatarUpload(c: Context): Promise<Uint8Array | undefined> {
  const contentType = c.req.header('content-type') ?? '';
  if (contentType.startsWith('multipart/form-data')) {
    const body = await c.req.parseBody();
    const file = body['file'];
    if (!(file instanceof File)) return undefined;
    return new Uint8Array(await file.arrayBuffer());
  }
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  return bytes.length > 0 ? bytes : undefined;
}

export function createPersonasRoutes(db: Db, assets: AssetsService) {
  const findRow = (id: string) =>
    db.select().from(schema.personas).where(eq(schema.personas.id, id)).get();

  return new Hono()
    .get('/', (c) => {
      const rows = db.select().from(schema.personas).orderBy(asc(schema.personas.position)).all();
      return c.json(rows);
    })
    .get('/:id', (c) => {
      const row = findRow(c.req.param('id'));
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.json(row);
    })
    .post('/', async (c) => {
      let patch: ReturnType<typeof parseBody>;
      try {
        patch = parseBody(db, await c.req.json());
      } catch (e) {
        return c.json({ error: 'invalid', message: (e as Error).message }, 400);
      }
      if (!patch.name) return c.json({ error: 'invalid', message: '缺少 name' }, 400);
      const row = db
        .insert(schema.personas)
        .values({ ...patch, name: patch.name })
        .returning()
        .get();
      return c.json(row, 201);
    })
    .put('/:id', async (c) => {
      let patch: ReturnType<typeof parseBody>;
      try {
        patch = parseBody(db, await c.req.json());
      } catch (e) {
        return c.json({ error: 'invalid', message: (e as Error).message }, 400);
      }
      const row = db
        .update(schema.personas)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.personas.id, c.req.param('id')))
        .returning()
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.json(row);
    })
    .post('/:id/avatar', async (c) => {
      const id = c.req.param('id');
      if (!findRow(id)) return c.json({ error: 'not_found' }, 404);
      const declared = Number(c.req.header('content-length') ?? 0);
      // multipart 有边界开销，先按声明长度粗筛，读完再按真实字节数精确判断
      if (declared > AVATAR_MAX_BYTES + 64 * 1024) {
        return c.json({ error: 'too_large', message: '头像不能超过 5MB' }, 413);
      }
      const bytes = await readAvatarUpload(c);
      if (!bytes) return c.json({ error: 'invalid', message: '缺少图片（字段名 file）' }, 400);
      if (bytes.length > AVATAR_MAX_BYTES) {
        return c.json({ error: 'too_large', message: '头像不能超过 5MB' }, 413);
      }
      const mime = sniffImageMime(bytes);
      if (!mime) {
        return c.json({ error: 'invalid', message: '只支持 PNG、JPEG、WebP' }, 400);
      }
      const asset = assets.save({ bytes, mime, kind: 'avatar', source: `upload:persona:${id}` });
      const row = db
        .update(schema.personas)
        .set({ avatarAssetId: asset.id, updatedAt: new Date() })
        .where(eq(schema.personas.id, id))
        .returning()
        .get();
      return c.json(row);
    })
    .delete('/:id/avatar', (c) => {
      // 资产按内容寻址、可能被别处引用，这里只解除关联不删文件
      const row = db
        .update(schema.personas)
        .set({ avatarAssetId: null, updatedAt: new Date() })
        .where(eq(schema.personas.id, c.req.param('id')))
        .returning()
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.json(row);
    })
    .delete('/:id', (c) => {
      const row = db
        .delete(schema.personas)
        .where(eq(schema.personas.id, c.req.param('id')))
        .returning()
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      clearDefaultPersonaIf(db, row.id);
      return c.body(null, 204);
    });
}
