import { Hono, type Context } from 'hono';

import type { Db } from '../db/client.js';
import type { AssetsService } from '../services/assets.js';
import {
  BACKGROUND_MAX_BYTES,
  backgroundNameOf,
  deleteBackground,
  listBackgrounds,
  renameBackground,
  saveBackground,
  sniffBackgroundMime,
  toBackgroundItem,
} from '../services/backgrounds.js';

/** multipart 里的 `file`：字节 + 文件名 */
async function readUpload(c: Context): Promise<{ bytes: Uint8Array; name: string } | undefined> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.startsWith('multipart/form-data')) return undefined;
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) return undefined;
  return { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name };
}

/** 背景库（M4（二）契约 §A.2）。会话 / 角色 / 全局绑定走已有的 chats PATCH 与 settings。 */
export function createBackgroundsRoutes(db: Db, assets: AssetsService) {
  return new Hono()
    .get('/', (c) => c.json(listBackgrounds(db)))
    .post('/', async (c) => {
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > BACKGROUND_MAX_BYTES + 64 * 1024) {
        return c.json({ error: 'too_large', message: '背景图不能超过 20 MB' }, 413);
      }
      const upload = await readUpload(c);
      if (!upload) return c.json({ error: 'invalid', message: '缺少图片（字段名 file）' }, 400);
      if (upload.bytes.length > BACKGROUND_MAX_BYTES) {
        return c.json({ error: 'too_large', message: '背景图不能超过 20 MB' }, 413);
      }
      const mime = sniffBackgroundMime(upload.bytes);
      if (!mime) {
        return c.json({ error: 'invalid', message: '只支持 PNG、JPEG、WebP、GIF、AVIF' }, 400);
      }
      const row = saveBackground(assets, {
        bytes: upload.bytes,
        mime,
        name: backgroundNameOf(upload.name),
        source: 'upload:background',
      });
      return c.json(toBackgroundItem(row), 201);
    })
    .patch('/:assetId', async (c) => {
      let body: { name?: unknown };
      try {
        body = ((await c.req.json()) ?? {}) as { name?: unknown };
      } catch {
        return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
      }
      if (typeof body.name !== 'string' || body.name.trim() === '') {
        return c.json({ error: 'invalid', message: 'name 非法' }, 400);
      }
      const row = renameBackground(db, assets, c.req.param('assetId'), body.name.trim().slice(0, 120));
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.json(toBackgroundItem(row));
    })
    .delete('/:assetId', (c) => {
      if (!deleteBackground(db, assets, c.req.param('assetId'))) {
        return c.json({ error: 'not_found' }, 404);
      }
      return c.body(null, 204);
    });
}
