/**
 * M5（三）§3.2：前端卡 `generate({injects, overrides})` 与 `injectPrompts` 落到组装上的两条输入——
 * `extraInjections`（临时注入）与 `promptOverrides`（覆盖项）。语义照酒馆助手 4.9.3
 * `function/inject.ts` 与 `function/generate/dataProcessor.ts`。
 */

import { describe, expect, it } from 'vitest';

import { makeBook, makeEntry, makeSettings } from '../worldinfo/test-helpers.js';
import {
  assemblePrompt,
  type AssembleInputV2,
  type AssemblePreset,
  type AssembleResult,
} from './assemble.js';
import { type PromptIR, type Segment } from './ir.js';

function preset(): AssemblePreset {
  const order = [
    'worldInfoBefore',
    'main',
    'worldInfoAfter',
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'dialogueExamples',
    'chatHistory',
  ];
  return {
    id: 'p',
    format: 'st-openai',
    data: {
      prompts: [
        { identifier: 'main', system_prompt: true, role: 'system', content: 'MAIN' },
        ...order
          .filter((identifier) => identifier !== 'main')
          .map((identifier) => ({ identifier, marker: true })),
      ],
      prompt_order: [
        { character_id: 100001, order: order.map((identifier) => ({ identifier, enabled: true })) },
      ],
      new_chat_prompt: '',
      new_example_chat_prompt: '[Example Chat]',
      personality_format: '{{personality}}',
      scenario_format: '{{scenario}}',
      openai_max_context: 100000,
      openai_max_tokens: 0,
    },
  };
}

function input(overrides: Partial<AssembleInputV2> = {}): AssembleInputV2 {
  return {
    chatId: 'c1',
    model: 'gpt-x',
    provider: 'openai-chat',
    preset: preset(),
    character: {
      id: 'ch',
      name: 'Kit',
      data: {
        description: 'Kit is a courier.',
        personality: 'curious',
        scenario: 'A harbour town.',
        mes_example: '<START>\n{{user}}: hi\n{{char}}: hello',
      },
    },
    persona: { id: 'pe', name: 'Ada', description: 'Ada is a pilot.' },
    history: [
      { id: 'h1', role: 'assistant', parts: [{ type: 'text', text: 'Morning.' }] },
      { id: 'h2', role: 'user', parts: [{ type: 'text', text: 'Tell me about the harbour.' }] },
    ],
    lorebooks: [],
    wiSettings: makeSettings(),
    variables: { chat: {}, global: {} },
    messageCount: 2,
    providerCaps: { caching: 'none', systemInMessages: true, prefill: true },
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

describe('extraInjections（临时注入）', () => {
  it('in_chat 按 depth 插进历史，内容做宏替换', () => {
    const result = run({
      extraInjections: [
        { id: 'cot', content: '想一想 {{char}} 会怎么做', role: 'system', position: 'in_chat', depth: 0 },
      ],
    });
    const list = ids(result.ir);
    const segment = find(result.ir, 'injection:extra:cot');
    expect(text(segment)).toBe('想一想 Kit 会怎么做');
    expect(segment.anchor).toEqual({ slot: 'history', depth: 0, order: 100 });
    expect(segment.origin).toEqual({ kind: 'injection', ref: 'cot' });
    // depth 0 = 最后一条历史之后
    expect(list.indexOf('injection:extra:cot')).toBe(list.indexOf('history:h2') + 1);
  });

  it('depth 1 落在最后一条之前；role 生效', () => {
    const result = run({
      extraInjections: [
        { id: 'u1', content: 'USER NOTE', role: 'user', position: 'in_chat', depth: 1 },
      ],
    });
    const list = ids(result.ir);
    expect(list.indexOf('injection:extra:u1')).toBe(list.indexOf('history:h2') - 1);
    expect(find(result.ir, 'injection:extra:u1').role).toBe('user');
  });

  it('同 (depth, role) 与作者注释合并，按键的字典序（ST getExtensionPrompt 的 sort）', () => {
    const result = run({
      authorsNote: { text: 'AN', position: 1, depth: 1, role: 0, interval: 1 },
      extraInjections: [
        { id: 'zz', content: 'Z', role: 'system', position: 'in_chat', depth: 1 },
        { id: '1a', content: 'ONE', role: 'system', position: 'in_chat', depth: 1 },
      ],
    });
    // '1a' < '2_floating_prompt' < 'zz'
    const merged = find(result.ir, 'injection:extra:1a');
    expect(text(merged)).toBe('ONE\nAN\nZ');
    expect(ids(result.ir)).not.toContain('authors_note');
  });

  it('非 100 的 order 单独成组（小的在前）', () => {
    const result = run({
      extraInjections: [
        { id: 'late', content: 'LATE', role: 'system', position: 'in_chat', depth: 0, order: 200 },
        { id: 'early', content: 'EARLY', role: 'system', position: 'in_chat', depth: 0, order: 50 },
      ],
    });
    const list = ids(result.ir);
    expect(list.indexOf('injection:extra:early')).toBeLessThan(list.indexOf('injection:extra:late'));
  });

  it("position:'none' 不进提示词；scan=true 能激活世界书条目", () => {
    const lorebooks = [
      makeBook(
        [
          makeEntry({
            id: 'b:0',
            bookId: 'b',
            keys: ['秘密暗号'],
            content: 'WI-HIT',
            position: 0,
            order: 100,
          }),
        ],
        'global',
        'b',
      ),
    ];
    const without = run({ lorebooks });
    expect(ids(without.ir)).not.toContain('worldinfo:before');

    const noScan = run({
      lorebooks,
      extraInjections: [
        { id: 'k', content: '秘密暗号', role: 'system', position: 'none', depth: 0, scan: false },
      ],
    });
    expect(ids(noScan.ir)).not.toContain('worldinfo:before');

    const scanned = run({
      lorebooks,
      extraInjections: [
        { id: 'k', content: '秘密暗号', role: 'system', position: 'none', depth: 0, scan: true },
      ],
    });
    expect(text(find(scanned.ir, 'worldinfo:before'))).toBe('WI-HIT');
    expect(ids(scanned.ir).some((id) => id.startsWith('injection:extra:'))).toBe(false);
  });

  it('没有注入时与原来逐段一致', () => {
    expect(ids(run({ extraInjections: [] }).ir)).toEqual(ids(run().ir));
  });
});

describe('promptOverrides（覆盖项）', () => {
  it('卡字段与档案描述被替换，空串 = 过滤掉这一段', () => {
    const result = run({
      promptOverrides: {
        char_description: '覆盖的描述 {{char}}',
        char_personality: '',
        scenario: '新场景',
        persona_description: '新的我',
      },
    });
    expect(text(find(result.ir, 'character:description'))).toBe('覆盖的描述 Kit');
    expect(ids(result.ir)).not.toContain('character:personality');
    expect(text(find(result.ir, 'character:scenario'))).toBe('新场景');
    expect(text(find(result.ir, 'persona'))).toBe('新的我');
  });

  it('dialogue_examples 替换示例对话', () => {
    const result = run({
      promptOverrides: { dialogue_examples: '<START>\n{{user}}: yo\n{{char}}: sup' },
    });
    const examples = result.ir.segments
      .filter((segment) => segment.id.startsWith('character:mes_example'))
      .map(text);
    expect(examples).toEqual(['yo', 'sup']);
  });

  it('world_info_before / after 整段替换', () => {
    const result = run({
      promptOverrides: { world_info_before: 'BEFORE!', world_info_after: '' },
    });
    expect(text(find(result.ir, 'worldinfo:before'))).toBe('BEFORE!');
    expect(ids(result.ir)).not.toContain('worldinfo:after');
  });

  it('chat_history.prompts 替换聊天历史，最后一条 user 是本轮输入', () => {
    const result = run({
      promptOverrides: {
        chat_history: {
          prompts: [
            { role: 'user', content: '只看这一句' },
            { role: 'assistant', content: '好的' },
            { role: 'user', content: '继续' },
          ],
        },
      },
    });
    const history = result.ir.segments.filter(
      (segment) => segment.origin.kind === 'history' || segment.origin.kind === 'user_input',
    );
    expect(history.map(text)).toEqual(['只看这一句', '好的', '继续']);
    expect(history[2]?.origin.kind).toBe('user_input');
    expect(ids(result.ir)).not.toContain('history:h1');
  });

  it('chat_history.prompts=[] 连带去掉作者注释与卡的深度提示', () => {
    const result = run({
      authorsNote: { text: 'AN', position: 1, depth: 0, role: 0, interval: 1 },
      characterDepthPrompt: { text: 'DEPTH', depth: 0, role: 0 },
      promptOverrides: { chat_history: { prompts: [] } },
    });
    const list = ids(result.ir);
    expect(list.some((id) => id.startsWith('history:'))).toBe(false);
    expect(list).not.toContain('authors_note');
    expect(list).not.toContain('injection:char_depth_prompt');
  });

  it('chat_history.author_note 覆盖作者注释；with_depth_entries=false 去掉深度世界书', () => {
    const lorebooks = [
      makeBook(
        [
          makeEntry({
            id: 'b:0',
            bookId: 'b',
            keys: ['harbour'],
            content: 'WI-DEPTH',
            position: 4,
            depth: 0,
            role: 0,
            order: 100,
          }),
        ],
        'global',
        'b',
      ),
    ];
    const base = run({
      lorebooks,
      authorsNote: { text: 'OLD', position: 1, depth: 2, role: 0, interval: 1 },
    });
    expect(ids(base.ir)).toContain('worldinfo:depth:0:0');

    const result = run({
      lorebooks,
      authorsNote: { text: 'OLD', position: 1, depth: 2, role: 0, interval: 1 },
      promptOverrides: { chat_history: { author_note: 'NEW', with_depth_entries: false } },
    });
    expect(text(find(result.ir, 'authors_note'))).toBe('NEW');
    expect(ids(result.ir)).not.toContain('worldinfo:depth:0:0');
  });

  it('不改调用方的输入对象', () => {
    const source = input({ promptOverrides: { char_description: 'X' } });
    assemblePrompt(source);
    expect(source.character?.data.description).toBe('Kit is a courier.');
  });
});
