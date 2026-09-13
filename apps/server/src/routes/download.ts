import type { Context } from 'hono';

import type { ExportedFile } from '../services/importer.js';

/** 以附件形式返回导出文件；filename* 携带 UTF-8 原名，filename 为 ASCII 兜底 */
export function sendDownload(c: Context, file: ExportedFile | undefined) {
  if (!file) return c.json({ error: 'not_found' }, 404);
  const asciiName = file.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return c.body(new Uint8Array(file.bytes), 200, {
    'content-type': file.mime,
    'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
  });
}
