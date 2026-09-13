/**
 * 平台无关 base64 编解码（查表法），不依赖 atob/btoa 或 Buffer。
 * 大输入按块拼接字符串，避免 O(n²) 与栈溢出。
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const REVERSE: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

const CHUNK_CHARS = 16384;

export function base64Encode(bytes: Uint8Array): string {
  const parts: string[] = [];
  let buf = '';
  const fullTriplesEnd = bytes.length - (bytes.length % 3);
  let i = 0;
  for (; i < fullTriplesEnd; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    buf +=
      ALPHABET.charAt((n >>> 18) & 63) +
      ALPHABET.charAt((n >>> 12) & 63) +
      ALPHABET.charAt((n >>> 6) & 63) +
      ALPHABET.charAt(n & 63);
    if (buf.length >= CHUNK_CHARS) {
      parts.push(buf);
      buf = '';
    }
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const n = bytes[i]! << 16;
    buf += ALPHABET.charAt((n >>> 18) & 63) + ALPHABET.charAt((n >>> 12) & 63) + '==';
  } else if (remaining === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    buf +=
      ALPHABET.charAt((n >>> 18) & 63) +
      ALPHABET.charAt((n >>> 12) & 63) +
      ALPHABET.charAt((n >>> 6) & 63) +
      '=';
  }
  parts.push(buf);
  return parts.join('');
}

export function base64Decode(text: string): Uint8Array {
  // 收集四元组值（'=' 记为 -2），跳过空白
  const values: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code === 0x3d) {
      values.push(-2);
      continue;
    }
    const value = code < 128 ? REVERSE[code]! : -1;
    if (value === -1) {
      throw new Error(`base64 解码失败：含非法字符「${text.charAt(i)}」`);
    }
    values.push(value);
  }
  if (values.length % 4 !== 0) {
    throw new Error('base64 解码失败：长度不是 4 的倍数');
  }
  let padding = 0;
  if (values.length > 0 && values[values.length - 1] === -2) padding += 1;
  if (values.length > 1 && values[values.length - 2] === -2) padding += 1;
  for (let i = 0; i < values.length - padding; i++) {
    if (values[i] === -2) throw new Error('base64 解码失败：填充符「=」出现在中间');
  }
  const out = new Uint8Array((values.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < values.length; i += 4) {
    const n =
      (values[i]! << 18) |
      (values[i + 1]! << 12) |
      (Math.max(values[i + 2]!, 0) << 6) |
      Math.max(values[i + 3]!, 0);
    if (o < out.length) out[o++] = (n >>> 16) & 0xff;
    if (o < out.length) out[o++] = (n >>> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }
  return out;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

/** UTF-8 文本 → base64（卡 JSON 写入 PNG tEXt 的标准编码路径） */
export function base64FromUtf8(text: string): string {
  return base64Encode(utf8Encoder.encode(text));
}

/** base64 → UTF-8 文本；JSON 解析失败由调用方包装 */
export function utf8FromBase64(base64: string): string {
  return utf8Decoder.decode(base64Decode(base64));
}
