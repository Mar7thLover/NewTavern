import { describe, expect, it } from 'vitest';

import { loadCatalog } from './catalog.js';
import {
  classifyDocumentMime,
  createMediaRenderer,
  decodeBase64Utf8,
  parseDataUrl,
  redactInlineMedia,
  toDataUrl,
} from './media.js';
import { PNG_B64, TXT_B64, TXT_CONTENT } from './test-media.js';

/** 生成 n 个字节对应的 base64（内容无所谓，只看长度） */
function base64OfBytes(n: number): string {
  return Buffer.alloc(n, 7).toString('base64');
}

describe('redactInlineMedia', () => {
  it('data URL → data:<mime>;base64,<省略 N 字节>（N 为解码后的字节数）', () => {
    const b64 = base64OfBytes(3000);
    expect(redactInlineMedia(`data:image/png;base64,${b64}`)).toBe(
      'data:image/png;base64,<省略 3000 字节>',
    );
    // 带参数的 data URL 只保留 mime
    expect(redactInlineMedia(`data:application/pdf;name=a.pdf;base64,${PNG_B64}`)).toBe(
      'data:application/pdf;base64,<省略 8 字节>',
    );
  });

  it('深度遍历各家请求体：OpenAI image_url / file_data、Anthropic source.data、Gemini inlineData.data', () => {
    const big = base64OfBytes(1024);
    const body = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${big}` } },
            {
              type: 'file',
              file: { filename: 'a.pdf', file_data: `data:application/pdf;base64,${big}` },
            },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
          ],
        },
      ],
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: big } }] }],
      max_tokens: 100,
      stream: true,
      stop: null,
    };
    expect(redactInlineMedia(body)).toEqual({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,<省略 1024 字节>' } },
            {
              type: 'file',
              file: {
                filename: 'a.pdf',
                file_data: 'data:application/pdf;base64,<省略 1024 字节>',
              },
            },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: '<base64 省略 1024 字节>' },
            },
          ],
        },
      ],
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: '<base64 省略 1024 字节>' } }],
        },
      ],
      max_tokens: 100,
      stream: true,
      stop: null,
    });
  });

  it('长 base64 阈值：512 字符及以下、或含非 base64 字符的长文本不动', () => {
    const exactly512 = 'A'.repeat(512);
    expect(redactInlineMedia(exactly512)).toBe(exactly512);
    const long = 'A'.repeat(516);
    expect(redactInlineMedia(long)).toBe('<base64 省略 387 字节>');
    const prose = '这是一段很长的正文。'.repeat(100);
    expect(redactInlineMedia(prose)).toBe(prose);
    const words = 'lorem ipsum '.repeat(100);
    expect(redactInlineMedia(words)).toBe(words);
    // 占位 URL 与普通 URL 不动
    expect(redactInlineMedia('asset:abc')).toBe('asset:abc');
    expect(redactInlineMedia('https://x/a.png')).toBe('https://x/a.png');
  });

  it('文本中间嵌着的 data URL 也替换（例如 Markdown 图片）', () => {
    expect(redactInlineMedia(`前文 ![图](data:image/gif;base64,${PNG_B64}) 后文`)).toBe(
      '前文 ![图](data:image/gif;base64,<省略 8 字节>) 后文',
    );
  });

  it('纯函数：不改入参，且对已脱敏的结果幂等', () => {
    const body = { a: [{ url: `data:image/png;base64,${base64OfBytes(900)}` }], n: 1 };
    const snapshot = JSON.stringify(body);
    const once = redactInlineMedia(body);
    expect(JSON.stringify(body)).toBe(snapshot);
    expect(once).not.toBe(body);
    expect(redactInlineMedia(once)).toEqual(once);
    expect(redactInlineMedia(null)).toBeNull();
    expect(redactInlineMedia(42)).toBe(42);
  });
});

describe('媒体工具函数', () => {
  it('parseDataUrl / toDataUrl 往返，非 base64 data URL 返回 undefined', () => {
    expect(parseDataUrl(toDataUrl('image/png', PNG_B64))).toEqual({
      mime: 'image/png',
      base64: PNG_B64,
    });
    expect(parseDataUrl('DATA:Image/WEBP;base64,UklGRg==')).toEqual({
      mime: 'image/webp',
      base64: 'UklGRg==',
    });
    expect(parseDataUrl('data:text/plain,hello')).toBeUndefined();
    expect(parseDataUrl('https://x/a.png')).toBeUndefined();
  });

  it('classifyDocumentMime：PDF / 文本类 / 其他', () => {
    expect(classifyDocumentMime('application/pdf')).toBe('pdf');
    expect(classifyDocumentMime('text/markdown; charset=utf-8')).toBe('text');
    expect(classifyDocumentMime('application/json')).toBe('text');
    expect(classifyDocumentMime('application/msword')).toBe('other');
  });

  it('decodeBase64Utf8：中文往返；非法 base64 返回 undefined', () => {
    expect(decodeBase64Utf8(TXT_B64)).toBe(TXT_CONTENT);
    expect(decodeBase64Utf8('***')).toBeUndefined();
  });

  it('不支持的文档类型：丢弃并告警（不计入 PDF 汇总）', () => {
    const warnings: string[] = [];
    const renderer = createMediaRenderer({
      caps: loadCatalog().defaults,
      label: 'X',
      warnings,
    });
    expect(
      renderer.render(
        { type: 'document', assetId: 'd', mime: 'application/zip' },
        { accepts: true, role: 'user' },
      ),
    ).toBeUndefined();
    renderer.flush();
    expect(warnings).toEqual(['不支持的文档类型 application/zip，已丢弃 d']);
  });
});
