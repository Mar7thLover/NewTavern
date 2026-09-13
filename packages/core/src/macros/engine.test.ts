import { describe, expect, it } from 'vitest';

import { substituteMacros, substituteMacrosDetailed, type MacroContext } from './engine.js';

const ctx: MacroContext = {
  char: 'Seraphine',
  user: 'Ren',
  persona: 'Ren is a tired detective.',
  description: 'A woman of few words.',
  personality: 'stoic',
  scenario: 'A rainy rooftop.',
  mesExamples: 'Ren: Hi\nSeraphine: ...',
  now: new Date(2026, 8, 13, 20, 5, 0),
};

describe('substituteMacros 环境宏', () => {
  it('逐个替换 M2 支持的环境宏', () => {
    expect(substituteMacros('{{char}}', ctx)).toBe('Seraphine');
    expect(substituteMacros('{{user}}', ctx)).toBe('Ren');
    expect(substituteMacros('{{persona}}', ctx)).toBe('Ren is a tired detective.');
    expect(substituteMacros('{{description}}', ctx)).toBe('A woman of few words.');
    expect(substituteMacros('{{personality}}', ctx)).toBe('stoic');
    expect(substituteMacros('{{scenario}}', ctx)).toBe('A rainy rooftop.');
    expect(substituteMacros('{{mesExamples}}', ctx)).toBe('Ren: Hi\nSeraphine: ...');
  });

  it('大小写不敏感', () => {
    expect(substituteMacros('{{CHAR}}|{{MesExamples}}|{{NoOp}}x', ctx)).toBe(
      'Seraphine|Ren: Hi\nSeraphine: ...|x',
    );
  });

  it('未提供的环境宏替换为空串', () => {
    expect(substituteMacros('[{{scenario}}]', { char: 'A', user: 'B' })).toBe('[]');
  });

  it('{{original}} 仅在 ctx 提供时替换，否则原样保留', () => {
    expect(substituteMacros('前 {{original}} 后', ctx)).toBe('前 {{original}} 后');
    expect(substituteMacros('前 {{original}} 后', { ...ctx, original: '旧内容' })).toBe(
      '前 旧内容 后',
    );
  });

  it('{{original}} 先于其他环境宏展开，且只展开第一次出现', () => {
    expect(
      substituteMacros('{{original}}|{{original}}', { char: 'C', original: '{{char}} 说' }),
    ).toBe('C 说|');
  });

  it('未知宏原样保留', () => {
    expect(substituteMacros('{{getvar::hp}} {{roll:d20}} {{char}}', ctx)).toBe(
      '{{getvar::hp}} {{roll:d20}} Seraphine',
    );
  });

  it('内部有空白的宏不被识别（与 ST 正则一致）', () => {
    expect(substituteMacros('{{ char }}', ctx)).toBe('{{ char }}');
  });
});

describe('substituteMacros 内建宏', () => {
  it('{{newline}} 变换行，{{noop}} 删除', () => {
    expect(substituteMacros('a{{newline}}b{{noop}}c', ctx)).toBe('a\nbc');
  });

  it('{{trim}} 连同两侧换行一起删除（ST 语义：只吃换行不吃空格）', () => {
    expect(substituteMacros('a\n\n{{trim}}\n\nb', ctx)).toBe('ab');
    expect(substituteMacros('a \n{{trim}}\n b', ctx)).toBe('a  b');
  });

  it('{{// ...}} 注释被删除（可跨行）', () => {
    expect(substituteMacros('前{{// 这是\n注释}}后', ctx)).toBe('前后');
  });

  it('{{time}} / {{date}} 用 ctx.now', () => {
    expect(substituteMacros('{{time}}', ctx)).toBe('8:05 PM');
    expect(substituteMacros('{{date}}', ctx)).toBe('September 13, 2026');
    expect(substituteMacros('{{TIME}}', { now: new Date(2026, 0, 1, 0, 30) })).toBe('12:30 AM');
    expect(substituteMacros('{{time}}', { now: new Date(2026, 0, 1, 12, 0) })).toBe('12:00 PM');
  });
});

describe('substituteMacrosDetailed volatile', () => {
  it('含 time/date 标记 volatile', () => {
    expect(substituteMacrosDetailed('现在 {{time}}', ctx).volatile).toBe(true);
    expect(substituteMacrosDetailed('今天 {{DATE}}', ctx).volatile).toBe(true);
  });

  it('不含易变宏时 volatile 为 false', () => {
    expect(substituteMacrosDetailed('{{char}} 与 {{user}}', ctx).volatile).toBe(false);
    expect(substituteMacrosDetailed('', ctx)).toEqual({ text: '', volatile: false });
  });
});
