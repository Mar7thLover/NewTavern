import { describe, expect, it } from 'vitest';

import { collectBookOpeners } from './openers.js';
import { makeBook, makeEntry } from './test-helpers.js';

describe('collectBookOpeners', () => {
  it('@@is_greeting 取正文、按序号排；装饰器行已剥掉', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'e2', comment: '第二幕', content: '@@is_greeting 1\n又见面了。' }),
        makeEntry({ id: 'e1', comment: '序章', content: '@@is_greeting 0\n欢迎来到雾港。' }),
      ]),
    ];
    const openers = collectBookOpeners(books);
    expect(openers.map((item) => [item.entryId, item.index, item.content])).toEqual([
      ['e1', 0, '欢迎来到雾港。'],
      ['e2', 1, '又见面了。'],
    ]);
    expect(openers[0]?.kind).toBe('greeting');
    expect(openers[0]?.label).toBe('序章');
  });

  it('@@is_greeting 不带参数视作第 0 条', () => {
    const books = [makeBook([makeEntry({ id: 'e1', content: '@@is_greeting\n你好。' })])];
    expect(collectBookOpeners(books)).toMatchObject([{ index: 0, kind: 'greeting' }]);
  });

  it('role=assistant 的条目作为 prefill 候选，排在 greeting 之后', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'p1', role: 2, position: 4, depth: 0, content: '（你推开门。）' }),
        makeEntry({ id: 'g1', content: '@@is_greeting 3\n开场。' }),
      ]),
    ];
    expect(collectBookOpeners(books).map((item) => [item.entryId, item.kind])).toEqual([
      ['g1', 'greeting'],
      ['p1', 'prefill'],
    ]);
  });

  it('prefill 按 @depth 由浅到深', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'd2', role: 2, position: 4, depth: 2, content: '深的' }),
        makeEntry({ id: 'd0', role: 2, position: 4, depth: 0, content: '浅的' }),
      ]),
    ];
    expect(collectBookOpeners(books).map((item) => item.entryId)).toEqual(['d0', 'd2']);
  });

  it('同时带 @@is_greeting 与 role=assistant 时按 greeting 计一次', () => {
    const books = [
      makeBook([makeEntry({ id: 'e1', role: 2, content: '@@is_greeting 0\n只算一次。' })]),
    ];
    expect(collectBookOpeners(books)).toMatchObject([{ entryId: 'e1', kind: 'greeting' }]);
  });

  it('禁用条目、空正文、普通 role 都不算开场白', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'off', disabled: true, content: '@@is_greeting 0\nx' }),
        makeEntry({ id: 'blank', role: 2, content: '   ' }),
        makeEntry({ id: 'sys', role: 0, content: '普通世界书内容' }),
        makeEntry({ id: 'none', content: '普通世界书内容' }),
      ]),
    ];
    expect(collectBookOpeners(books)).toEqual([]);
  });

  it('多本书：同组内按书序、书内条目序稳定排列', () => {
    const books = [
      makeBook([makeEntry({ id: 'a1', content: '@@is_greeting 0\nA' })], 'global', 'book-a'),
      makeBook([makeEntry({ id: 'b1', content: '@@is_greeting 0\nB' })], 'global', 'book-b'),
    ];
    expect(collectBookOpeners(books).map((item) => item.bookId)).toEqual(['book-a', 'book-b']);
  });
});
