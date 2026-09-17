import { Hono, type Context } from 'hono';

import { ImportError, type Importer } from '../services/importer.js';

async function readUpload(c: Context): Promise<{ name: string; bytes: Uint8Array } | undefined> {
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) return undefined;
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}

/** multipart/form-data 上传（字段名 file）→ 解析入库，返回 201 */
export function createImportRoutes(importer: Importer) {
  const handle =
    <T>(run: (name: string, bytes: Uint8Array) => T) =>
    async (c: Context) => {
      const upload = await readUpload(c);
      if (!upload) {
        return c.json({ error: 'invalid', message: '缺少上传文件（字段名 file）' }, 400);
      }
      try {
        return c.json(run(upload.name, upload.bytes), 201);
      } catch (e) {
        if (e instanceof ImportError) {
          return c.json({ error: 'invalid', message: e.message }, 400);
        }
        throw e;
      }
    };

  return (
    new Hono()
      .post(
        '/character',
        handle((name, bytes) => {
          const row = importer.importCharacter(name, bytes);
          return {
            id: row.id,
            name: row.name,
            spec: row.spec,
            tags: row.tags,
            avatarAssetId: row.avatarAssetId,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
        }),
      )
      .post(
        '/preset',
        handle((name, bytes) => {
          const { data: _data, ...summary } = importer.importPreset(name, bytes);
          return summary;
        }),
      )
      .post(
        '/lorebook',
        handle((name, bytes) => importer.importLorebook(name, bytes)),
      )
      .post(
        '/regex',
        handle((name, bytes) => importer.importRegexScripts(name, bytes)),
      )
      /**
       * SillyTavern 聊天记录（契约 M4 §2.2）。multipart：file + 可选 characterId
       * （不带 = 按 header 的 character_name 匹配唯一角色；空串 = 不绑定角色）。
       */
      .post('/chat', async (c) => {
        const body = await c.req.parseBody();
        const file = body['file'];
        if (!(file instanceof File)) {
          return c.json({ error: 'invalid', message: '缺少上传文件（字段名 file）' }, 400);
        }
        const rawCharacterId = body['characterId'];
        const characterId =
          typeof rawCharacterId === 'string'
            ? rawCharacterId === ''
              ? null
              : rawCharacterId
            : undefined;
        try {
          const result = importer.importChat({
            fileName: file.name,
            bytes: new Uint8Array(await file.arrayBuffer()),
            characterId,
          });
          return c.json(result, 201);
        } catch (e) {
          if (e instanceof ImportError) {
            return c.json({ error: 'invalid', message: e.message }, 400);
          }
          throw e;
        }
      })
  );
}
