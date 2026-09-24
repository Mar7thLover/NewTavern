import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { VariableEditor } from './VariableEditor';
import {
  addChild,
  convertValue,
  countChanges,
  deleteAt,
  issuesByPath,
  renameAt,
  setAt,
} from './variable-tree';

/** 变量管理器（M5（三）§1）：纯逻辑 + 静态渲染（没有 jsdom） */

const TABLE = {
  stat_data: {
    $meta: { strictSet: true },
    昔涟: { 好感度: [30, '[0,100]对user的好感度'], 位置: '客厅' },
    名单: ['甲', '乙'],
  },
  display_data: { x: 1 },
};

describe('变量树的纯逻辑', () => {
  it('改 [值, 说明] 只动值，说明保留；改动计数把二元组当一个叶子', () => {
    const next = setAt(TABLE, ['stat_data', '昔涟', '好感度', 0], 77);
    expect((next.stat_data as typeof TABLE.stat_data).昔涟.好感度).toEqual([
      77,
      '[0,100]对user的好感度',
    ]);
    expect(countChanges(TABLE, next)).toBe(1);
    // 不可变更新：原表不动
    expect(TABLE.stat_data.昔涟.好感度[0]).toBe(30);
  });

  it('增删改名：重名不覆盖（返回 null），数组可追加 / 删除元素', () => {
    expect(renameAt(TABLE, ['stat_data', '昔涟', '位置'], '好感度')).toBeNull();
    const renamed = renameAt(TABLE, ['stat_data', '昔涟', '位置'], '地点');
    expect(Object.keys((renamed?.stat_data as typeof TABLE.stat_data).昔涟)).toEqual([
      '好感度',
      '地点',
    ]);
    expect(addChild(TABLE, ['stat_data'], '名单', 1)).toBeNull();
    const appended = addChild(TABLE, ['stat_data', '名单'], '', '丙');
    expect((appended?.stat_data as typeof TABLE.stat_data).名单).toEqual(['甲', '乙', '丙']);
    const removed = deleteAt(TABLE, ['stat_data', '名单', 0]);
    expect((removed.stat_data as typeof TABLE.stat_data).名单).toEqual(['乙']);
    expect(countChanges(TABLE, deleteAt(TABLE, ['display_data']))).toBe(1);
  });

  it('切类型尽量保留原意', () => {
    expect(convertValue('12', 'number')).toBe(12);
    expect(convertValue('abc', 'number')).toBe(0);
    expect(convertValue(true, 'string')).toBe('true');
    expect(convertValue('true', 'boolean')).toBe(true);
    expect(convertValue('{"a":1}', 'json')).toEqual({ a: 1 });
    expect(convertValue(5, 'null')).toBeNull();
  });

  it('schema 问题按路径分组，[值,说明] 的 x[0] 同时记到 x 上', () => {
    const schema = {
      type: 'object',
      properties: {
        stat_data: {
          type: 'object',
          properties: {
            昔涟: {
              type: 'object',
              properties: {
                好感度: { type: 'array', prefixItems: [{ type: 'number' }, { type: 'string' }] },
              },
            },
          },
        },
      },
    };
    const bad = setAt(TABLE, ['stat_data', '昔涟', '好感度', 0], 'abc');
    const issues = issuesByPath(bad, schema);
    expect(issues.get('stat_data.昔涟.好感度[0]')?.length).toBe(1);
    expect(issues.get('stat_data.昔涟.好感度')?.length).toBe(1);
    expect(issuesByPath(TABLE, schema).size).toBe(0);
    expect(issuesByPath(TABLE, undefined).size).toBe(0);
  });
});

describe('VariableEditor 静态渲染', () => {
  const html = renderToStaticMarkup(
    <VariableEditor
      table={TABLE}
      onSave={() => Promise.resolve()}
      collapsedKeys={['display_data']}
      note="只改当前这条消息"
    />,
  );

  it('渲染成树：分支 / 叶子带 data-kind，[值,说明] 的说明灰显', () => {
    expect(html).toContain('data-part="variable-tree"');
    expect(html).toContain('data-kind="branch"');
    expect(html).toContain('data-kind="leaf"');
    expect(html).toContain('[0,100]对user的好感度');
    expect(html).toContain('只改当前这条消息');
  });

  it('$ 开头的簿记键与指定的派生键默认折叠（子项不渲染）', () => {
    expect(html).toContain('$meta');
    expect(html).not.toContain('strictSet');
    expect(html).toContain('display_data');
    expect(html).not.toContain('>x<');
  });

  it('没有改动时保存键不可用', () => {
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*(保存|variableEditor\.save)/);
  });
});
