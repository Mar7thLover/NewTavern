import { describe, expect, it } from 'vitest';

import { BACKGROUND_NONE, resolveBackground, type BackgroundItem } from './api';
import { nodeExpression, pickSprite, type SpriteItem } from '../sprites/api';

/** 背景生效优先级（M4（二）§A.1）与立绘挑选（§B.2）的纯逻辑 */

const item = (assetId: string): BackgroundItem => ({
  assetId,
  name: assetId,
  width: 1920,
  height: 1080,
  createdAt: '2026-09-22T00:00:00.000Z',
});
const library = [item('g'), item('c'), item('s')];
const chat = (background?: unknown) => ({
  metadata: background === undefined ? {} : { background },
  characterIds: ['char-1'],
});

describe('resolveBackground：会话 > 角色 > 全局', () => {
  it('三层都有时会话赢；会话缺省时角色赢；角色也没有时用全局', () => {
    expect(resolveBackground(chat('s'), { 'char-1': 'c' }, 'g', library)).toEqual({
      assetId: 's',
      source: 'chat',
    });
    expect(resolveBackground(chat(), { 'char-1': 'c' }, 'g', library)).toEqual({
      assetId: 'c',
      source: 'character',
    });
    expect(resolveBackground(chat(), {}, 'g', library)).toEqual({ assetId: 'g', source: 'global' });
    expect(resolveBackground(chat(), {}, null, library)).toEqual({ assetId: null, source: 'none' });
  });

  it("会话写 'none' = 明确不要背景，压过角色与全局", () => {
    expect(resolveBackground(chat(BACKGROUND_NONE), { 'char-1': 'c' }, 'g', library)).toEqual({
      assetId: null,
      source: 'none',
    });
  });

  it('悬空引用（背景已删）当作缺省，往下一层找；库还没加载完时不判悬空', () => {
    expect(resolveBackground(chat('gone'), { 'char-1': 'gone-too' }, 'g', library)).toEqual({
      assetId: 'g',
      source: 'global',
    });
    expect(resolveBackground(chat('gone'), {}, 'g', undefined)).toEqual({
      assetId: 'gone',
      source: 'chat',
    });
  });

  it('没有会话（开始页）只看全局', () => {
    expect(resolveBackground(null, { 'char-1': 'c' }, 'g', library)).toEqual({
      assetId: 'g',
      source: 'global',
    });
  });
});

describe('立绘挑选', () => {
  const sprites: SpriteItem[] = ['joy', 'neutral', 'sadness'].map((label) => ({
    label,
    assetId: `a-${label}`,
  }));

  it('精确 → fallback → neutral → 第一张', () => {
    expect(pickSprite(sprites, 'sadness', 'joy')?.label).toBe('sadness');
    expect(pickSprite(sprites, 'anger', 'joy')?.label).toBe('joy');
    expect(pickSprite(sprites, 'anger', 'nope')?.label).toBe('neutral');
    expect(
      pickSprite(
        sprites.filter((s) => s.label !== 'neutral'),
        null,
        'nope',
      )?.label,
    ).toBe('joy');
    expect(pickSprite([], 'joy', 'neutral')).toBeNull();
  });

  it('节点 extra.expression 只认非空字符串', () => {
    expect(nodeExpression({ expression: 'joy' })).toBe('joy');
    expect(nodeExpression({ expression: '' })).toBeNull();
    expect(nodeExpression({ expression: 3 })).toBeNull();
    expect(nodeExpression(null)).toBeNull();
  });
});
