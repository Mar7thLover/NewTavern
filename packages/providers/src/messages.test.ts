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
