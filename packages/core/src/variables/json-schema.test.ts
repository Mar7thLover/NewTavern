import { describe, expect, it } from 'vitest';

import { validateJsonSchema } from './json-schema.js';

/** zod 4 `z.toJSONSchema(z.object({ stat_data: z.object({ 好感度: z.number().min(0).max(100) }) }))` 的形状 */
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    stat_data: {
      type: 'object',
      properties: {
        好感度: { type: 'number', minimum: 0, maximum: 100 },
        心情: { type: 'string', enum: ['开心', '难过'] },
        物品: { type: 'array', items: { type: 'string' } },
      },
      required: ['好感度'],
      additionalProperties: false,
    },
  },
  required: ['stat_data'],
};

describe('validateJsonSchema', () => {
  it('合法值没有问题', () => {
    expect(
      validateJsonSchema({ stat_data: { 好感度: 50, 心情: '开心', 物品: ['伞'] } }, SCHEMA),
    ).toEqual([]);
  });

  it('类型、范围、枚举、必填、多余键', () => {
    const issues = validateJsonSchema(
      { stat_data: { 好感度: 120, 心情: '生气', 物品: [1], 多余: true } },
      SCHEMA,
    );
    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain('stat_data.好感度');
    expect(paths).toContain('stat_data.心情');
    expect(paths).toContain('stat_data.物品[0]');
    expect(paths).toContain('stat_data.多余');
    expect(validateJsonSchema({ stat_data: {} }, SCHEMA)[0]?.path).toBe('stat_data.好感度');
  });

  it('MVU 的 [值, 说明] 二元组按值校验；$ 开头的簿记键不算多余', () => {
    expect(
      validateJsonSchema({ stat_data: { 好感度: [30, '说明'], $meta: { strictSet: true } } }, SCHEMA),
    ).toEqual([]);
    expect(validateJsonSchema({ stat_data: { 好感度: [300, '说明'] } }, SCHEMA)[0]?.path).toBe(
      'stat_data.好感度[0]',
    );
  });

  it('anyOf / $ref', () => {
    const schema = {
      $defs: { level: { type: 'integer', minimum: 1 } },
      type: 'object',
      properties: {
        等级: { $ref: '#/$defs/level' },
        备注: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
    };
    expect(validateJsonSchema({ 等级: 2, 备注: null }, schema)).toEqual([]);
    expect(validateJsonSchema({ 等级: 0, 备注: 3 }, schema).map((issue) => issue.path)).toEqual([
      '等级',
      '备注',
    ]);
  });
});
