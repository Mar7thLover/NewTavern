import fs from 'node:fs';

import { classifyDocumentMime } from '@newtavern/providers';
import { Hono } from 'hono';

import type { Db } from '../db/client.js';
import { sha256Of, type AssetRow, type AssetsService } from '../services/assets.js';
import { collectGarbage } from '../services/media-gc.js';
import {
  classifyUpload,
  extractPdfText,
  IMAGE_MIMES,
  UPLOAD_MAX_BYTES,
  type UploadClass,
} from '../services/media.js';

/**
 * 资产：文件读取、附件上传、清理。见 docs/M4-CONTRACT.md §3.3。
 */

/** multipart 边界等开销的余量：先按声明长度粗筛，读完再按真实字节数精确判断 */
const MULTIPART_SLACK = 64 * 1024;
const TOO_LARGE = { error: 'too_large', message: '文件不能超过 20 MB' } as const;
const UNSUPPORTED = {
  error: 'unsupported',
  message:
    '只支持 PNG / JPEG / WebP / GIF 图片、PDF，以及 UTF-8 编码的 .txt .md .markdown .json .csv .log .yaml .yml .xml .html 文本文件',
} as const;

export interface UploadResponse {
  id: string;
  kind: AssetRow['kind'];
  mime: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  pages?: number;
  textLength?: number;
}

function numberMeta(row: AssetRow, key: string): number | undefined {
  const value = row.meta?.[key];
  return typeof value === 'number' ? value : undefined;
}

function toUploadResponse(
  row: AssetRow,
  name: string,
  size: number,
  cls: UploadClass,
): UploadResponse {
  const text = row.meta?.['text'];
  const textLength =
    cls.category === 'text'
      ? cls.text.length
      : cls.category === 'pdf'
        ? typeof text === 'string'
          ? text.length
          : 0
        : undefined;
  const pages = numberMeta(row, 'pages');
  return {
    id: row.id,
    kind: row.kind,
    mime: row.mime,
    name,
    size,
    ...(row.width !== null ? { width: row.width } : {}),
    ...(row.height !== null ? { height: row.height } : {}),
    ...(pages !== undefined ? { pages } : {}),
    ...(textLength !== undefined ? { textLength } : {}),
  };
}

/** PDF 抽取结果 → meta 字段；失败时 `text` 为空串（表示抽过、没抽到） */
async function pdfMeta(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const extracted = await extractPdfText(bytes);
  return extracted ? { text: extracted.text, pages: extracted.pages } : { text: '' };
}

export function createAssetsRoutes(db: Db, assets: AssetsService) {
  return (
    new Hono()
      .get('/:id/file', (c) => {
        const asset = assets.getById(c.req.param('id'));
        if (!asset) return c.json({ error: 'not_found' }, 404);
        const absPath = assets.resolvePath(asset);
        if (!fs.existsSync(absPath)) return c.json({ error: 'file_missing' }, 404);
        const headers: Record<string, string> = {
          'content-type': asset.mime,
          'cache-control': 'immutable, max-age=31536000',
          'x-content-type-options': 'nosniff',
        };
        // 上传的 .html / .xml 等文本附件同源打开会执行脚本：一律按纯文本给，并禁掉脚本
        const isRaster = (IMAGE_MIMES as readonly string[]).includes(asset.mime);
        if (!isRaster && classifyDocumentMime(asset.mime) !== 'pdf') {
          if (classifyDocumentMime(asset.mime) === 'text') {
            headers['content-type'] = 'text/plain; charset=utf-8';
          }
          headers['content-security-policy'] = "default-src 'none'; sandbox";
        }
        return c.body(fs.readFileSync(absPath), 200, headers);
      })
      /**
       * 上传附件（multipart，字段名 `file`）→ 201 {@link UploadResponse}。
       * 同内容（sha256）已存在时直接返回那一行，`name` 以本次上传为准（不改库）。
       */
      .post('/', async (c) => {
        const declared = Number(c.req.header('content-length') ?? 0);
        if (declared > UPLOAD_MAX_BYTES + MULTIPART_SLACK) return c.json(TOO_LARGE, 413);
        const contentType = c.req.header('content-type') ?? '';
        if (!contentType.startsWith('multipart/form-data')) {
          return c.json(
            { error: 'invalid', message: '请用 multipart/form-data 上传（字段名 file）' },
            400,
          );
        }
        let file: unknown;
        try {
          file = (await c.req.parseBody())['file'];
        } catch {
          return c.json({ error: 'invalid', message: '无法解析上传内容' }, 400);
        }
        if (!(file instanceof File)) {
          return c.json({ error: 'invalid', message: '缺少文件（字段名 file）' }, 400);
        }
        if (file.size > UPLOAD_MAX_BYTES) return c.json(TOO_LARGE, 413);
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length === 0) return c.json({ error: 'invalid', message: '文件是空的' }, 400);
        const name = file.name || 'file';

        const cls = classifyUpload(bytes, name);
        if (!cls) return c.json(UNSUPPORTED, 415);

        let row = assets.getBySha256(sha256Of(bytes));
        if (!row) {
          const meta: Record<string, unknown> = { name, size: bytes.length };
          if (cls.category === 'pdf') Object.assign(meta, await pdfMeta(bytes));
          row = assets.save({ bytes, kind: 'upload', mime: cls.mime, source: 'upload', meta });
        } else if (cls.category === 'pdf' && typeof row.meta?.['text'] !== 'string') {
          // 同一份 PDF 之前由别处存进来（例如聊天导入）、没抽过文本：补抽，名字不动
          row = assets.updateMeta(row.id, await pdfMeta(bytes)) ?? row;
        }
        assets.markRecentlyUsed(row.id);
        return c.json(toUploadResponse(row, name, bytes.length, cls), 201);
      })
      /** 清理未被引用、创建超过 24 小时的上传 / 生成 / 头像资产 → `{ removed, freedBytes }` */
      .post('/gc', (c) => c.json(collectGarbage(db, assets)))
  );
}
