import { describe, expect, it } from 'vitest';

import {
  PNG_SIGNATURE,
  encodePngChunk,
  readPngTextChunks,
  removePngTextChunks,
  upsertPngTextChunk,
} from './png-text.js';

/** 最小合法 PNG：IHDR(1x1 RGBA) + IDAT(任意数据，CRC 正确即可) + IEND */
function makePng(extraChunks: Uint8Array[] = []): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [
    PNG_SIGNATURE,
    encodePngChunk('IHDR', ihdr),
    ...extraChunks,
    encodePngChunk('IDAT', new Uint8Array([0x78, 0x01, 0x01])),
    encodePngChunk('IEND', new Uint8Array(0)),
  ];
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function textChunkBytes(keyword: string, text: string): Uint8Array {
  const data = new Uint8Array(keyword.length + 1 + text.length);
  for (let i = 0; i < keyword.length; i++) data[i] = keyword.charCodeAt(i);
  for (let i = 0; i < text.length; i++) data[keyword.length + 1 + i] = text.charCodeAt(i);
  return encodePngChunk('tEXt', data);
}

describe('readPngTextChunks', () => {
  it('无 tEXt 时返回空 Map', () => {
    expect(readPngTextChunks(makePng()).size).toBe(0);
  });

  it('读取多个 tEXt，重复关键字后者覆盖前者', () => {
    const png = makePng([
      textChunkBytes('chara', 'first'),
      textChunkBytes('ccv3', 'v3data'),
      textChunkBytes('chara', 'second'),
    ]);
    const texts = readPngTextChunks(png);
    expect(texts.get('chara')).toBe('second');
    expect(texts.get('ccv3')).toBe('v3data');
  });

  it('签名错误', () => {
    const bad = makePng();
    bad[0] = 0x00;
    expect(() => readPngTextChunks(bad)).toThrow(/不是有效的 PNG 文件/);
    expect(() => readPngTextChunks(new Uint8Array(3))).toThrow(/不是有效的 PNG 文件/);
  });

  it('chunk 越界', () => {
    const png = makePng();
    const truncated = png.subarray(0, png.length - 3);
    expect(() => readPngTextChunks(truncated)).toThrow(/超出文件边界/);
  });

  it('CRC 错误', () => {
    const png = makePng([textChunkBytes('chara', 'data')]);
    // 篡改 tEXt 数据区一个字节（签名 8 + IHDR chunk 25 = 33 起为 tEXt 长度字段）
    const at = 33 + 4 + 4 + 2;
    png[at] = (png[at] ?? 0) ^ 0xff;
    expect(() => readPngTextChunks(png)).toThrow(/CRC 校验失败/);
  });
});

describe('upsertPngTextChunk', () => {
  it('新 chunk 插到第一个 IDAT 之前', () => {
    const png = makePng();
    const out = upsertPngTextChunk(png, 'chara', 'hello');
    // 签名后依次：IHDR tEXt IDAT IEND
    expect(latin1At(out, 8 + 25 + 4)).toBe('tEXt');
    expect(latin1At(out, 8 + 25 + 12 + 5 + 1 + 5 + 4)).toBe('IDAT');
    expect(readPngTextChunks(out).get('chara')).toBe('hello');
  });

  it('已存在则原位替换，且重复同名被合并', () => {
    const png = makePng([
      textChunkBytes('keep', 'v'),
      textChunkBytes('chara', 'first'),
      textChunkBytes('chara', 'second'),
    ]);
    const out = upsertPngTextChunk(png, 'chara', 'replaced-longer-content');
    const texts = readPngTextChunks(out);
    expect(texts.get('chara')).toBe('replaced-longer-content');
    expect(texts.get('keep')).toBe('v');
    // chara 位置保持在 keep 之后、IDAT 之前
    const keepOffset = indexOfAscii(out, 'keep');
    const charaOffset = indexOfAscii(out, 'chara');
    const idatOffset = indexOfAscii(out, 'IDAT');
    expect(charaOffset).toBeGreaterThan(keepOffset);
    expect(charaOffset).toBeLessThan(idatOffset);
    // 只剩一个 chara
    expect(indexOfAscii(out, 'chara', charaOffset + 1)).toBe(-1);
  });

  it('未知 chunk 原样保留', () => {
    const unknown = encodePngChunk('vpAg', new Uint8Array([9, 8, 7, 6]));
    const png = makePng([unknown]);
    const out = upsertPngTextChunk(png, 'chara', 'x');
    const at = indexOfBytes(out, unknown);
    expect(at).toBeGreaterThan(-1);
  });

  it('关键字与内容校验', () => {
    const png = makePng();
    expect(() => upsertPngTextChunk(png, '', 'x')).toThrow(/1–79/);
    expect(() => upsertPngTextChunk(png, 'k'.repeat(80), 'x')).toThrow(/1–79/);
    expect(() => upsertPngTextChunk(png, 'k', '中文')).toThrow(/Latin-1/);
  });

  it('大文本不写坏 PNG（分块拼接路径）', () => {
    const png = makePng();
    const big = 'a'.repeat(200_000);
    const out = upsertPngTextChunk(png, 'chara', big);
    expect(readPngTextChunks(out).get('chara')).toBe(big);
  });
});

describe('removePngTextChunks', () => {
  it('只删除指定关键字', () => {
    const png = makePng([textChunkBytes('chara', 'a'), textChunkBytes('ccv3', 'b')]);
    const out = removePngTextChunks(png, ['chara']);
    const texts = readPngTextChunks(out);
    expect(texts.has('chara')).toBe(false);
    expect(texts.get('ccv3')).toBe('b');
  });
});

function latin1At(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

function indexOfAscii(haystack: Uint8Array, needle: string, from = 0): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}
