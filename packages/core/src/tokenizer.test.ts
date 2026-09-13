import { describe, expect, it } from 'vitest';

import { estimateTokens } from './tokenizer.js';

describe('estimateTokens', () => {
  it('空串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('英文按约 4 字符 1 token', () => {
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('CJK 按字符计', () => {
    expect(estimateTokens('你好，世界')).toBe(5);
  });
});
