import { describe, expect, it } from 'vitest';

import { countWords } from './wordcount.js';

describe('countWords', () => {
  it('中文按字，全角标点计字', () => {
    expect(countWords('林澈跪在殿前。')).toBe(7);
    expect(countWords('《剑来》，好！')).toBe(7);
  });

  it('英文按词，缩写与连字符算一个词', () => {
    expect(countWords("Don't stop the well-known man.")).toBe(5);
    expect(countWords('He said: “hello” — then left…')).toBe(5);
  });

  it('中文里的弯引号、省略号、破折号计字', () => {
    // 他 说 ： “ 走 。 ” …… —— 共 5 个 CJK/全角 + “ ” 2 + …… 2 + —— 2
    expect(countWords('他说：“走。”……——')).toBe(11);
  });

  it('中英混排', () => {
    expect(countWords('林澈用 GPT-5 写了 3 章 novel')).toBe(3 + 1 + 2 + 1 + 1 + 1);
  });

  it('空白与空串', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('  \n\t ')).toBe(0);
    expect(countWords('　　段首缩进')).toBe(4);
  });

  it('扩展区汉字（代理对）按一个字计', () => {
    expect(countWords('𠀀𠀁')).toBe(2);
  });
});
