import { describe, expect, it } from 'vitest';

import {
  addVariable,
  decrementVariable,
  incrementVariable,
  readVariable,
  stringifyVariable,
  VariableTransaction,
  writeVariable,
} from './transaction.js';

describe('VariableTransaction 基本读写', () => {
  it('读到基线值，写入后读到新值，基线对象不被改动', () => {
    const base = { chat: { hp: '10' }, global: { gold: '5' } };
    const tx = new VariableTransaction(base);

    expect(tx.get('chat', 'hp')).toBe('10');
    expect(tx.get('global', 'gold')).toBe('5');
    expect(tx.get('chat', 'nope')).toBeUndefined();

    tx.set('chat', 'hp', '12');
    expect(tx.get('chat', 'hp')).toBe('12');
    expect(base.chat.hp).toBe('10');
  });

  it('snapshot 返回当前值的浅拷贝', () => {
    const tx = new VariableTransaction({ chat: { a: '1' } });
    tx.set('chat', 'b', '2');
    const snap = tx.snapshot('chat');
    expect(snap).toEqual({ a: '1', b: '2' });
    snap.c = '3';
    expect(tx.get('chat', 'c')).toBeUndefined();
    expect(tx.snapshot('global')).toEqual({});
  });

  it('没有基线时也能工作', () => {
    const tx = new VariableTransaction();
    expect(tx.dirty).toBe(false);
    tx.set('global', 'x', '1');
    expect(tx.dirty).toBe(true);
    expect(tx.commit()).toEqual({ chat: {}, globalChanges: { x: '1' } });
  });
});

describe('VariableTransaction events', () => {
  it('按写入顺序记录 set 事件与新旧值', () => {
    const tx = new VariableTransaction({ chat: { hp: '10' }, global: {} });
    tx.set('chat', 'hp', '11');
    tx.set('global', 'gold', '1');
    tx.set('chat', 'hp', 12);

    expect(tx.events).toEqual([
      { scope: 'chat', op: 'set', key: 'hp', oldValue: '10', newValue: '11' },
      { scope: 'global', op: 'set', key: 'gold', oldValue: undefined, newValue: '1' },
      { scope: 'chat', op: 'set', key: 'hp', oldValue: '11', newValue: 12 },
    ]);
  });

  it('delete 记录 delete 事件，删不存在的键不记录', () => {
    const tx = new VariableTransaction({ chat: { hp: '10' }, global: {} });
    tx.delete('chat', 'nope');
    tx.delete('chat', 'hp');
    expect(tx.events).toEqual([
      { scope: 'chat', op: 'delete', key: 'hp', oldValue: '10', newValue: undefined },
    ]);
    expect(tx.snapshot('chat')).toEqual({});
  });
});

describe('VariableTransaction commit / rollback', () => {
  it('commit 给出 chat 完整快照与 global 变更键', () => {
    const tx = new VariableTransaction({
      chat: { hp: '10', mp: '3' },
      global: { gold: '5', name: 'Ren' },
    });
    tx.set('chat', 'hp', '11');
    tx.set('global', 'gold', '6');

    expect(tx.commit()).toEqual({
      chat: { hp: '11', mp: '3' },
      globalChanges: { gold: '6' },
    });
  });

  it('global 删除的键在 globalChanges 里值为 undefined', () => {
    const tx = new VariableTransaction({ chat: {}, global: { gold: '5' } });
    tx.delete('global', 'gold');
    const commit = tx.commit();
    expect(Object.hasOwn(commit.globalChanges, 'gold')).toBe(true);
    expect(commit.globalChanges.gold).toBeUndefined();
  });

  it('写成同值不算变更', () => {
    const tx = new VariableTransaction({ chat: {}, global: { gold: '5' } });
    tx.set('global', 'gold', '5');
    expect(tx.commit().globalChanges).toEqual({});
    expect(tx.events).toHaveLength(1);
  });

  it('rollback 丢弃改动与事件', () => {
    const tx = new VariableTransaction({ chat: { hp: '10' }, global: { gold: '5' } });
    tx.set('chat', 'hp', '99');
    tx.set('global', 'gold', '99');
    tx.rollback();

    expect(tx.events).toHaveLength(0);
    expect(tx.dirty).toBe(false);
    expect(tx.commit()).toEqual({ chat: { hp: '10' }, globalChanges: {} });
  });
});

describe('ST 值语义', () => {
  it('readVariable：数值字符串读成数字，缺失 / 空串读成空串', () => {
    const tx = new VariableTransaction({
      chat: { n: '12', pad: ' 7 ', empty: '', blank: '  ', text: 'abc' },
      global: {},
    });
    expect(readVariable(tx, 'chat', 'n')).toBe(12);
    expect(readVariable(tx, 'chat', 'pad')).toBe(7);
    expect(readVariable(tx, 'chat', 'empty')).toBe('');
    // ST：trim 后为空的字符串走 `value || ''`，原样返回（不会变成数字 0）
    expect(readVariable(tx, 'chat', 'blank')).toBe('  ');
    expect(readVariable(tx, 'chat', 'text')).toBe('abc');
    expect(readVariable(tx, 'chat', 'missing')).toBe('');
  });

  it('writeVariable 原样存字符串', () => {
    const tx = new VariableTransaction();
    expect(writeVariable(tx, 'chat', 'a', '007')).toBe('007');
    expect(tx.get('chat', 'a')).toBe('007');
    expect(readVariable(tx, 'chat', 'a')).toBe(7);
  });

  it('addVariable：两侧都是数字则相加（存成 number）', () => {
    const tx = new VariableTransaction({ chat: { hp: '10' }, global: {} });
    expect(addVariable(tx, 'chat', 'hp', '5')).toBe(15);
    expect(tx.get('chat', 'hp')).toBe(15);
  });

  it('addVariable：任一侧非数字则字符串拼接', () => {
    const tx = new VariableTransaction({ chat: { s: 'ab' }, global: {} });
    expect(addVariable(tx, 'chat', 's', 'cd')).toBe('abcd');
    expect(addVariable(tx, 'chat', 'num', '3')).toBe(3);
    expect(addVariable(tx, 'chat', 'fresh', 'x')).toBe('x');
  });

  it('addVariable：当前值是 JSON 数组时 push', () => {
    const tx = new VariableTransaction({ chat: { list: '[1,2]' }, global: {} });
    expect(addVariable(tx, 'chat', 'list', '3')).toBe('[1,2,"3"]');
    expect(tx.get('chat', 'list')).toBe('[1,2,"3"]');
  });

  it('incvar / decvar 返回新值（ST 的宏会输出它）', () => {
    const tx = new VariableTransaction({ chat: { hp: '10' }, global: { gold: '1' } });
    expect(incrementVariable(tx, 'chat', 'hp')).toBe(11);
    expect(decrementVariable(tx, 'chat', 'hp')).toBe(10);
    expect(incrementVariable(tx, 'global', 'gold')).toBe(2);
    // 不存在的变量从 0 起算
    expect(incrementVariable(tx, 'chat', 'fresh')).toBe(1);
    // 非数值变量走拼接（ST 的实际行为）
    expect(addVariable(tx, 'chat', 'txt', 'a')).toBe('a');
    expect(incrementVariable(tx, 'chat', 'txt')).toBe('a1');
  });

  it('stringifyVariable：对象 JSON 化、空值成空串', () => {
    expect(stringifyVariable('a')).toBe('a');
    expect(stringifyVariable(12)).toBe('12');
    expect(stringifyVariable(undefined)).toBe('');
    expect(stringifyVariable(null)).toBe('');
    expect(stringifyVariable({ a: 1 })).toBe('{"a":1}');
    expect(stringifyVariable([1, 2])).toBe('[1,2]');
    expect(stringifyVariable(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });
});
