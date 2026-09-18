import { describe, expect, it } from 'vitest';

import { formatYaml } from './helper-variables.js';
import { substituteMacros } from './engine.js';

/** MVU 卡的提示词就靠这两类宏把当前变量喂给模型（M5 契约 §3） */
const tables = {
  message: {
    stat_data: {
      $meta: { strictSet: true },
      时间: '光历3960年·3月·21日',
      三月七: { 好感度: [30, '[0,100]对 user 的好感度'] },
    },
    $internal: { display_data: {} },
  },
  global: { 计数: 3 },
};

describe('酒馆助手变量宏', () => {
  it('get_message_variable 取子树并 JSON 化，$ 键不进提示词', () => {
    const out = substituteMacros('{{get_message_variable::stat_data}}', { helperVariables: tables });
    expect(out).toBe('{"时间":"光历3960年·3月·21日","三月七":{"好感度":[30,"[0,100]对 user 的好感度"]}}');
  });

  it('get_ 取标量时原样输出（不带引号）', () => {
    expect(
      substituteMacros('{{get_message_variable::stat_data.时间}}', { helperVariables: tables }),
    ).toBe('光历3960年·3月·21日');
    expect(
      substituteMacros('{{get_message_variable::stat_data.三月七.好感度[0]}}', {
        helperVariables: tables,
      }),
    ).toBe('30');
    expect(substituteMacros('{{get_global_variable::计数}}', { helperVariables: tables })).toBe('3');
  });

  it('路径不存在 / 表不存在 → 空串', () => {
    expect(substituteMacros('[{{get_message_variable::没有这个}}]', { helperVariables: tables })).toBe('[]');
    expect(substituteMacros('[{{get_chat_variable::a}}]', { helperVariables: tables })).toBe('[]');
  });

  it('没配 helperVariables 时宏原样保留（当普通文本，不吞提示词）', () => {
    expect(substituteMacros('{{get_message_variable::stat_data}}')).toBe(
      '{{get_message_variable::stat_data}}',
    );
  });

  it('format_ 输出 YAML，并按宏前面的缩进对齐续行', () => {
    const out = substituteMacros('  当前：{{format_message_variable::stat_data.三月七}}', {
      helperVariables: tables,
    });
    // 续行缩进 = 宏前缀长度（5 个 UTF-16 码元）+ YAML 自己的 2 空格，与酒馆助手一致
    expect(out).toBe('  当前：好感度:\n       - 30\n       - "[0,100]对 user 的好感度"');
  });

  it('同一行里两个 format_ 宏都展开', () => {
    const out = substituteMacros(
      'a={{format_global_variable::计数}} b={{format_global_variable::计数}}',
      { helperVariables: tables },
    );
    expect(out).toBe('a=3 b=3');
  });
});

describe('formatYaml', () => {
  it('嵌套对象、数组与需要引号的标量', () => {
    expect(formatYaml({ a: 1, b: { c: 'x y' }, d: [1, 'true'], e: {}, f: null })).toBe(
      'a: 1\nb:\n  c: x y\nd:\n  - 1\n  - "true"\ne: {}\nf: null',
    );
  });

  it('对象数组', () => {
    expect(formatYaml([{ a: 1 }, { b: 2 }])).toBe('- a: 1\n- b: 2');
  });
});
