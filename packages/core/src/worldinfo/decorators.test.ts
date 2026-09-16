/** 装饰器测试（契约 §1.3「装饰器覆写」）：解析规则照 ST parseDecorators，字段覆写按 CCv3。 */

import { describe, expect, it } from 'vitest';

import { applyDecorators, parseDecorators } from './decorators.js';
import {
  activatedIds,
  makeBook,
  makeEntry,
  rejectionOf,
  runScan,
  userMessage,
} from './test-helpers.js';

describe('parseDecorators', () => {
  it('不以 @@ 开头的内容原样返回', () => {
    expect(parseDecorators('hello\n@@depth 3')).toEqual([[], 'hello\n@@depth 3']);
  });

  it('剥离头部装饰器行，保留其余内容', () => {
    expect(parseDecorators('@@depth 3\n@@role user\nbody\nmore')).toEqual([
      ['@@depth 3', '@@role user'],
      'body\nmore',
    ]);
  });

  it('未知装饰器行被剥离但不生效', () => {
    expect(parseDecorators('@@totally_unknown x\nbody')).toEqual([[], 'body']);
  });

  it('@@@ 回退装饰器只在上一行未知时生效', () => {
    expect(parseDecorators('@@totally_unknown x\n@@@depth 5\nbody')).toEqual([
      ['@@depth 5'],
      'body',
    ]);
    expect(parseDecorators('@@depth 2\n@@@depth 5\nbody')).toEqual([['@@depth 2'], 'body']);
  });

  it('全是装饰器行时内容原样保留（ST 行为）', () => {
    expect(parseDecorators('@@depth 3')).toEqual([['@@depth 3'], '@@depth 3']);
  });
});

describe('applyDecorators 字段覆写', () => {
  it('覆写 depth / position / role / scan_depth', () => {
    const entry = applyDecorators(
      makeEntry({
        id: 'e1',
        content: '@@depth 3\n@@position at_depth\n@@role assistant\n@@scan_depth 7\nbody',
      }),
    );
    expect(entry).toMatchObject({ depth: 3, position: 4, role: 2, scanDepth: 7, content: 'body' });
  });

  it('position 支持 ST 数字与 CCv3 名称', () => {
    expect(applyDecorators(makeEntry({ id: 'e1', content: '@@position 6\nx' })).position).toBe(6);
    expect(
      applyDecorators(makeEntry({ id: 'e1', content: '@@position after_char\nx' })).position,
    ).toBe(1);
  });

  it('@@additional_keys 追加主键，@@exclude_keys 借 NOT_ANY 表达', () => {
    const entry = applyDecorators(
      makeEntry({
        id: 'e1',
        keys: ['a'],
        content: '@@additional_keys b, c\n@@exclude_keys x,y\nbody',
      }),
    );
    expect(entry.keys).toEqual(['a', 'b', 'c']);
    expect(entry.secondaryKeys).toEqual(['x', 'y']);
    expect(entry.selectiveLogic).toBe(2);
    expect(entry.selective).toBe(true);
  });

  it('条目已有副键时不动 exclude_keys（避免覆盖原有逻辑）', () => {
    const entry = applyDecorators(
      makeEntry({ id: 'e1', secondaryKeys: ['old'], content: '@@exclude_keys x\nbody' }),
    );
    expect(entry.secondaryKeys).toEqual(['old']);
    expect(entry.decorators?.['exclude_keys']).toEqual(['x']);
  });

  it('@@constant / @@disable / @@activate_only_after 映射到字段', () => {
    const entry = applyDecorators(
      makeEntry({ id: 'e1', content: '@@constant\n@@disable\n@@activate_only_after 3\nbody' }),
    );
    expect(entry).toMatchObject({ constant: true, disabled: true, delay: 3 });
  });

  it('@@keep_activate_after_match / @@dont_activate_after_match 映射为永久时间态', () => {
    const keep = applyDecorators(
      makeEntry({ id: 'e1', content: '@@keep_activate_after_match\nx' }),
    );
    const dont = applyDecorators(
      makeEntry({ id: 'e2', content: '@@dont_activate_after_match\nx' }),
    );
    expect(keep.sticky).toBe(Number.MAX_SAFE_INTEGER);
    expect(dont.cooldown).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('已解析过的条目重复调用是幂等的', () => {
    const once = applyDecorators(makeEntry({ id: 'e1', content: '@@depth 3\nbody' }));
    expect(applyDecorators(once)).toEqual(once);
  });
});

describe('装饰器参与激活判定', () => {
  it('@@activate 无条件激活，@@dont_activate 无条件压制', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'on', content: '@@activate\nalways here', order: 200 }),
        makeEntry({ id: 'off', constant: true, content: '@@dont_activate\nnever', order: 100 }),
      ]),
    ];
    const result = runScan({ books });
    expect(activatedIds(result)).toEqual(['on']);
    expect(result.activations[0]?.content).toBe('always here');
    expect(rejectionOf(result, 'off')).toEqual(['dont-activate']);
  });

  it('扫描时装饰器已生效：@@scan_depth 限制扫描范围', () => {
    const books = [
      makeBook([makeEntry({ id: 'e1', keys: ['apple'], content: '@@scan_depth 1\nx' })]),
    ];
    const history = [userMessage('apple'), userMessage('hello')];
    expect(activatedIds(runScan({ books, history }))).toEqual([]);
  });

  it('未实现的装饰器只产生警告', () => {
    const books = [
      makeBook([makeEntry({ id: 'e1', constant: true, content: '@@ignore_on_max_context\nx' })]),
    ];
    const result = runScan({ books });
    expect(activatedIds(result)).toEqual(['e1']);
    expect(result.warnings).toEqual(['条目 e1 的装饰器 @@ignore_on_max_context 未实现，已忽略']);
  });

  it('@@is_greeting 的条目是开场白，不注入世界书', () => {
    const books = [
      makeBook([makeEntry({ id: 'e1', constant: true, content: '@@is_greeting 1\nx' })]),
    ];
    const result = runScan({ books });
    expect(activatedIds(result)).toEqual([]);
    expect(rejectionOf(result, 'e1')).toEqual(['greeting']);
    expect(result.warnings).toEqual([]);
  });
});
