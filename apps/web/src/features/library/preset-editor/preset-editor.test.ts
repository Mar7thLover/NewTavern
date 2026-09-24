import { afterEach, describe, expect, it, vi } from 'vitest';

import { savePresetDraft, savePresetLayoutPolicy } from './api';
import {
  addPrompt,
  deletePromptFromDraft,
  isPresetDraftDirty,
  moveOrderEntry,
  normalizeLayoutPolicy,
  presetDraftChanges,
  presetDraftToLayoutPolicyBody,
  presetDraftToUpdate,
  presetToDraft,
  readOrder,
  setLayoutMode,
  setOrderEnabled,
  setPromptLocked,
  type PresetData,
  type PresetDraft,
} from './model';

/**
 * 预设编辑器草稿模型：服务端 ⇄ 草稿、排序（拖拽与上下移共用）无损、布局策略与保真锁、增量保存。
 */

function stPreset(): PresetData {
  return {
    temperature: 1,
    unknown_top_level: { keep: ['me'] },
    prompts: [
      { identifier: 'main', name: 'Main', role: 'system', content: 'hi', extra_field: 1 },
      { identifier: 'chatHistory', name: 'Chat History', marker: true },
      { identifier: 'jailbreak', name: 'JB', role: 'system', content: 'jb' },
      { identifier: 'custom', name: 'Custom', role: 'user', content: 'c' },
    ],
    prompt_order: [
      { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
      {
        character_id: 100001,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'chatHistory', enabled: true, weird: 'x' },
          { identifier: 'jailbreak', enabled: false },
          { identifier: 'custom', enabled: true },
        ],
        extra_list_field: 'kept',
      },
    ],
  };
}

function detail(data = stPreset(), layoutPolicy: Record<string, unknown> | null = null) {
  return { name: 'P', data, layoutPolicy };
}

/** 两份预设除了当前 prompt_order 的顺序外完全一致（按 identifier 排序后比较） */
function withoutActiveOrder(data: PresetData): unknown {
  const clone = structuredClone(data) as PresetData;
  const lists = clone.prompt_order as { character_id: number; order: { identifier: string }[] }[];
  const active = lists.find((list) => list.character_id === 100001)!;
  active.order.sort((a, b) => a.identifier.localeCompare(b.identifier));
  return clone;
}

describe('预设草稿模型', () => {
  it('presetToDraft / presetDraftToUpdate：名称去空白、data 原样、空策略规整为 null', () => {
    const draft = presetToDraft(detail(stPreset(), { lockedIdentifiers: [] }));
    expect(draft.layoutPolicy).toBeNull();
    const update = presetDraftToUpdate({ ...draft, name: '  新名  ' });
    expect(update).toEqual({ name: '新名', data: draft.data });
    expect(update.data).toBe(draft.data);
  });

  it('读的是组装用的那份 prompt_order（100001 优先）', () => {
    expect(readOrder(stPreset()).map((entry) => entry.identifier)).toEqual([
      'main',
      'chatHistory',
      'jailbreak',
      'custom',
    ]);
  });

  it('拖拽排序只重排当前 prompt_order，其余字段与条目对象原样', () => {
    const original = stPreset();
    const moved = moveOrderEntry(original, 3, 0);
    expect(readOrder(moved).map((entry) => entry.identifier)).toEqual([
      'custom',
      'main',
      'chatHistory',
      'jailbreak',
    ]);
    // 入参不变
    expect(readOrder(original)[0]!.identifier).toBe('main');
    // 条目对象（含未知字段）原样搬动
    expect(readOrder(moved)[2]).toBe(readOrder(original)[1]);
    // 除了顺序，整份 JSON 与原件逐字段一致（导出无损）
    expect(withoutActiveOrder(moved)).toEqual(withoutActiveOrder(original));
    expect(JSON.stringify(withoutActiveOrder(moved))).toBe(
      JSON.stringify(withoutActiveOrder(original)),
    );
    // 另一份 prompt_order 不动
    expect((moved.prompt_order as unknown[])[0]).toBe((original.prompt_order as unknown[])[0]);
  });

  it('上下移与拖拽共用语义：往下拖落在目标之后，往上拖落在目标之前；越界夹紧', () => {
    const ids = (data: PresetData) => readOrder(data).map((entry) => entry.identifier);
    expect(ids(moveOrderEntry(stPreset(), 0, 2))).toEqual([
      'chatHistory',
      'jailbreak',
      'main',
      'custom',
    ]);
    expect(ids(moveOrderEntry(stPreset(), 2, 1))).toEqual([
      'main',
      'jailbreak',
      'chatHistory',
      'custom',
    ]);
    expect(ids(moveOrderEntry(stPreset(), 0, 99))).toEqual([
      'chatHistory',
      'jailbreak',
      'custom',
      'main',
    ]);
    const same = stPreset();
    expect(moveOrderEntry(same, 1, 1)).toBe(same);
  });

  it('prompt_order 里混有非对象项时，非对象项留在原位', () => {
    const data = stPreset();
    const lists = data.prompt_order as { order: unknown[] }[];
    lists[1]!.order.splice(1, 0, 'garbage');
    const moved = moveOrderEntry(data, 0, 1);
    expect((moved.prompt_order as { order: unknown[] }[])[1]!.order).toEqual([
      { identifier: 'chatHistory', enabled: true, weird: 'x' },
      'garbage',
      { identifier: 'main', enabled: true },
      { identifier: 'jailbreak', enabled: false },
      { identifier: 'custom', enabled: true },
    ]);
    // 开关也按可见下标找对条目
    const toggled = setOrderEnabled(data, 2, true);
    expect(readOrder(toggled)[2]).toEqual({ identifier: 'jailbreak', enabled: true });
  });

  it('新增条目追加到 prompts 与当前顺序末尾；删除时从所有顺序与锁表里去掉', () => {
    const added = addPrompt(stPreset(), 'new-id', '新条目');
    expect(readOrder(added).at(-1)).toEqual({ identifier: 'new-id', enabled: true });
    expect((added.prompts as { identifier: string }[]).at(-1)!.identifier).toBe('new-id');

    const draft: PresetDraft = {
      name: 'P',
      data: stPreset(),
      layoutPolicy: { mode: 'cache-aware', lockedIdentifiers: ['main', 'custom'] },
    };
    const removed = deletePromptFromDraft(draft, 'main');
    expect(readOrder(removed.data).map((entry) => entry.identifier)).not.toContain('main');
    expect((removed.data.prompt_order as { order: { identifier: string }[] }[])[0]!.order).toEqual(
      [],
    );
    expect(removed.layoutPolicy).toEqual({ mode: 'cache-aware', lockedIdentifiers: ['custom'] });
  });

  it('布局策略：模式与保真锁，未知键保留，全空回到 null', () => {
    let policy = setLayoutMode({ tailWindow: 6 }, 'cache-aware');
    expect(policy).toEqual({ tailWindow: 6, mode: 'cache-aware' });
    policy = setPromptLocked(policy, 'main', true);
    policy = setPromptLocked(policy, 'main', true);
    expect(policy?.lockedIdentifiers).toEqual(['main']);
    policy = setPromptLocked(policy, 'main', false);
    expect(policy).toEqual({ tailWindow: 6, mode: 'cache-aware' });
    expect(setLayoutMode({ mode: 'strict' }, null)).toBeNull();
    expect(normalizeLayoutPolicy({ mode: undefined, lockedIdentifiers: ['a', 'a', 3] })).toEqual({
      lockedIdentifiers: ['a'],
    });
  });

  it('dirty 与增量：只改锁不算改 data，只改 data 不算改策略', () => {
    const baseline = presetToDraft(detail());
    expect(isPresetDraftDirty(baseline, baseline)).toBe(false);
    // 内容相同的新对象不算改动
    expect(
      isPresetDraftDirty(baseline, { ...baseline, data: structuredClone(baseline.data) }),
    ).toBe(false);
    const locked = {
      ...baseline,
      layoutPolicy: setPromptLocked(baseline.layoutPolicy, 'main', true),
    };
    expect(presetDraftChanges(baseline, locked)).toEqual({ data: false, layoutPolicy: true });
    const moved = { ...baseline, data: moveOrderEntry(baseline.data, 0, 1) };
    expect(presetDraftChanges(baseline, moved)).toEqual({ data: true, layoutPolicy: false });
    expect(presetDraftChanges(baseline, { ...baseline, name: 'P ' })).toEqual({
      data: false,
      layoutPolicy: false,
    });
    expect(presetDraftToLayoutPolicyBody(locked)).toEqual({
      layoutPolicy: { lockedIdentifiers: ['main'] },
    });
  });
});

describe('预设保存', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        const body = init.body ? JSON.parse(init.body as string) : undefined;
        calls.push({ url, method: init.method ?? 'GET', body });
        return new Response(JSON.stringify({ id: 'p1', name: 'P', data: {}, layoutPolicy: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return calls;
  }

  it('布局策略走单独的请求（集中在 savePresetLayoutPolicy）', async () => {
    const calls = stubFetch();
    await savePresetLayoutPolicy('p/1', { mode: 'strict' });
    expect(calls).toEqual([
      {
        url: '/api/presets/p%2F1/layout-policy',
        method: 'PUT',
        body: { layoutPolicy: { mode: 'strict' } },
      },
    ]);
  });

  it('savePresetDraft 按改动发请求：data 改了才 PUT，策略改了才写策略', async () => {
    const baseline = presetToDraft(detail());
    let calls = stubFetch();
    expect(await savePresetDraft('p1', baseline, baseline)).toBeUndefined();
    expect(calls).toEqual([]);

    const both: PresetDraft = {
      name: 'Q',
      data: moveOrderEntry(baseline.data, 0, 1),
      layoutPolicy: { mode: 'cache-aware' },
    };
    calls = stubFetch();
    await savePresetDraft('p1', both, baseline, { author: 'ai' });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'PUT /api/presets/p1',
      'PUT /api/presets/p1/layout-policy',
    ]);
    expect(calls[0]!.body).toEqual({ name: 'Q', data: both.data, author: 'ai' });
    expect(calls[1]!.body).toEqual({ layoutPolicy: { mode: 'cache-aware' }, author: 'ai' });

    calls = stubFetch();
    await savePresetDraft(
      'p1',
      { ...baseline, layoutPolicy: null },
      {
        ...baseline,
        layoutPolicy: { mode: 'strict' },
      },
    );
    expect(calls).toEqual([
      { url: '/api/presets/p1/layout-policy', method: 'PUT', body: { layoutPolicy: null } },
    ]);
  });
});
