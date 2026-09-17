import { describe, expect, it } from 'vitest';

import { matchScore, queryTokens, rankItems } from './match';

describe('命令面板匹配', () => {
  it('中文按子串匹配', () => {
    expect(matchScore(queryTokens('界书'), '世界书')).toBeGreaterThan(0);
    expect(matchScore(queryTokens('世界'), '世界书')).toBeGreaterThan(
      matchScore(queryTokens('界书'), '世界书'),
    );
    expect(matchScore(queryTokens('书世'), '世界书')).toBe(0);
  });

  it('拉丁字母不区分大小写，全角字母等同半角', () => {
    expect(matchScore(queryTokens('ELA'), 'Ela 的酒馆')).toBeGreaterThan(0);
    expect(matchScore(queryTokens('ｅｌａ'), 'Ela 的酒馆')).toBeGreaterThan(0);
    expect(matchScore(queryTokens('yuye'), '雨夜', ['Yuye'])).toBe(1);
  });

  it('多个词都要命中；空查询全部保留', () => {
    expect(matchScore(queryTokens('设置 外观'), '设置 · 外观')).toBeGreaterThan(0);
    expect(matchScore(queryTokens('设置 雨'), '设置 · 外观')).toBe(0);
    expect(matchScore(queryTokens('   '), '任何东西')).toBe(1);
  });

  it('排序：名字开头 > 名字中间 > 别名；同分保持原顺序；limit 生效', () => {
    const items = [
      { label: '夜琉璃', keywords: [] },
      { label: '雨夜', keywords: [] },
      { label: '素', keywords: ['夜'] },
      { label: '夜灯', keywords: [] },
    ];
    expect(rankItems(items, queryTokens('夜')).map((item) => item.label)).toEqual([
      '夜琉璃',
      '夜灯',
      '雨夜',
      '素',
    ]);
    expect(rankItems(items, queryTokens('夜'), 2)).toHaveLength(2);
  });
});
