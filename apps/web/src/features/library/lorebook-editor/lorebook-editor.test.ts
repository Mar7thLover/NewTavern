import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LorebookEntry } from '../../../lib/api';
import { simulateLorebook } from './api';
import {
  addLorebookEntry,
  deleteLorebookEntry,
  isLorebookDraftDirty,
  lorebookDraftToEntries,
  lorebookDraftToRequest,
  lorebookToDraft,
  moveLorebookEntry,
  newLorebookEntry,
  patchLorebookEntry,
} from './model';

/**
 * 世界书编辑器草稿模型：服务端 ⇄ 草稿、增量 PUT（只带改动字段）、null 字段不凭空写出、
 * 保存后沿用本地 key、触发模拟请求。
 */

function row(id: string, uid: number, patch: Partial<LorebookEntry> = {}): LorebookEntry {
  return {
    id,
    uid,
    keys: ['k'],
    secondaryKeys: [],
    content: `content ${id}`,
    comment: null,
    constant: false,
    selective: true,
    selectiveLogic: 0,
    position: 0,
    depth: 4,
    entryOrder: 100,
    probability: 100,
    group: null,
    groupOverride: null,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: null,
    role: null,
    disabled: false,
    sticky: null,
    cooldown: null,
    delay: null,
    excludeRecursion: null,
    preventRecursion: null,
    delayUntilRecursion: null,
    ignoreBudget: null,
    displayIndex: uid,
    extra: { stKey: String(uid), raw: { useProbability: false, delayUntilRecursion: 3 } },
    ...patch,
  };
}

const book = { name: '书', entries: [row('a', 0), row('b', 1, { comment: '乙' })] };

describe('世界书草稿模型', () => {
  it('lorebookToDraft：raw 里的字段读出来（useProbability、递归等级）', () => {
    const draft = lorebookToDraft(book);
    expect(draft.entries[0]).toMatchObject({
      key: 'a',
      id: 'a',
      useProbability: false,
      delayUntilRecursion: 3,
      vectorized: false,
      outletName: '',
    });
  });

  it('未改动 = 只带 id；改动只带改了的字段', () => {
    const baseline = lorebookToDraft(book);
    expect(lorebookDraftToRequest(baseline, baseline)).toEqual({
      name: '书',
      entries: [{ id: 'a' }, { id: 'b' }],
    });
    const edited = patchLorebookEntry(baseline, baseline, 'b', { content: '新', keys: ['x'] });
    expect(lorebookDraftToEntries(edited, baseline)).toEqual([
      { id: 'a' },
      { id: 'b', content: '新', keys: ['x'] },
    ]);
    expect(isLorebookDraftDirty(baseline, edited)).toBe(true);
    expect(isLorebookDraftDirty(baseline, baseline)).toBe(false);
  });

  it('原文件没有的字段（null）关掉 / 清空后回到 null，不凭空写出 false / 空串', () => {
    const baseline = lorebookToDraft(book);
    const toggled = patchLorebookEntry(baseline, baseline, 'a', {
      preventRecursion: true,
      group: 'g',
    });
    const back = patchLorebookEntry(toggled, baseline, 'a', { preventRecursion: false, group: '' });
    expect(back.entries[0]!.preventRecursion).toBeNull();
    expect(back.entries[0]!.group).toBeNull();
    expect(isLorebookDraftDirty(baseline, back)).toBe(false);
  });

  it('新条目只带与 ST 模板不同的字段；排序变化算改动；删除的条目不出现', () => {
    const baseline = lorebookToDraft(book);
    let draft = addLorebookEntry(baseline, newLorebookEntry('new:1'));
    draft = patchLorebookEntry(draft, baseline, 'new:1', { content: '正文', keys: ['钥'] });
    draft = deleteLorebookEntry(draft, 'a');
    expect(lorebookDraftToEntries(draft, baseline)).toEqual([
      { content: '正文', keys: ['钥'] },
      { id: 'b' },
    ]);

    const moved = moveLorebookEntry(baseline, 'b', -1);
    expect(moved.entries.map((entry) => entry.key)).toEqual(['b', 'a']);
    expect(isLorebookDraftDirty(baseline, moved)).toBe(true);
    expect(moveLorebookEntry(baseline, 'a', -1)).toBe(baseline);
  });

  it('保存后新条目沿用提交时的本地 key，并以服务端返回为新基线', () => {
    const baseline = lorebookToDraft(book);
    const submitted = addLorebookEntry(baseline, newLorebookEntry('new:1'));
    const saved = lorebookToDraft(
      { name: '书', entries: [row('srv-9', 2), ...book.entries] },
      submitted,
    );
    expect(saved.entries.map((entry) => [entry.key, entry.id])).toEqual([
      ['new:1', 'srv-9'],
      ['a', 'a'],
      ['b', 'b'],
    ]);
    // 新基线上未改动 = 只带 id
    expect(lorebookDraftToEntries(saved, saved)).toEqual([
      { id: 'srv-9' },
      { id: 'a' },
      { id: 'b' },
    ]);
    // 条数对不上时不猜
    const mismatch = lorebookToDraft({ name: '书', entries: [row('srv-9', 2)] }, submitted);
    expect(mismatch.entries[0]!.key).toBe('srv-9');
  });
});

describe('触发模拟请求', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POST /api/lorebooks/:id/simulate，带草稿条目', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method ?? 'GET', body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify({ activated: [], skipped: [], warnings: [] }), {
          status: 200,
        });
      }),
    );
    const baseline = lorebookToDraft(book);
    const draft = patchLorebookEntry(baseline, baseline, 'a', { keys: ['龙'] });
    const result = await simulateLorebook('b 1', {
      text: '一条龙',
      entries: lorebookDraftToEntries(draft, baseline),
    });
    expect(result).toEqual({ activated: [], skipped: [], warnings: [] });
    expect(calls).toEqual([
      {
        url: '/api/lorebooks/b%201/simulate',
        method: 'POST',
        body: { text: '一条龙', entries: [{ id: 'a', keys: ['龙'] }, { id: 'b' }] },
      },
    ]);
  });
});
