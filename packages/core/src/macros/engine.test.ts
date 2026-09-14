import { describe, expect, it } from 'vitest';

import { VariableTransaction } from '../variables/transaction.js';
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

/** 固定随机源：永远取列表中点 / 骰子中值 */
const halfRng = () => 0.5;

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

  it('{{user}} / {{char}} 排在卡字段之后，能在插回的内容里继续展开（ST 顺序）', () => {
    expect(
      substituteMacros('{{description}}', { char: 'Seraphine', description: '{{char}} 很安静' }),
    ).toBe('Seraphine 很安静');
  });

  it('未知宏原样保留', () => {
    expect(substituteMacros('{{nosuchmacro}} {{char}}', ctx)).toBe('{{nosuchmacro}} Seraphine');
  });

  it('内部有空白的宏不被识别（与 ST 正则一致）', () => {
    expect(substituteMacros('{{ char }}', ctx)).toBe('{{ char }}');
  });

  it('M3 新增的 env 宏', () => {
    const full: MacroContext = {
      ...ctx,
      model: 'opus-5',
      group: 'Seraphine, Mira',
      charVersion: '2.1',
      charPrompt: '系统提示',
      charJailbreak: '越狱提示',
      charDepthPrompt: '深度提示',
      creatorNotes: '作者的话',
      input: '还没发出的输入',
    };
    expect(substituteMacros('{{model}}', full)).toBe('opus-5');
    expect(substituteMacros('{{group}}|{{charIfNotGroup}}|{{groupNotMuted}}', full)).toBe(
      'Seraphine, Mira|Seraphine, Mira|Seraphine, Mira',
    );
    expect(substituteMacros('{{charVersion}}|{{char_version}}', full)).toBe('2.1|2.1');
    expect(substituteMacros('{{charPrompt}}', full)).toBe('系统提示');
    expect(substituteMacros('{{charJailbreak}}|{{charInstruction}}', full)).toBe(
      '越狱提示|越狱提示',
    );
    expect(substituteMacros('{{charDepthPrompt}}', full)).toBe('深度提示');
    expect(substituteMacros('{{creatorNotes}}', full)).toBe('作者的话');
    expect(substituteMacros('{{mesExamplesRaw}}', full)).toBe('Ren: Hi\nSeraphine: ...');
    expect(substituteMacros('{{input}}', full)).toBe('还没发出的输入');
    expect(substituteMacros('{{notChar}}', full)).toBe('Ren');
  });

  it('旧式尖括号宏', () => {
    expect(substituteMacros('<USER> 对 <BOT> 说', ctx)).toBe('Ren 对 Seraphine 说');
    expect(substituteMacros('<CHAR>|<GROUP>|<CHARIFNOTGROUP>', { ...ctx, group: 'G' })).toBe(
      'Seraphine|G|G',
    );
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

  it('{{reverse:...}}', () => {
    expect(substituteMacros('{{reverse:abc}}', ctx)).toBe('cba');
  });

  it('{{banned "..."}} 直接删除', () => {
    expect(substituteMacros('前{{banned "脏话"}}后', ctx)).toBe('前后');
  });

  it('{{outlet::name}} 读 ctx.outlets，缺则空串', () => {
    const withOutlets: MacroContext = { ...ctx, outlets: { notes: '出口内容' } };
    expect(substituteMacros('[{{outlet::notes}}]', withOutlets)).toBe('[出口内容]');
    expect(substituteMacros('[{{outlet:: notes }}]', withOutlets)).toBe('[出口内容]');
    expect(substituteMacros('[{{outlet::missing}}]', withOutlets)).toBe('[]');
    expect(substituteMacros('[{{outlet::notes}}]', ctx)).toBe('[]');
  });
});

describe('substituteMacros 时间宏', () => {
  it('{{time}} / {{date}} 用 ctx.now', () => {
    expect(substituteMacros('{{time}}', ctx)).toBe('8:05 PM');
    expect(substituteMacros('{{date}}', ctx)).toBe('September 13, 2026');
    expect(substituteMacros('{{TIME}}', { now: new Date(2026, 0, 1, 0, 30) })).toBe('12:30 AM');
    expect(substituteMacros('{{time}}', { now: new Date(2026, 0, 1, 12, 0) })).toBe('12:00 PM');
  });

  it('{{weekday}} / {{isotime}} / {{isodate}}', () => {
    expect(substituteMacros('{{weekday}}', ctx)).toBe('Sunday');
    expect(substituteMacros('{{isotime}}', ctx)).toBe('20:05');
    expect(substituteMacros('{{isodate}}', ctx)).toBe('2026-09-13');
  });

  it('{{datetimeformat X}} 支持 moment 子集与 [字面量]', () => {
    expect(substituteMacros('{{datetimeformat YYYY-MM-DD HH:mm:ss}}', ctx)).toBe(
      '2026-09-13 20:05:00',
    );
    expect(substituteMacros('{{datetimeformat dddd ddd Do MMMM MMM}}', ctx)).toBe(
      'Sunday Sun 13th September Sep',
    );
    expect(substituteMacros('{{datetimeformat hh:mm a}}', ctx)).toBe('08:05 pm');
    expect(substituteMacros('{{datetimeformat [今天是] D}}', ctx)).toBe('今天是 13');
  });

  it('{{time_UTC±X}} 按小时偏移', () => {
    const utcCtx: MacroContext = { now: new Date(Date.UTC(2026, 8, 13, 12, 0)) };
    expect(substituteMacros('{{time_UTC+0}}', utcCtx)).toBe('12:00 PM');
    expect(substituteMacros('{{time_UTC+2}}', utcCtx)).toBe('2:00 PM');
    expect(substituteMacros('{{time_UTC-5}}', utcCtx)).toBe('7:00 AM');
  });

  it('timezoneOffsetMinutes 让本地时间宏可确定', () => {
    const tzCtx: MacroContext = {
      now: new Date(Date.UTC(2026, 8, 13, 12, 0)),
      timezoneOffsetMinutes: 480,
    };
    expect(substituteMacros('{{time}}|{{isodate}}|{{weekday}}', tzCtx)).toBe(
      '8:00 PM|2026-09-13|Sunday',
    );
  });

  it('{{idle_duration}} 用 idleDurationMs 做 humanize', () => {
    const idle = (ms?: number) =>
      substituteMacros('{{idle_duration}}', { ...ctx, idleDurationMs: ms });
    expect(idle(undefined)).toBe('just now');
    expect(idle(30_000)).toBe('a few seconds');
    expect(idle(60_000)).toBe('a minute');
    expect(idle(5 * 60_000)).toBe('5 minutes');
    expect(idle(3_600_000)).toBe('an hour');
    expect(idle(2 * 3_600_000)).toBe('2 hours');
    expect(idle(30 * 3_600_000)).toBe('a day');
    expect(idle(3 * 86_400_000)).toBe('3 days');
  });

  it('{{timeDiff::a::b}} 带前后缀', () => {
    expect(substituteMacros('{{timeDiff::2026-09-13T12:00:00Z::2026-09-13T10:00:00Z}}', ctx)).toBe(
      'in 2 hours',
    );
    expect(substituteMacros('{{timeDiff::2026-09-13T10:00:00Z::2026-09-13T12:00:00Z}}', ctx)).toBe(
      '2 hours ago',
    );
    expect(substituteMacros('[{{timeDiff::不是时间::也不是}}]', ctx)).toBe('[]');
  });
});

describe('substituteMacros 消息宏', () => {
  const historyCtx: MacroContext = {
    ...ctx,
    history: [
      { role: 'system', text: '开场白', id: 0 },
      { role: 'user', text: '你好', id: 1 },
      { role: 'assistant', text: '你也好', id: 2, swipeId: 1, swipeCount: 3 },
    ],
    firstIncludedMessageId: 1,
  };

  it('{{lastMessage}} / {{lastUserMessage}} / {{lastCharMessage}} / {{lastMessageId}}', () => {
    expect(substituteMacros('{{lastMessage}}', historyCtx)).toBe('你也好');
    expect(substituteMacros('{{lastUserMessage}}', historyCtx)).toBe('你好');
    expect(substituteMacros('{{lastCharMessage}}', historyCtx)).toBe('你也好');
    expect(substituteMacros('{{lastMessageId}}', historyCtx)).toBe('2');
  });

  it('{{currentSwipeId}} / {{lastSwipeId}} / {{firstIncludedMessageId}} / {{allChatRange}}', () => {
    expect(substituteMacros('{{currentSwipeId}}', historyCtx)).toBe('2');
    expect(substituteMacros('{{lastSwipeId}}', historyCtx)).toBe('3');
    expect(substituteMacros('{{firstIncludedMessageId}}', historyCtx)).toBe('1');
    expect(substituteMacros('{{allChatRange}}', historyCtx)).toBe('0-2');
  });

  it('正在 swipe 的消息被 {{lastMessage}} 跳过（ST exclude_swipe_in_propress）', () => {
    const swiping: MacroContext = {
      history: [
        { role: 'user', text: '问题', id: 0 },
        { role: 'assistant', text: '', id: 1, swipeId: 2, swipeCount: 2 },
      ],
    };
    expect(substituteMacros('{{lastMessage}}', swiping)).toBe('问题');
    // swipe 类宏不跳过
    expect(substituteMacros('{{currentSwipeId}}', swiping)).toBe('3');
  });

  it('没有历史时各消息宏为空串', () => {
    expect(substituteMacros('[{{lastMessage}}][{{lastMessageId}}][{{allChatRange}}]', ctx)).toBe(
      '[][][]',
    );
  });
});

describe('substituteMacros 随机宏', () => {
  it('{{random:a,b}} 与 {{random::a::b}} 用 ctx.rng', () => {
    const rngCtx: MacroContext = { ...ctx, rng: halfRng };
    expect(substituteMacros('{{random:a,b,c}}', rngCtx)).toBe('b');
    expect(substituteMacros('{{random::a::b}}', rngCtx)).toBe('b');
    expect(substituteMacros('{{random: a , b }}', rngCtx)).toBe('b');
    // 逗号模式下 \, 是转义逗号
    expect(substituteMacros('{{random:a\\,1,b\\,2}}', rngCtx)).toBe('b,2');
  });

  it('{{roll:XdY}} / {{roll:N}} 用 ctx.rng', () => {
    const rngCtx: MacroContext = { ...ctx, rng: halfRng };
    expect(substituteMacros('{{roll:20}}', rngCtx)).toBe('11');
    expect(substituteMacros('{{roll:d20}}', rngCtx)).toBe('11');
    expect(substituteMacros('{{roll:2d6+3}}', rngCtx)).toBe('11');
    expect(substituteMacros('{{roll 2d6}}', rngCtx)).toBe('8');
    // ST 的分隔符只吃一个字符，{{roll::2d6}} 会被判为无效公式并删掉
    expect(substituteMacros('[{{roll::2d6}}]', rngCtx)).toBe('[]');
    expect(substituteMacros('[{{roll:abc}}]', rngCtx)).toBe('[]');
  });

  it('{{pick}} 由 pickSeed + 原文 + 偏移决定，稳定且与 rng 无关', () => {
    const a = substituteMacros('{{pick:红,绿,蓝}}', { ...ctx, pickSeed: 'chat-1' });
    const b = substituteMacros('{{pick:红,绿,蓝}}', { ...ctx, pickSeed: 'chat-1' });
    const c = substituteMacros('{{pick:红,绿,蓝}}', {
      ...ctx,
      pickSeed: 'chat-1',
      rng: () => 0.99,
    });
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(['红', '绿', '蓝']).toContain(a);

    // 同一文本里的两处 pick 各自独立（偏移不同）
    const pair = substituteMacros('{{pick:1,2,3,4,5,6,7,8}}-{{pick:1,2,3,4,5,6,7,8}}', {
      pickSeed: 'chat-1',
    });
    const [left, right] = pair.split('-');
    expect(left).not.toBe(right);

    // 换会话种子后结果可能不同，但仍然是稳定的
    const other = substituteMacros('{{pick:红,绿,蓝}}', { ...ctx, pickSeed: 'chat-2' });
    expect(substituteMacros('{{pick:红,绿,蓝}}', { ...ctx, pickSeed: 'chat-2' })).toBe(other);
  });
});

describe('substituteMacros 变量宏', () => {
  it('setvar / getvar 在同一段文本里就能读到（求值顺序）', () => {
    const variables = new VariableTransaction();
    expect(substituteMacros('{{setvar::a::1}}{{getvar::a}}', { variables })).toBe('1');
    expect(variables.get('chat', 'a')).toBe('1');
  });

  it('变量宏先于 env 宏求值，所以取出的值里的 {{char}} 还会继续展开', () => {
    const variables = new VariableTransaction({ chat: { who: '{{char}}' }, global: {} });
    expect(substituteMacros('[{{getvar::who}}]', { char: 'S', variables })).toBe('[S]');
  });

  it('setvar 的值不能含 `}`（ST 正则 [^}]*，原样照搬）', () => {
    const variables = new VariableTransaction();
    expect(substituteMacros('{{setvar::who::{{char}}}}', { char: 'S', variables })).toBe('}}');
    expect(variables.get('chat', 'who')).toBe('{{char');
  });

  it('addvar 数值相加 / 字符串拼接，incvar / decvar 输出新值', () => {
    const variables = new VariableTransaction({ chat: { hp: '10', tag: 'ab' }, global: {} });
    expect(substituteMacros('[{{addvar::hp::5}}]', { variables })).toBe('[]');
    expect(variables.get('chat', 'hp')).toBe(15);
    expect(substituteMacros('{{addvar::tag::cd}}{{getvar::tag}}', { variables })).toBe('abcd');
    expect(substituteMacros('{{incvar::hp}}', { variables })).toBe('16');
    expect(substituteMacros('{{decvar::hp}}', { variables })).toBe('15');
  });

  it('global 变体写 global 作用域', () => {
    const variables = new VariableTransaction();
    expect(
      substituteMacros(
        '{{setglobalvar::g::2}}{{addglobalvar::g::3}}{{getglobalvar::g}}|{{incglobalvar::g}}|{{decglobalvar::g}}',
        { variables },
      ),
    ).toBe('5|6|5');
    expect(variables.snapshot('global')).toEqual({ g: 5 });
    expect(variables.snapshot('chat')).toEqual({});
  });

  it('变量名两侧空白被 trim', () => {
    const variables = new VariableTransaction();
    substituteMacros('{{setvar:: hp ::9}}', { variables });
    expect(variables.get('chat', 'hp')).toBe('9');
    expect(substituteMacros('{{getvar:: hp }}', { variables })).toBe('9');
  });

  it('副作用进事务：events 记录顺序，rollback 可撤销', () => {
    const variables = new VariableTransaction({ chat: { hp: '1' }, global: {} });
    substituteMacros('{{setvar::hp::2}}{{incvar::hp}}', { variables });
    expect(variables.events.map((e) => [e.op, e.key, e.newValue])).toEqual([
      ['set', 'hp', '2'],
      ['set', 'hp', 3],
    ]);
    variables.rollback();
    expect(variables.get('chat', 'hp')).toBe('1');
  });

  it('没有 store 时 get 返回空串、set 被忽略', () => {
    expect(substituteMacros('[{{getvar::a}}][{{setvar::a::1}}][{{incvar::a}}]', {})).toBe('[][][]');
  });

  it('不存在的变量读出空串', () => {
    const variables = new VariableTransaction();
    expect(substituteMacros('[{{getvar::nope}}]', { variables })).toBe('[]');
  });
});

describe('substituteMacrosDetailed volatile', () => {
  it('含 time/date 标记 volatile', () => {
    expect(substituteMacrosDetailed('现在 {{time}}', ctx).volatile).toBe(true);
    expect(substituteMacrosDetailed('今天 {{DATE}}', ctx).volatile).toBe(true);
  });

  it('M3 新增的易变宏都标记 volatile', () => {
    const volatileTexts = [
      '{{weekday}}',
      '{{isotime}}',
      '{{isodate}}',
      '{{idle_duration}}',
      '{{datetimeformat YYYY}}',
      '{{time_UTC+2}}',
      '{{lastMessage}}',
      '{{lastMessageId}}',
      '{{lastUserMessage}}',
      '{{lastCharMessage}}',
      '{{currentSwipeId}}',
      '{{random:a,b}}',
      '{{roll:d6}}',
    ];
    for (const text of volatileTexts) {
      expect(substituteMacrosDetailed(text, { ...ctx, rng: halfRng }).volatile).toBe(true);
    }
  });

  it('{{pick}} 与变量宏不算 volatile', () => {
    expect(substituteMacrosDetailed('{{pick:a,b}}', { pickSeed: 's' }).volatile).toBe(false);
    expect(
      substituteMacrosDetailed('{{getvar::a}}{{setvar::a::1}}', {
        variables: new VariableTransaction(),
      }).volatile,
    ).toBe(false);
    // {{timeDiff}} 本身是确定的（参数里的 {{time}} 会自己触发标记）
    expect(substituteMacrosDetailed('{{timeDiff::a::b}}', ctx).volatile).toBe(false);
  });

  it('不含易变宏时 volatile 为 false', () => {
    expect(substituteMacrosDetailed('{{char}} 与 {{user}}', ctx).volatile).toBe(false);
    expect(substituteMacrosDetailed('', ctx)).toEqual({ text: '', volatile: false });
  });
});

describe('postProcess 钩子', () => {
  it('只作用于宏的展开结果', () => {
    expect(
      substituteMacros('[{{char}}]', { char: 'a.b', postProcess: (v) => v.replaceAll('.', '\\.') }),
    ).toBe('[a\\.b]');
  });
});
