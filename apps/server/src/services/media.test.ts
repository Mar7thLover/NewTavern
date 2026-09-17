import { describe, expect, it } from 'vitest';

import { readImageSize } from './assets.js';
import { GIF_9X4, JPEG_7X5, makePdf, PNG_2X3, WEBP_640X480 } from './media-fixtures.test-helper.js';
import {
  classifyUpload,
  compactMediaParts,
  decodeUtf8Text,
  extractPdfText,
  generatedImageMime,
  looksLikePdf,
  sniffImageMime,
} from './media.js';

describe('上传判定', () => {
  it('图片与 PDF 看魔数，与扩展名无关', () => {
    expect(classifyUpload(PNG_2X3, 'photo.txt')).toEqual({ category: 'image', mime: 'image/png' });
    expect(classifyUpload(JPEG_7X5, 'x')).toEqual({ category: 'image', mime: 'image/jpeg' });
    expect(classifyUpload(GIF_9X4, 'x.gif')).toEqual({ category: 'image', mime: 'image/gif' });
    expect(classifyUpload(WEBP_640X480, 'x.webp')).toEqual({
      category: 'image',
      mime: 'image/webp',
    });
    expect(classifyUpload(makePdf(['hi']), 'paper.bin')).toEqual({
      category: 'pdf',
      mime: 'application/pdf',
    });
    // %PDF- 前面有少量垃圾字节也认
    expect(looksLikePdf(new TextEncoder().encode('\n\n%PDF-1.7\n'))).toBe(true);
  });

  it('文本类只认白名单扩展名，且必须是合法 UTF-8', () => {
    const utf8 = new TextEncoder().encode('# 标题\n正文');
    expect(classifyUpload(utf8, 'notes.MD')).toEqual({
      category: 'text',
      mime: 'text/markdown',
      text: '# 标题\n正文',
    });
    expect(classifyUpload(utf8, 'data.json')?.mime).toBe('application/json');
    expect(classifyUpload(utf8, 'page.html')?.mime).toBe('text/html');
    expect(classifyUpload(utf8, 'feed.xml')?.mime).toBe('text/xml');
    expect(classifyUpload(utf8, 'conf.yml')?.mime).toBe('text/yaml');
    // 不在白名单
    expect(classifyUpload(utf8, 'script.js')).toBeNull();
    expect(classifyUpload(utf8, 'noext')).toBeNull();
    // GBK 字节不是合法 UTF-8
    expect(classifyUpload(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]), 'gbk.txt')).toBeNull();
    // 含 NUL 视为二进制
    expect(classifyUpload(new Uint8Array([0x61, 0x00, 0x62]), 'bin.txt')).toBeNull();
    // BOM 去掉
    expect(decodeUtf8Text(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('a');
  });

  it('宽高：PNG / JPEG / WebP / GIF', () => {
    expect(readImageSize(PNG_2X3, 'image/png')).toEqual({ width: 2, height: 3 });
    expect(readImageSize(JPEG_7X5, 'image/jpeg')).toEqual({ width: 7, height: 5 });
    expect(readImageSize(WEBP_640X480, 'image/webp')).toEqual({ width: 640, height: 480 });
    expect(readImageSize(GIF_9X4, 'image/gif')).toEqual({ width: 9, height: 4 });
    // 截断的文件头不抛
    expect(readImageSize(JPEG_7X5.subarray(0, 12), 'image/jpeg')).toBeUndefined();
    expect(readImageSize(WEBP_640X480.subarray(0, 20), 'image/webp')).toBeUndefined();
  });

  it('模型输出图片的 mime：文件头优先，认不出时只接受四种栅格图', () => {
    expect(generatedImageMime(PNG_2X3, 'image/jpeg')).toBe('image/png');
    expect(generatedImageMime(new Uint8Array([1, 2, 3]), 'image/webp')).toBe('image/webp');
    expect(generatedImageMime(new Uint8Array([1, 2, 3]), 'image/svg+xml')).toBeNull();
    expect(sniffImageMime(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('PDF 文本抽取', () => {
  it('抽出文本与页数', async () => {
    const result = await extractPdfText(makePdf(['Hello PDF', 'Second line']));
    expect(result?.pages).toBe(1);
    expect(result?.text).toContain('Hello PDF');
    expect(result?.text).toContain('Second line');
  });

  it('损坏的 PDF 不抛，返回 undefined', async () => {
    await expect(
      extractPdfText(new TextEncoder().encode('%PDF-1.4 garbage')),
    ).resolves.toBeUndefined();
  });

  it('不改动传入的字节（pdf.js 会转移 ArrayBuffer）', async () => {
    const bytes = makePdf(['keep me']);
    const before = bytes.length;
    await extractPdfText(bytes);
    expect(bytes.length).toBe(before);
    expect(looksLikePdf(bytes)).toBe(true);
  });
});

describe('compactMediaParts', () => {
  it('有媒体时去掉空文本 part；没有媒体时原样', () => {
    const image = { type: 'image', assetId: 'a', mime: 'image/png' } as const;
    expect(compactMediaParts([{ type: 'text', text: '' }, image])).toEqual([image]);
    expect(compactMediaParts([{ type: 'text', text: '' }])).toEqual([{ type: 'text', text: '' }]);
  });
});
