import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';

import { schema, type Db } from '../db/client.js';
import type { AssetsService } from '../services/assets.js';
import { chooseExpression, ExpressionError } from '../services/expression.js';
import type { ProviderService } from '../services/providers.js';
import {
  SPRITE_MAX_BYTES,
  SPRITE_ZIP_MAX_BYTES,
  SpriteError,
  deleteSprite,
  importSpriteZip,
  listSprites,
  normalizeSpriteLabel,
  putSprite,
} from '../services/sprites.js';

async function readFileField(c: Context): Promise<Uint8Array | undefined> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) return undefined;
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) return undefined;
  return new Uint8Array(await file.arrayBuffer());
}

/**
 * 立绘（M4（二）契约 §B.1）：挂在 `/characters` 下（与 characters.ts 分文件，第二次 route）。
 * 路径里的标签按 URI 解码后规范化（`Joy` → `joy`）。
 */
export function createSpritesRoutes(db: Db, assets: AssetsService) {
  const characterExists = (id: string) =>
    db
      .select({ id: schema.characters.id })
      .from(schema.characters)
      .where(eq(schema.characters.id, id))
      .get() !== undefined;

  return new Hono()
    .get('/:id/sprites', (c) => {
      const id = c.req.param('id');
      if (!characterExists(id)) return c.json({ error: 'not_found' }, 404);
      return c.json(listSprites(db, id));
    })
    .post('/:id/sprites/import', async (c) => {
      const id = c.req.param('id');
      if (!characterExists(id)) return c.json({ error: 'not_found' }, 404);
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > SPRITE_ZIP_MAX_BYTES + 64 * 1024) {
        return c.json({ error: 'too_large', message: '立绘包不能超过 200 MB' }, 413);
      }
      const bytes = await readFileField(c);
      if (!bytes) return c.json({ error: 'invalid', message: '缺少 zip 文件（字段名 file）' }, 400);
      try {
        const result = importSpriteZip(db, assets, id, bytes, `upload:sprites:${id}`);
        return c.json({ ...result, sprites: listSprites(db, id) });
      } catch (e) {
        if (e instanceof SpriteError) return c.json({ error: 'invalid', message: e.message }, 400);
        throw e;
      }
    })
    .put('/:id/sprites/:label', async (c) => {
      const id = c.req.param('id');
      if (!characterExists(id)) return c.json({ error: 'not_found' }, 404);
      const label = normalizeSpriteLabel(c.req.param('label'));
      if (!label) return c.json({ error: 'invalid', message: '表情标签不合法' }, 400);
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > SPRITE_MAX_BYTES + 64 * 1024) {
        return c.json({ error: 'too_large', message: '立绘不能超过 20 MB' }, 413);
      }
      const bytes = await readFileField(c);
      if (!bytes) return c.json({ error: 'invalid', message: '缺少图片（字段名 file）' }, 400);
      if (bytes.length > SPRITE_MAX_BYTES) {
        return c.json({ error: 'too_large', message: '立绘不能超过 20 MB' }, 413);
      }
      try {
        return c.json(putSprite(db, assets, { characterId: id, label, bytes, source: `upload:sprite:${id}` }));
      } catch (e) {
        if (e instanceof SpriteError) return c.json({ error: 'invalid', message: e.message }, 400);
        throw e;
      }
    })
    .delete('/:id/sprites/:label', (c) => {
      const label = normalizeSpriteLabel(c.req.param('label'));
      if (!label || !deleteSprite(db, c.req.param('id'), label)) {
        return c.json({ error: 'not_found' }, 404);
      }
      return c.body(null, 204);
    });
}

/** `POST /api/chats/:id/nodes/:nodeId/expression`（M4（二）契约 §B.2），挂在 `/chats` 下 */
export function createExpressionRoutes(db: Db, dataDir: string, providers: ProviderService) {
  return new Hono().post('/:id/nodes/:nodeId/expression', async (c) => {
    let body: { label?: unknown } = {};
    try {
      const text = await c.req.text();
      body = text.trim() ? ((JSON.parse(text) ?? {}) as { label?: unknown }) : {};
    } catch {
      return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
    }
    try {
      const result = await chooseExpression(db, dataDir, providers, {
        chatId: c.req.param('id'),
        nodeId: c.req.param('nodeId'),
        ...(body.label !== undefined ? { label: body.label } : {}),
        signal: c.req.raw.signal,
      });
      return c.json(result);
    } catch (e) {
      if (e instanceof ExpressionError) {
        return c.json({ error: e.status === 404 ? 'not_found' : 'invalid', message: e.message }, e.status);
      }
      throw e;
    }
  });
}
