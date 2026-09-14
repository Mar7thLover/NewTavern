/**
 * 组装流水线 v2 的新增行为（M3 契约 §4）：世界书落点、作者注释、全局系统提示词、
 * 正则、变量副作用、`{{outlet}}` 二次替换、`system_prompt:true` 丢弃、布局接入。
 */

import { describe, expect, it } from 'vitest';

import { type RegexScript } from '../regex/engine.js';
import { makeBook, makeEntry, makeSettings } from '../worldinfo/test-helpers.js';
import { type WIBook } from '../worldinfo/types.js';
import {
  assemblePrompt,
  type AssembleInputV2,
  type AssemblePreset,
  type AssembleResult,
} from './assemble.js';
import { type PromptIR, type Segment } from './ir.js';
import { type LayoutProviderCaps } from './layout/index.js';

const CAPS: LayoutProviderCaps = {
  caching: 'breakpoints',
  maxBreakpoints: 4,
  systemInMessages: true,
  prefill: true,
};

function preset(overrides: Record<string, unknown> = {}): AssemblePreset {
  return {
    id: 'p',
    format: 'st-openai',
    data: {
      prompts: [
        { identifier: 'worldInfoBefore', marker: true },
        { identifier: 'main', system_prompt: true, role: 'system', content: 'MAIN' },
        { identifier: 'worldInfoAfter', marker: true },
        { identifier: 'charDescription', marker: true },
        { identifier: 'dialogueExamples', marker: true },
        { identifier: 'chatHistory', marker: true },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: 'worldInfoBefore', enabled: true },
            { identifier: 'main', enabled: true },
            { identifier: 'worldInfoAfter', enabled: true },
            { identifier: 'charDescription', enabled: true },
            { identifier: 'dialogueExamples', enabled: true },
            { identifier: 'chatHistory', enabled: true },
          ],
        },
      ],
      new_chat_prompt: '',
      new_example_chat_prompt: '[Example Chat]',
      openai_max_context: 100000,
      openai_max_tokens: 0,
      ...overrides,
    },
  };
}

function input(overrides: Partial<AssembleInputV2> = {}): AssembleInputV2 {
  return {
    chatId: 'c1',
    model: 'gpt-x',
    provider: 'openai-chat',
    preset: preset(),
    character: { id: 'ch', name: 'Kit', data: { description: 'Kit is a courier.' } },
    persona: { id: 'pe', name: 'Ada', description: 'Ada is a pilot.' },
    history: [
      { id: 'h1', role: 'assistant', parts: [{ type: 'text', text: 'Morning.' }] },
      { id: 'h2', role: 'user', parts: [{ type: 'text', text: 'Tell me about the harbour.' }] },
    ],
    lorebooks: [],
    wiSettings: makeSettings(),
    variables: { chat: {}, global: {} },
    messageCount: 2,
    providerCaps: CAPS,
    rng: { seed: 'seed-1' },
    ...overrides,
  };
}

const ids = (ir: PromptIR): string[] => ir.segments.map((segment) => segment.id);
const find = (ir: PromptIR, id: string): Segment => {
  const segment = ir.segments.find((item) => item.id === id);
  if (!segment) throw new Error(`未找到段 ${id}：${ids(ir).join(', ')}`);
  return segment;
};
const text = (segment: Segment): string =>
  segment.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
const run = (overrides: Partial<AssembleInputV2> = {}): AssembleResult =>
  assemblePrompt(input(overrides));

/** 一本命中「harbour」的世界书，位置可配 */
function book(
  position: number,
  extra: Partial<Parameters<typeof makeEntry>[0]> = {},
  id = 'b1',
): WIBook {
  return makeBook(
    [
      makeEntry({
        id: `${id}:0`,
        bookId: id,
        keys: ['harbour'],
        content: `WI-${position}`,
        position: position as 0,
        order: 100,
        ...extra,
      }),
    ],
    'global',
    id,
  );
}

// ───────────── 世界书落点 ─────────────

describe('世界书落点', () => {
  it('position 0/1 落到 worldInfoBefore / worldInfoAfter 标记，wi_format 生效', () => {
    const result = run({
      lorebooks: [book(0), book(1, {}, 'b2')],
      preset: preset({ wi_format: '[WI]\n{0}' }),
    });
    expect(text(find(result.ir, 'worldinfo:before'))).toBe('[WI]\nWI-0');
    expect(text(find(result.ir, 'worldinfo:after'))).toBe('[WI]\nWI-1');
    expect(ids(result.ir).indexOf('worldinfo:before')).toBeLessThan(
      ids(result.ir).indexOf('preset:main'),
    );
    expect(ids(result.ir).indexOf('worldinfo:after')).toBeGreaterThan(
      ids(result.ir).indexOf('preset:main'),
    );
  });

  it('同一桶里的多条用 \\n 连成一段', () => {
    const b = makeBook(
      [
        makeEntry({ id: 'x1', keys: ['harbour'], content: 'A', position: 0, order: 10 }),
        makeEntry({ id: 'x2', keys: ['harbour'], content: 'B', position: 0, order: 20 }),
      ],
      'global',
    );
    const result = run({ lorebooks: [b] });
    expect(text(find(result.ir, 'worldinfo:before'))).toBe('A\nB');
  });

  it('position 4 按 (depth, role) 落成深度注入', () => {
    const result = run({ lorebooks: [book(4, { depth: 1, role: 1 })] });
    const segment = find(result.ir, 'worldinfo:depth:1:1');
    expect(segment.role).toBe('user');
    expect(segment.anchor).toEqual({ slot: 'history', depth: 1, order: 100 });
    expect(ids(result.ir).indexOf('worldinfo:depth:1:1')).toBeLessThan(
      ids(result.ir).indexOf('history:h2'),
    );
  });

  it('position 5/6 变成示例块，插在自带示例的前 / 后', () => {
    const result = run({
      character: {
        id: 'ch',
        name: 'Kit',
        data: { description: 'd', mes_example: '<START>\nAda: own\nKit: block' },
      },
      lorebooks: [
        book(5, { content: '<START>\nAda: em-top\nKit: t' }),
        book(6, { content: '<START>\nAda: em-bottom\nKit: b' }, 'b2'),
      ],
    });
    const examples = ids(result.ir).filter((id) => id.startsWith('character:mes_example'));
    expect(examples).toHaveLength(6);
    expect(text(find(result.ir, 'character:mes_example'))).toBe('em-top');
    expect(text(find(result.ir, 'character:mes_example#2'))).toBe('own');
    expect(text(find(result.ir, 'character:mes_example#4'))).toBe('em-bottom');
  });

  it('position 7 进 outlets，{{outlet::name}} 二次替换', () => {
    const result = run({
      lorebooks: [book(7, { outletName: 'notes', content: 'OUTLET BODY' })],
      preset: preset({
        prompts: [
          { identifier: 'main', system_prompt: true, content: 'MAIN {{outlet::notes}}' },
          { identifier: 'chatHistory', marker: true },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: 'main', enabled: true },
              { identifier: 'chatHistory', enabled: true },
            ],
          },
        ],
      }),
    });
    expect(text(find(result.ir, 'preset:main'))).toBe('MAIN OUTLET BODY');
  });

  it('meta.activations 汇总激活条目，wiState 一并返回', () => {
    const result = run({ lorebooks: [book(0)] });
    expect(result.ir.meta.activations).toEqual([
      { entryId: 'b1:0', bookId: 'b1', position: 0, role: 'system', order: 100 },
    ]);
    expect(result.wiState).toBeDefined();
  });

  it('触发式条目 = turn 层，constant 条目 = static 层', () => {
    const triggered = run({ lorebooks: [book(0)] });
    expect(find(triggered.ir, 'worldinfo:before').stability).toBe('turn');
    const constant = run({
      lorebooks: [book(0, { keys: [], constant: true })],
    });
    expect(find(constant.ir, 'worldinfo:before').stability).toBe('static');
  });
});

// ───────────── 作者注释 ─────────────

describe('作者注释', () => {
  const note = { text: 'AN BODY', depth: 1, role: 0 as const, interval: 1 };

  it('position 2 (BEFORE_PROMPT) 紧贴 main 之前', () => {
    const result = run({ authorsNote: { ...note, position: 2 } });
    const list = ids(result.ir);
    expect(list.indexOf('authors_note')).toBe(list.indexOf('preset:main') - 1);
  });

  it('position 0 (IN_PROMPT) 紧贴 main 之后', () => {
    const result = run({ authorsNote: { ...note, position: 0 } });
    const list = ids(result.ir);
    expect(list.indexOf('authors_note')).toBe(list.indexOf('preset:main') + 1);
  });

  it('position 1 (IN_CHAT) 走深度注入', () => {
    const result = run({ authorsNote: { ...note, position: 1 } });
    const segment = find(result.ir, 'authors_note');
    expect(segment.anchor).toEqual({ slot: 'history', depth: 1, order: 100 });
    expect(ids(result.ir).indexOf('authors_note')).toBeLessThan(
      ids(result.ir).indexOf('history:h2'),
    );
  });

  it('interval=2 且用户消息数为奇数时不插入', () => {
    // 历史里只有 1 条 user → 1 % 2 !== 0
    const skipped = run({ authorsNote: { ...note, position: 1, interval: 2 } });
    expect(ids(skipped.ir)).not.toContain('authors_note');

    const hit = run({
      authorsNote: { ...note, position: 1, interval: 2 },
      history: [
        { id: 'h1', role: 'user', parts: [{ type: 'text', text: 'one' }] },
        { id: 'h2', role: 'user', parts: [{ type: 'text', text: 'two' }] },
      ],
    });
    expect(ids(hit.ir)).toContain('authors_note');
  });

  it('anTop / anBottom 桶与 AN 正文拼成一段；AN 为空时仍产生段', () => {
    const result = run({
      authorsNote: { ...note, position: 1 },
      lorebooks: [book(2, { content: 'TOP' }), book(3, { content: 'BOTTOM' }, 'b2')],
    });
    expect(text(find(result.ir, 'authors_note'))).toBe('TOP\nAN BODY\nBOTTOM');

    const noText = run({
      authorsNote: { ...note, position: 1, text: '' },
      lorebooks: [book(2, { content: 'TOP' })],
    });
    expect(text(find(noText.ir, 'authors_note'))).toBe('TOP');
  });

  it('同 (depth, role) 的 AN / 角色深度提示 / WI 合并为一段，顺序照 ST 的 key 字典序', () => {
    const result = run({
      authorsNote: { ...note, position: 1, depth: 1 },
      characterDepthPrompt: { text: 'CHAR DEPTH', depth: 1, role: 0 },
      lorebooks: [book(4, { depth: 1, role: 0, content: 'WI DEPTH' })],
    });
    // 2_floating_prompt < DEPTH_PROMPT < customDepthWI_*
    expect(text(find(result.ir, 'authors_note'))).toBe('AN BODY\nCHAR DEPTH\nWI DEPTH');
    expect(ids(result.ir)).not.toContain('worldinfo:depth:1:0');
  });
});

// ───────────── 全局系统提示词 ─────────────

describe('全局系统提示词', () => {
  it('before_main / after_main 紧贴 main', () => {
    const before = run({ globalSystemPrompt: { text: 'GSP', position: 'before_main' } });
    expect(ids(before.ir).indexOf('global_system')).toBe(ids(before.ir).indexOf('preset:main') - 1);
    const after = run({ globalSystemPrompt: { text: 'GSP', position: 'after_main' } });
    expect(ids(after.ir).indexOf('global_system')).toBe(ids(after.ir).indexOf('preset:main') + 1);
  });

  it('没有 main 时放 system 槽最前', () => {
    const result = run({
      preset: preset({
        prompts: [{ identifier: 'chatHistory', marker: true }],
        prompt_order: [
          { character_id: 100001, order: [{ identifier: 'chatHistory', enabled: true }] },
        ],
      }),
      globalSystemPrompt: { text: 'GSP', position: 'after_main' },
    });
    expect(ids(result.ir)[0]).toBe('global_system');
    expect(find(result.ir, 'global_system').stability).toBe('static');
  });
});

// ───────────── 正则 ─────────────

describe('提示词侧正则', () => {
  const script = (partial: Partial<RegexScript>): RegexScript => ({
    id: 'r1',
    name: 'r1',
    findRegex: '/harbour/g',
    replaceString: 'HARBOUR',
    trimStrings: [],
    placement: [1],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: false,
    substituteRegex: 0,
    scope: 'global',
    ...partial,
  });

  it('对历史按 placement(user/ai) 与 depth 生效', () => {
    const result = run({ regexScripts: [script({ placement: [1] })] });
    expect(text(find(result.ir, 'history:h2'))).toBe('Tell me about the HARBOUR.');
    expect(text(find(result.ir, 'history:h1'))).toBe('Morning.');

    const bounded = run({ regexScripts: [script({ placement: [1], minDepth: 1 })] });
    // 最后一条历史 depth = 0，minDepth=1 时不生效
    expect(text(find(bounded.ir, 'history:h2'))).toBe('Tell me about the harbour.');
  });

  it('对世界书内容按 placement 5 生效，替换成空则剔除该条', () => {
    const applied = run({
      lorebooks: [book(0)],
      regexScripts: [script({ placement: [5], findRegex: '/WI-0/', replaceString: 'REPLACED' })],
    });
    expect(text(find(applied.ir, 'worldinfo:before'))).toBe('REPLACED');

    const emptied = run({
      lorebooks: [book(0)],
      regexScripts: [script({ placement: [5], findRegex: '/WI-0/', replaceString: '' })],
    });
    expect(ids(emptied.ir)).not.toContain('worldinfo:before');
  });
});

// ───────────── 变量 ─────────────

describe('变量事务', () => {
  const varPreset = preset({
    prompts: [
      {
        identifier: 'main',
        system_prompt: true,
        content: '{{setvar::mood::calm}}{{getvar::mood}}',
      },
      { identifier: 'chatHistory', marker: true },
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'chatHistory', enabled: true },
        ],
      },
    ],
  });

  it('宏的写入进事务并在结果里返回', () => {
    const result = run({ preset: varPreset });
    expect(text(find(result.ir, 'preset:main'))).toBe('calm');
    expect(result.variables.chat).toEqual({ mood: 'calm' });
    expect(result.variables.events).toHaveLength(1);
  });

  it('dryRun 时不返回变量副作用', () => {
    const result = run({ preset: varPreset, dryRun: true, variables: { chat: {}, global: {} } });
    expect(result.variables.chat).toEqual({});
    expect(result.variables.globalChanges).toEqual({});
    expect(result.variables.events).toHaveLength(1);
  });

  it('rng.seed 决定确定性随机', () => {
    const rollPreset = preset({
      prompts: [
        { identifier: 'main', system_prompt: true, content: '{{roll:d20}}' },
        { identifier: 'chatHistory', marker: true },
      ],
      prompt_order: [
        {
          character_id: 100001,
          order: [
            { identifier: 'main', enabled: true },
            { identifier: 'chatHistory', enabled: true },
          ],
        },
      ],
    });
    const a = run({ preset: rollPreset, rng: { seed: 'abc' } });
    const b = run({ preset: rollPreset, rng: { seed: 'abc' } });
    expect(text(find(a.ir, 'preset:main'))).toBe(text(find(b.ir, 'preset:main')));
  });
});

// ───────────── ST 兼容细节 ─────────────

describe('ST 兼容细节', () => {
  it('system_prompt:true 的自定义 prompt 被丢弃并记 warning', () => {
    const result = run({
      preset: preset({
        prompts: [
          { identifier: 'main', system_prompt: true, content: 'MAIN' },
          { identifier: 'custom-x', system_prompt: true, content: 'CUSTOM' },
          { identifier: 'custom-y', system_prompt: false, content: 'KEPT' },
          { identifier: 'chatHistory', marker: true },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: 'main', enabled: true },
              { identifier: 'custom-x', enabled: true },
              { identifier: 'custom-y', enabled: true },
              { identifier: 'chatHistory', enabled: true },
            ],
          },
        ],
      }),
    });
    expect(ids(result.ir)).not.toContain('preset:custom-x');
    expect(ids(result.ir)).toContain('preset:custom-y');
    expect(result.ir.meta.warnings.some((w) => w.includes('custom-x'))).toBe(true);
  });

  it('names_behavior=COMPLETION 写 name 字段，CONTENT 写进正文', () => {
    const history: AssembleInputV2['history'] = [
      { id: 'h1', role: 'user', name: 'Ada', parts: [{ type: 'text', text: 'hi' }] },
    ];
    const completion = run({ preset: preset({ names_behavior: 1 }), history, messageCount: 1 });
    expect(find(completion.ir, 'history:h1').name).toBe('Ada');
    expect(text(find(completion.ir, 'history:h1'))).toBe('hi');

    const content = run({ preset: preset({ names_behavior: 2 }), history, messageCount: 1 });
    expect(find(content.ir, 'history:h1').name).toBeUndefined();
    expect(text(find(content.ir, 'history:h1'))).toBe('Ada: hi');
  });
});

// ───────────── 布局接入 ─────────────

describe('布局接入', () => {
  it('strict 不动段，cache-aware 输出 strictIr 与 layout 报告', () => {
    const strict = run({ lorebooks: [book(0)], layoutMode: 'strict' });
    expect(strict.strictIr).toBeUndefined();
    expect(strict.layout.mode).toBe('strict');
    expect(strict.layout.moves).toEqual([]);

    const cacheAware = run({ lorebooks: [book(0)], layoutMode: 'cache-aware' });
    expect(cacheAware.strictIr).toBeDefined();
    expect(cacheAware.layout.mode).toBe('cache-aware');
    // 触发式 WI 从 static 区移到尾部
    expect(ids(cacheAware.ir)).not.toContain('worldinfo:before');
    expect(ids(cacheAware.ir)).toContain('layout:wiCarrier');
    expect(cacheAware.layout.moves.map((move) => move.segmentId)).toContain('worldinfo:before');
  });
});
