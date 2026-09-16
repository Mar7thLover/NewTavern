import type { Part, PromptIR, Role, Segment } from '@newtavern/core';
import { describe, expect, it } from 'vitest';

import { irToChatMessages, mergeAdjacentSameRole, partsToText } from './messages.js';

function seg(
  id: string,
  role: Role,
  text: string,
  slot: 'system' | 'history' = 'system',
  order = 0,
  name?: string,
): Segment {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    ...(name === undefined ? {} : { name }),
    origin: { kind: slot === 'system' ? 'preset' : 'history' },
    anchor: { slot, order },
    stability: slot === 'system' ? 'static' : 'history',
  };
}

/** 默认 cache-aware：`mergeSameRole` 的缺省值取决于 `meta.layoutMode`（契约 §9 AS-8） */
function ir(
  segments: Segment[],
  breakpoints: number[] = [],
  layoutMode: 'strict' | 'cache-aware' = 'cache-aware',
): PromptIR {
  return {
    model: 'test',
    sampling: {},
    segments,
    cachePlan: { breakpoints },
    meta: {
      chatId: 'c1',
      presetId: 'p1',
      layoutMode,
      activations: [],
      warnings: [],
      tokenEstimate: 0,
    },
  };
}

describe('irToChatMessages', () => {
  it('默认 inline：system 段留在 messages 并合并相邻同角色', () => {
    const { systemBlocks, messages } = irToChatMessages(
      ir([
        seg('s1', 'system', 'A'),
        seg('s2', 'system', 'B'),
        seg('h1', 'user', '你好', 'history'),
      ]),
    );
    expect(systemBlocks).toEqual([]);
    expect(messages).toEqual([
      { role: 'system', parts: [{ type: 'text', text: 'A\n\nB' }], segmentIds: ['s1', 's2'] },
      { role: 'user', parts: [{ type: 'text', text: '你好' }], segmentIds: ['h1'] },
    ]);
  });

  it("systemPlacement='top' 抽出开头连续的 system 段", () => {
    const { systemBlocks, messages } = irToChatMessages(
      ir([
        seg('s1', 'system', 'A'),
        seg('s2', 'system', 'B'),
        seg('h1', 'user', 'hi', 'history'),
        seg('inj', 'system', '深度注入', 'history'),
      ]),
      { systemPlacement: 'top' },
    );
    expect(systemBlocks.map((b) => b.segmentIds)).toEqual([['s1'], ['s2']]);
    expect(messages.map((m) => m.role)).toEqual(['user', 'system']);
  });

  it('mergeSameRole=false 时不合并', () => {
    const { messages } = irToChatMessages(
      ir([seg('s1', 'system', 'A'), seg('s2', 'system', 'B')]),
      {
        mergeSameRole: false,
      },
    );
    expect(messages).toHaveLength(2);
  });

  it('joiner 可配', () => {
    const { messages } = irToChatMessages(
      ir([seg('s1', 'system', 'A'), seg('s2', 'system', 'B')]),
      {
        joiner: '\n',
      },
    );
    expect(partsToText(messages[0]!.parts)).toBe('A\nB');
  });

  it('ensureLastUser 在末尾不是 user 时追加', () => {
    const { messages } = irToChatMessages(
      ir([seg('h1', 'user', 'hi', 'history'), seg('h2', 'assistant', 'yo', 'history')]),
      { ensureLastUser: true, lastUserFallback: '[Go]' },
    );
    expect(messages[messages.length - 1]).toEqual({
      role: 'user',
      parts: [{ type: 'text', text: '[Go]' }],
      segmentIds: [],
    });
  });

  it('ensureLastUser 末尾已是 user 时不追加', () => {
    const { messages } = irToChatMessages(ir([seg('h1', 'user', 'hi', 'history')]), {
      ensureLastUser: true,
    });
    expect(messages).toHaveLength(1);
  });

  it('断点下标映射到合并后的消息', () => {
    // 断点在 s2（合并进第 0 条）与 h2（第 2 条）
    const { messages } = irToChatMessages(
      ir(
        [
          seg('s1', 'system', 'A'),
          seg('s2', 'system', 'B'),
          seg('h1', 'user', 'u1', 'history'),
          seg('h2', 'assistant', 'a1', 'history'),
        ],
        [1, 3],
      ),
    );
    expect(messages.map((m) => m.cacheBreakpoint ?? false)).toEqual([true, false, true]);
  });

  it("断点落在 'top' 抽出的 system 段上", () => {
    const { systemBlocks, messages } = irToChatMessages(
      ir([seg('s1', 'system', 'A'), seg('h1', 'user', 'u', 'history')], [0]),
      { systemPlacement: 'top' },
    );
    expect(systemBlocks[0]?.cacheBreakpoint).toBe(true);
    expect(messages[0]?.cacheBreakpoint).toBeUndefined();
  });

  it("layoutMode='strict' 时默认不合并（ST 从不合并相邻同角色）", () => {
    const segments = [seg('s1', 'system', 'A'), seg('s2', 'system', 'B')];
    expect(irToChatMessages(ir(segments, [], 'strict')).messages).toHaveLength(2);
    // 显式 true 仍然可以合并
    expect(
      irToChatMessages(ir(segments, [], 'strict'), { mergeSameRole: true }).messages,
    ).toHaveLength(1);
    // cache-aware 默认合并
    expect(irToChatMessages(ir(segments)).messages).toHaveLength(1);
  });

  it("nameStrategy 默认 'field'：name 带到消息上，且带 name 的段不与他人合并", () => {
    const { messages } = irToChatMessages(
      ir([
        seg('e1', 'system', 'hi', 'system', 0, 'example_user'),
        seg('e2', 'system', 'yo', 'system', 0, 'example_assistant'),
        seg('e3', 'system', 'ho', 'system', 0, 'example_assistant'),
        seg('s1', 'system', 'plain'),
      ]),
    );
    expect(messages.map((m) => [m.role, m.name, partsToText(m.parts)])).toEqual([
      ['system', 'example_user', 'hi'],
      // 同 name 同角色仍然合并
      ['system', 'example_assistant', 'yo\n\nho'],
      ['system', undefined, 'plain'],
    ]);
  });

  it("nameStrategy 'prefix' 把名字写进正文、'none' 丢弃", () => {
    const segments = [
      seg('h1', 'user', '你好', 'history', 0, '旅人'),
      seg('h2', 'assistant', '欢迎', 'history', 0, '艾拉'),
    ];
    const prefixed = irToChatMessages(ir(segments), { nameStrategy: 'prefix' }).messages;
    expect(prefixed.map((m) => [m.name, partsToText(m.parts)])).toEqual([
      [undefined, '旅人: 你好'],
      [undefined, '艾拉: 欢迎'],
    ]);
    const dropped = irToChatMessages(ir(segments), { nameStrategy: 'none' }).messages;
    expect(dropped.map((m) => [m.name, partsToText(m.parts)])).toEqual([
      [undefined, '你好'],
      [undefined, '欢迎'],
    ]);
  });

  it("'prefix' 下同角色相邻段照常合并", () => {
    const { messages } = irToChatMessages(
      ir([
        seg('h1', 'user', 'a', 'history', 0, '旅人'),
        seg('h2', 'user', 'b', 'history', 0, '旅人'),
      ]),
      { nameStrategy: 'prefix' },
    );
    expect(messages).toHaveLength(1);
    expect(partsToText(messages[0]!.parts)).toBe('旅人: a\n\n旅人: b');
  });

  it("systemPlacement='top' 的 system 块没有 name 字段，'field' 退化为前缀", () => {
    const { systemBlocks } = irToChatMessages(
      ir([seg('e1', 'system', 'hi', 'system', 0, 'example_user')]),
      { systemPlacement: 'top' },
    );
    expect(partsToText(systemBlocks[0]!.parts)).toBe('example_user: hi');
  });

  it('非文本 part 不会被 joiner 粘连', () => {
    const imgSeg: Segment = {
      ...seg('h1', 'user', 'text', 'history'),
      parts: [
        { type: 'text', text: 'before' },
        { type: 'image', assetId: 'a1', mime: 'image/png' },
      ] as Part[],
    };
    const { messages } = irToChatMessages(ir([imgSeg, seg('h2', 'user', 'after', 'history')]));
    expect(messages[0]?.parts).toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', assetId: 'a1', mime: 'image/png' },
      { type: 'text', text: 'after' },
    ]);
  });
});

describe('mergeAdjacentSameRole', () => {
  it('OR 合并 cacheBreakpoint', () => {
    const merged = mergeAdjacentSameRole([
      { role: 'user', parts: [{ type: 'text', text: 'a' }], segmentIds: ['1'] },
      {
        role: 'user',
        parts: [{ type: 'text', text: 'b' }],
        segmentIds: ['2'],
        cacheBreakpoint: true,
      },
    ]);
    expect(merged).toEqual([
      {
        role: 'user',
        parts: [{ type: 'text', text: 'a\n\nb' }],
        segmentIds: ['1', '2'],
        cacheBreakpoint: true,
      },
    ]);
  });
});

// ───────────── squash_system_messages（ST ChatCompletion.squashSystemMessages） ─────────────

describe('irToChatMessages squash_system_messages', () => {
  /** strict + meta 开关：只看 squash，不叠加同角色合并 */
  const squashed = (segments: Segment[], breakpoints: number[] = []) => {
    const base = ir(segments, breakpoints, 'strict');
    return irToChatMessages({ ...base, meta: { ...base.meta, squashSystemMessages: true } })
      .messages;
  };

  it('相邻 system 段用 \n 连成一条、segmentIds 累加；user 段与带 name 的段打断', () => {
    const messages = squashed([
      seg('s1', 'system', 'A'),
      seg('s2', 'system', 'B'),
      seg('ex', 'system', 'Example', 'system', 0, 'example_user'),
      seg('s3', 'system', 'C'),
      seg('h1', 'user', 'hi', 'history'),
      seg('i1', 'system', '注入 1', 'history'),
      seg('i2', 'system', '注入 2', 'history'),
    ]);
    expect(messages).toEqual([
      { role: 'system', parts: [{ type: 'text', text: 'A\nB' }], segmentIds: ['s1', 's2'] },
      {
        role: 'system',
        name: 'example_user',
        parts: [{ type: 'text', text: 'Example' }],
        segmentIds: ['ex'],
      },
      { role: 'system', parts: [{ type: 'text', text: 'C' }], segmentIds: ['s3'] },
      { role: 'user', parts: [{ type: 'text', text: 'hi' }], segmentIds: ['h1'] },
      {
        role: 'system',
        parts: [{ type: 'text', text: '注入 1\n注入 2' }],
        segmentIds: ['i1', 'i2'],
      },
    ]);
  });

  it('分隔段（new_chat_prompt / new_example_chat_prompt）不参与合并', () => {
    const separator: Segment = {
      ...seg('sep', 'system', '[Start a new Chat]'),
      origin: { kind: 'preset', ref: 'new_chat_prompt' },
    };
    const messages = squashed([seg('s1', 'system', 'A'), separator, seg('s2', 'system', 'B')]);
    expect(messages.map((m) => partsToText(m.parts))).toEqual(['A', '[Start a new Chat]', 'B']);
  });

  it('带非文本 part 的段不合并', () => {
    const withImage: Segment = {
      ...seg('img', 'system', '看图'),
      parts: [
        { type: 'text', text: '看图' },
        { type: 'image', assetId: 'a1', mime: 'image/png' },
      ],
    };
    const messages = squashed([seg('s1', 'system', 'A'), withImage, seg('s2', 'system', 'B')]);
    expect(messages.map((m) => m.segmentIds)).toEqual([['s1'], ['img'], ['s2']]);
  });

  it('不跨缓存断点合并：断点所在消息是前缀边界', () => {
    const messages = squashed(
      [seg('s1', 'system', 'A'), seg('s2', 'system', 'B'), seg('s3', 'system', 'C')],
      [1],
    );
    expect(messages.map((m) => partsToText(m.parts))).toEqual(['A\nB', 'C']);
    expect(messages[0]?.cacheBreakpoint).toBe(true);
    expect(messages[1]?.cacheBreakpoint).toBeUndefined();
  });

  it('meta 没开时不合并（strict 也不做同角色合并）', () => {
    const { messages } = irToChatMessages(
      ir([seg('s1', 'system', 'A'), seg('s2', 'system', 'B')], [], 'strict'),
    );
    expect(messages).toHaveLength(2);
  });

  it("systemPlacement='top'：抽走的顶层 system 块不受影响，正文里的仍然合并", () => {
    const base = ir(
      [
        seg('s1', 'system', 'A'),
        seg('h1', 'user', 'hi', 'history'),
        seg('i1', 'system', '注入 1', 'history'),
        seg('i2', 'system', '注入 2', 'history'),
      ],
      [],
      'strict',
    );
    const { systemBlocks, messages } = irToChatMessages(
      { ...base, meta: { ...base.meta, squashSystemMessages: true } },
      { systemPlacement: 'top' },
    );
    expect(systemBlocks.map((b) => b.segmentIds)).toEqual([['s1']]);
    expect(messages.map((m) => m.segmentIds)).toEqual([['h1'], ['i1', 'i2']]);
  });
});
