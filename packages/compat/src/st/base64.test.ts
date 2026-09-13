import { describe, expect, it } from 'vitest';

import { base64Decode, base64Encode, base64FromUtf8, utf8FromBase64 } from './base64.js';

describe('base64', () => {
  it('已知向量编解码', () => {
    expect(base64Encode(new Uint8Array([]))).toBe('');
    expect(base64Encode(new Uint8Array([0x61]))).toBe('YQ==');
    expect(base64Encode(new Uint8Array([0x61, 0x62]))).toBe('YWI=');
    expect(base64Encode(new Uint8Array([0x61, 0x62, 0x63]))).toBe('YWJj');
    expect(base64Encode(new Uint8Array([1, 2, 3, 254, 255]))).toBe('AQID/v8=');
    expect([...base64Decode('AQID/v8=')]).toEqual([1, 2, 3, 254, 255]);
    expect([...base64Decode('')]).toEqual([]);
  });

  it('随机字节往返（含跨块拼接）', () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % 256;
    };
    for (const length of [1, 2, 3, 4, 5, 100, 12291]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = random();
      expect(base64Decode(base64Encode(bytes))).toEqual(bytes);
    }
  });

  it('解码容忍空白字符', () => {
    expect([...base64Decode('AQID\n/v8= ')]).toEqual([1, 2, 3, 254, 255]);
  });

  it('非法字符与非法长度报错', () => {
    expect(() => base64Decode('AQ!D')).toThrow(/非法字符/);
    expect(() => base64Decode('AQIDA')).toThrow(/4 的倍数/);
    expect(() => base64Decode('AQ==AQ==')).toThrow(/出现在中间/);
  });

  it('UTF-8 多字节文本往返', () => {
    const text = '{"name":"中文角色","greeting":"你好，世界！🎭"}';
    expect(utf8FromBase64(base64FromUtf8(text))).toBe(text);
  });
});
