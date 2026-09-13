import type { Part, PromptIR, Role, Segment } from '@newtavern/core';
import { describe, expect, it } from 'vitest';

import { irToChatMessages, mergeAdjacentSameRole, partsToText } from './messages.js';

function seg(
  id: string,
  role: Role,
  text: string,
  slot: 'system' | 'history' = 'system',
  order = 0,
): Segment {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    origin: { kind: slot === 'system' ? 'preset' : 'history' },
    anchor: { slot, order },
    stability: slot === 'system' ? 'static' : 'history',
  };
}

function ir(segments: Segment[], breakpoints: number[] = []): PromptIR {
  return {
    model: 'test',
    sampling: {},
    segments,
    cachePlan: { breakpoints },
    meta: {
      chatId: 'c1',
      presetId: 'p1',
      layoutMode: 'strict',
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
