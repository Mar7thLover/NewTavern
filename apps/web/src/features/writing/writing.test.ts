import { getSchema } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AutosaveScheduler, type AutosaveStatus } from './autosave';
import { writingProjectIdOf } from './commands';
import { computeDiff } from './diff';
import { writingExtensions } from './editor/extensions';
import {
  aiPendingPlugin,
  appendPending,
  cursorContext,
  docText,
  finishPending,
  getAiState,
  insertionPos,
  keepPending,
  pendingText,
  replaceTarget,
  setTarget,
  startPending,
  textToDocJson,
  undoPending,
} from './editor/pending';

/**
 * 写作页的关键逻辑（M7 §5.3）：AI 待定区的插入 / 保留 / 撤销、目标区替换、字符级对照、自动保存调度。
 * 编辑器逻辑全部是 ProseMirror 纯状态函数，直接对 EditorState 跑，不需要 DOM。
 */

const schema = getSchema(writingExtensions());

function stateOf(paragraphs: string[], cursor?: number): EditorState {
  const doc = schema.nodeFromJSON(textToDocJson(paragraphs.join('\n')));
  const state = EditorState.create({ schema, doc, plugins: [aiPendingPlugin()] });
  if (cursor === undefined) return state;
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursor)));
}

/** 纯文本位置 → 文档位置（只对单段落有效：段落内容从 1 开始） */
const inFirst = (offset: number) => 1 + offset;

function stream(state: EditorState, deltas: string[]): EditorState {
  let next = state;
  for (const delta of deltas) {
    const tr = appendPending(next, delta);
    if (tr) next = next.apply(tr);
  }
  return next;
}

describe('AI 待定区', () => {
  it('流式插入到光标处，区间随插入向右长，结束后保留只去标记', () => {
    let state = stateOf(['他推开门。雨还在下。'], inFirst(5));
    state = state.apply(startPending(state, insertionPos(state)));
    state = stream(state, ['屋里', '没有灯', '。']);
    expect(docText(state.doc)).toBe('他推开门。屋里没有灯。雨还在下。');
    expect(pendingText(state)).toBe('屋里没有灯。');
    expect(getAiState(state).pending?.streaming).toBe(true);

    state = state.apply(finishPending(state));
    expect(getAiState(state).pending?.streaming).toBe(false);

    state = state.apply(keepPending(state));
    expect(getAiState(state).pending).toBeNull();
    expect(docText(state.doc)).toBe('他推开门。屋里没有灯。雨还在下。');
  });

  it('换行拆段：连续换行只拆一次，结尾换行不留空段；撤销把拆出的段一起合回去', () => {
    const original = ['第一段。'];
    let state = stateOf(original, inFirst(4));
    state = state.apply(startPending(state, insertionPos(state)));
    state = stream(state, ['接着写', '\n', '\n第二段', '开头。\n\n']);
    expect(docText(state.doc)).toBe('第一段。接着写\n\n第二段开头。');
    expect(state.doc.childCount).toBe(2);
    expect(pendingText(state)).toBe('接着写\n\n第二段开头。');

    state = state.apply(finishPending(state));
    state = state.apply(undoPending(state));
    expect(getAiState(state).pending).toBeNull();
    expect(docText(state.doc)).toBe('第一段。');
    expect(state.doc.childCount).toBe(1);
  });

  it('光标还停在全文开头（没点进正文）时，续写接在全文末尾', () => {
    const state = stateOf(['第一段。', '第二段。'], inFirst(0));
    expect(insertionPos(state)).toBe(state.doc.content.size - 1);
    const moved = state.apply(state.tr.setSelection(TextSelection.create(state.doc, inFirst(2))));
    expect(insertionPos(moved)).toBe(inFirst(2));
  });

  it('光标在空段落开头时，开头的换行不再拆出空段', () => {
    let state = stateOf([]);
    state = state.apply(startPending(state, insertionPos(state)));
    state = stream(state, ['\n\n', '夜色。']);
    expect(state.doc.childCount).toBe(1);
    expect(docText(state.doc)).toBe('夜色。');
  });

  it('结束后在待定区两端打字不算 AI 的；一个字也没写就直接收掉', () => {
    let state = stateOf(['甲乙'], inFirst(1));
    state = state.apply(startPending(state, insertionPos(state)));
    state = stream(state, ['AI']);
    state = state.apply(finishPending(state));
    const pending = getAiState(state).pending;
    expect(pending).not.toBeNull();
    // 紧贴末尾打一个字
    state = state.apply(state.tr.insertText('x', pending?.to ?? 0));
    expect(pendingText(state)).toBe('AI');
    state = state.apply(undoPending(state));
    expect(docText(state.doc)).toBe('甲x乙');

    let empty = stateOf(['甲'], inFirst(1));
    empty = empty.apply(startPending(empty, insertionPos(empty)));
    empty = empty.apply(finishPending(empty));
    expect(getAiState(empty).pending).toBeNull();
  });

  it('等待决定时在别处编辑，待定区跟着映射', () => {
    let state = stateOf(['ABC'], inFirst(3));
    state = state.apply(startPending(state, insertionPos(state)));
    state = stream(state, ['DE']);
    state = state.apply(finishPending(state));
    state = state.apply(state.tr.insertText('前', inFirst(0)));
    expect(pendingText(state)).toBe('DE');
    state = state.apply(undoPending(state));
    expect(docText(state.doc)).toBe('前ABC');
  });
});

describe('目标区替换', () => {
  it('选区原文、前后文按纯文本偏移切；替换多段文本是一个事务', () => {
    let state = stateOf(['一二三四五', '六七八'], inFirst(1));
    state = state.apply(
      state.tr.setSelection(TextSelection.create(state.doc, inFirst(1), inFirst(4))),
    );
    const ctx = cursorContext(state);
    expect(ctx.textBefore).toBe('一');
    expect(ctx.selectionText).toBe('二三四');
    expect(ctx.textAfter).toBe('五\n\n六七八');
    expect(ctx.textBefore + ctx.selectionText + ctx.textAfter).toBe(docText(state.doc));

    state = state.apply(setTarget(state, ctx.from, ctx.to));
    // 等待期间在前面插字：目标区跟着移
    state = state.apply(state.tr.insertText('〇', inFirst(0)));
    const tr = replaceTarget(state, '甲\n乙');
    expect(tr).not.toBeNull();
    if (tr) state = state.apply(tr);
    expect(docText(state.doc)).toBe('〇一甲\n\n乙五\n\n六七八');
    expect(getAiState(state).target).toBeNull();
  });
});

describe('对照', () => {
  it('字符级 diff，合并相邻同类片段并计数', () => {
    const result = computeDiff('他慢慢走过去', '他快步走了过去');
    expect(result.mode).toBe('chars');
    expect(result.parts.map((part) => part.text).join('')).toContain('他');
    const rebuiltAfter = result.parts
      .filter((part) => part.kind !== 'removed')
      .map((part) => part.text)
      .join('');
    const rebuiltBefore = result.parts
      .filter((part) => part.kind !== 'added')
      .map((part) => part.text)
      .join('');
    expect(rebuiltAfter).toBe('他快步走了过去');
    expect(rebuiltBefore).toBe('他慢慢走过去');
    expect(result.added).toBeGreaterThan(0);
    expect(result.removed).toBeGreaterThan(0);
  });

  it('大文本退化为按词对照', () => {
    const before = 'word '.repeat(40);
    const after = `${'word '.repeat(20)}changed ${'word '.repeat(19)}`;
    const result = computeDiff(before, after, 100);
    expect(result.mode).toBe('words');
    expect(
      result.parts.some((part) => part.kind === 'added' && part.text.includes('changed')),
    ).toBe(true);
  });

  it('改动之间的一两个相同字并进改动，读起来不碎；两边原文仍能还原', () => {
    const before = '钟楼敲了六下，雾退开一条缝，街对面的路灯亮着。';
    const after = '钟声响起六下。雾散开一道缝隙。对面的路灯亮了。';
    const result = computeDiff(before, after);
    const side = (skip: string) =>
      result.parts
        .filter((part) => part.kind !== skip)
        .map((part) => part.text)
        .join('');
    expect(side('added')).toBe(before);
    expect(side('removed')).toBe(after);
    // 每段改动都是「先删后增」，且不会出现只有一个字的相同片段夹在两段改动之间
    result.parts.forEach((part, index) => {
      const prev = result.parts[index - 1];
      const next = result.parts[index + 1];
      if (part.kind === 'same' && prev && next && prev.kind !== 'same' && next.kind !== 'same') {
        expect(Array.from(part.text).length).toBeGreaterThan(2);
      }
    });
  });

  it('相同文本没有改动', () => {
    expect(computeDiff('同', '同')).toMatchObject({ added: 0, removed: 0 });
  });
});

describe('自动保存调度', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(save = vi.fn(() => Promise.resolve())) {
    const snapshot = vi.fn(() => Promise.resolve());
    const statuses: AutosaveStatus[] = [];
    const scheduler = new AutosaveScheduler({
      save,
      snapshot,
      onStatus: (status) => statuses.push(status),
    });
    return { scheduler, save, snapshot, statuses };
  }

  it('停止输入 1.5 秒后才保存一次', async () => {
    const { scheduler, save, statuses } = setup();
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(1000);
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['dirty', 'saving', 'saved']);
    expect(scheduler.pending).toBe(false);
    scheduler.dispose();
  });

  it('flush 立即保存；没改动时不发请求', async () => {
    const { scheduler, save } = setup();
    await scheduler.flush();
    expect(save).not.toHaveBeenCalled();
    scheduler.markDirty();
    await scheduler.flush();
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('保存途中又有改动：结束后接着再存', async () => {
    let release: () => void = () => undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { scheduler } = setup(save);
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(1500);
    expect(save).toHaveBeenCalledTimes(1);
    scheduler.markDirty();
    const flushed = scheduler.flush();
    release();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await flushed;
    expect(save).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it('10 分钟内有改动就存一版；存过版且没新改动不再存', async () => {
    const { scheduler, save, snapshot } = setup();
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(save).toHaveBeenCalled();
    expect(snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(snapshot).toHaveBeenCalledTimes(1);
    // 手动存版后重新计时
    scheduler.markDirty();
    scheduler.noteVersioned();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(snapshot).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('保存失败保持脏并在稍后重试', async () => {
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const { scheduler, statuses } = setup(save);
    scheduler.markDirty();
    await vi.advanceTimersByTimeAsync(1500);
    expect(statuses.at(-1)).toBe('error');
    expect(scheduler.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(statuses.at(-1)).toBe('saved');
    scheduler.dispose();
  });
});

describe('命令面板', () => {
  it('只在项目页取出 projectId', () => {
    expect(writingProjectIdOf('/writing/abc')).toBe('abc');
    expect(writingProjectIdOf('/writing')).toBeNull();
    expect(writingProjectIdOf('/writing/abc/x')).toBeNull();
  });
});
