/**
 * PNG tEXt chunk 读写。浏览器/Node 通用，CRC32 查表法自实现（不依赖 node:zlib）。
 * PNG 结构：8 字节签名 + 若干 chunk（4 字节大端 length + 4 字节 type + data + 4 字节 CRC32，
 * CRC 覆盖 type+data）。
 */

export const PNG_SIGNATURE: Uint8Array = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function latin1Decode(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 8192) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return parts.join('');
}

function latin1Encode(text: string, what: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0xff) {
      throw new Error(`${what}包含非 Latin-1 字符（U+${code.toString(16).padStart(4, '0')}）`);
    }
    out[i] = code;
  }
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
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

interface PngChunk {
  type: string;
  data: Uint8Array;
  /** 整个 chunk（含 length/type/CRC）在源字节中的范围 */
  start: number;
  end: number;
  /** 仅 tEXt：null 分隔符前的关键字 */
  keyword?: string;
}

function parseChunks(bytes: Uint8Array): PngChunk[] {
  if (bytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new Error('不是有效的 PNG 文件（签名不匹配）');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      throw new Error('PNG 数据损坏：chunk 头超出文件边界');
    }
    const length = view.getUint32(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const crcEnd = dataStart + length + 4;
    if (crcEnd > bytes.length) {
      throw new Error('PNG 数据损坏：chunk 超出文件边界');
    }
    const type = latin1Decode(bytes.subarray(typeStart, dataStart));
    const crcExpected = view.getUint32(dataStart + length);
    const crcActual = crc32(bytes.subarray(typeStart, dataStart + length));
    if (crcActual !== crcExpected) {
      throw new Error(`PNG chunk CRC 校验失败（类型 ${type}）`);
    }
    const chunk: PngChunk = {
      type,
      data: bytes.subarray(dataStart, dataStart + length),
      start: offset,
      end: crcEnd,
    };
    if (type === 'tEXt') {
      const separator = chunk.data.indexOf(0);
      if (separator === -1) {
        throw new Error('PNG tEXt chunk 缺少关键字分隔符（0x00）');
      }
      chunk.keyword = latin1Decode(chunk.data.subarray(0, separator));
    }
    chunks.push(chunk);
    offset = crcEnd;
    if (type === 'IEND') break;
  }
  return chunks;
}

/** 编码一个完整 PNG chunk（length + type + data + CRC32） */
export function encodePngChunk(type: string, data: Uint8Array): Uint8Array {
  if (type.length !== 4) {
    throw new Error(`PNG chunk 类型必须是 4 个字符：「${type}」`);
  }
  if (data.length > 0x7fffffff) {
    throw new Error('PNG chunk 数据过大');
  }
  const typeBytes = latin1Encode(type, 'chunk 类型');
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodeTextChunk(keyword: string, text: string): Uint8Array {
  const keywordBytes = latin1Encode(keyword, 'tEXt 关键字');
  if (keywordBytes.length < 1 || keywordBytes.length > 79) {
    throw new Error(`tEXt 关键字长度须在 1–79 字节之间：「${keyword}」`);
  }
  if (keywordBytes.includes(0)) {
    throw new Error('tEXt 关键字不能包含 0x00');
  }
  const textBytes = latin1Encode(text, 'tEXt 内容');
  const data = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  data.set(keywordBytes, 0);
  data.set(textBytes, keywordBytes.length + 1);
  return encodePngChunk('tEXt', data);
}

/** 读取全部 tEXt chunk；同名关键字后者覆盖前者 */
export function readPngTextChunks(bytes: Uint8Array): Map<string, string> {
  const texts = new Map<string, string>();
  for (const chunk of parseChunks(bytes)) {
    if (chunk.type !== 'tEXt' || chunk.keyword === undefined) continue;
    texts.set(chunk.keyword, latin1Decode(chunk.data.subarray(chunk.keyword.length + 1)));
  }
  return texts;
}

/**
 * 写入 tEXt chunk：已存在则原位替换（重复同名只保留首个位置），
 * 不存在则插到第一个 IDAT 之前（无 IDAT 则插到 IEND 之前）。其余 chunk 原样保留。
 */
export function upsertPngTextChunk(bytes: Uint8Array, keyword: string, text: string): Uint8Array {
  const chunks = parseChunks(bytes);
  const textChunk = encodeTextChunk(keyword, text);
  const segments: (Uint8Array | null)[] = chunks.map((chunk) =>
    bytes.subarray(chunk.start, chunk.end),
  );
  let firstMatch = -1;
  chunks.forEach((chunk, index) => {
    if (chunk.type !== 'tEXt' || chunk.keyword !== keyword) return;
    if (firstMatch === -1) firstMatch = index;
    else segments[index] = null; // 丢弃重复同名片段
  });
  if (firstMatch !== -1) {
    segments[firstMatch] = textChunk;
  } else {
    let insertAt = chunks.findIndex((chunk) => chunk.type === 'IDAT');
    if (insertAt === -1) insertAt = chunks.findIndex((chunk) => chunk.type === 'IEND');
    if (insertAt === -1) insertAt = segments.length;
    segments.splice(insertAt, 0, textChunk);
  }
  const kept = segments.filter((segment): segment is Uint8Array => segment !== null);
  return concatBytes([bytes.subarray(0, PNG_SIGNATURE.length), ...kept]);
}

/** 删除指定关键字的全部 tEXt chunk */
export function removePngTextChunks(bytes: Uint8Array, keywords: readonly string[]): Uint8Array {
  const set = new Set(keywords);
  return removePngTextChunksWhere(bytes, (keyword) => set.has(keyword));
}

/** 按谓词删除 tEXt chunk（供 chara-ext-asset_: 前缀清理等场景使用） */
export function removePngTextChunksWhere(
  bytes: Uint8Array,
  predicate: (keyword: string) => boolean,
): Uint8Array {
  const chunks = parseChunks(bytes);
  const segments: Uint8Array[] = [bytes.subarray(0, PNG_SIGNATURE.length)];
  for (const chunk of chunks) {
    if (chunk.type === 'tEXt' && chunk.keyword !== undefined && predicate(chunk.keyword)) {
      continue;
    }
    segments.push(bytes.subarray(chunk.start, chunk.end));
  }
  return concatBytes(segments);
}
