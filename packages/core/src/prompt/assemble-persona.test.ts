/**
 * 用户档案描述的位置（ST `persona_description_positions`）。
 *
 * 期望值对照 SillyTavern 1.18 源码：
 * - `public/scripts/personas.js`：`persona_description_positions`（IN_PROMPT 0 / TOP_AN 2 /
 *   BOTTOM_AN 3 / AT_DEPTH 4 / NONE 9）、`DEFAULT_DEPTH = 2`、`DEFAULT_ROLE = 0`
 * - `public/script.js` `addPersonaDescriptionExtensionPrompt`（约 3144 行）：
 *   NONE / 空描述直接返回；TOP_AN、BOTTOM_AN 在 `shouldWIAddPrompt` 时改写 `2_floating_prompt`
 *   为 `${desc}\n${AN}` / `${AN}\n${desc}`；AT_DEPTH 注册 `PERSONA_DESCRIPTION`（IN_CHAT, depth, scan, role）
 * - `public/scripts/openai.js` `preparePromptsForChatCompletion`（约 1424 行）：
 *   只有 IN_PROMPT 才生成 `personaDescription` 标记内容
 * - `public/script.js` `getExtensionPrompt`（约 3242 行）：同 (depth, role) 的扩展提示词按 key 字典序
 *   以 `\n` 合并，`2_floating_prompt` < `DEPTH_PROMPT` < `PERSONA_DESCRIPTION` < `customDepthWI_*`
 * - `public/scripts/world-info.js` `checkWorldInfo`（约 4608 行）：`scan: true` 的扩展提示词进扫描缓冲
 */

import { describe, expect, it } from 'vitest';

import { makeBook, makeEntry, makeSettings } from '../worldinfo/test-helpers.js';
import {
  assemblePrompt,
  type AssembleInputV2,
  type AssemblePersona,
  type AssembleResult,
} from './assemble.js';
import { type PromptIR, type Segment } from './ir.js';

const PROMPT_IDS = ['main', 'personaDescription', 'charDescription', 'chatHistory'];

function input(overrides: Partial<AssembleInputV2> = {}): AssembleInputV2 {
  return {
    chatId: 'c1',
    model: 'gpt-x',
    provider: 'openai-chat',
    preset: {
      id: 'p',
      format: 'st-openai',
      data: {
        prompts: [
          { identifier: 'main', system_prompt: true, role: 'system', content: 'MAIN' },
          { identifier: 'personaDescription', marker: true },
          { identifier: 'charDescription', marker: true },
          { identifier: 'chatHistory', marker: true },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: PROMPT_IDS.map((identifier) => ({ identifier, enabled: true })),
          },
        ],
        new_chat_prompt: '',
        openai_max_context: 100000,
        openai_max_tokens: 0,
      },
    },
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
const withPersona = (
  persona: Partial<AssemblePersona>,
  overrides: Partial<AssembleInputV2> = {},
): AssembleResult =>
  assemblePrompt(
    input({ persona: { name: 'Ada', description: 'Ada is a pilot.', ...persona }, ...overrides }),
  );
const allText = (ir: PromptIR): string => ir.segments.map(text).join('\n---\n');

const note = { text: 'AN BODY', position: 1 as const, depth: 1, role: 0 as const, interval: 1 };

describe('用户档案描述位置', () => {
  it('缺省 = in_prompt：走 personaDescription 标记，与显式 in_prompt 完全相同', () => {
    const implicit = assemblePrompt(input());
    const explicit = withPersona({ position: 'in_prompt' });
    expect(text(find(implicit.ir, 'persona'))).toBe('Ada is a pilot.');
    expect(explicit.ir.segments).toEqual(implicit.ir.segments);
    expect(ids(implicit.ir).indexOf('persona')).toBe(ids(implicit.ir).indexOf('preset:main') + 1);
  });

  it('none：哪里都不放，但 {{persona}} 宏照常可用', () => {
    const result = withPersona(
      { position: 'none' },
      { authorsNote: { ...note, text: 'AN knows: {{persona}}' } },
    );
    expect(ids(result.ir)).not.toContain('persona');
    expect(text(find(result.ir, 'authors_note'))).toBe('AN knows: Ada is a pilot.');
    expect(allText(result.ir).split('Ada is a pilot.')).toHaveLength(2);
  });

  it('at_depth：按 (depth, role) 深度注入，不再出现在标记位', () => {
    const result = withPersona({ position: 'at_depth', depth: 1, role: 1 });
    expect(ids(result.ir)).not.toContain('persona');
    const segment = find(result.ir, 'persona:depth');
    expect(segment.role).toBe('user');
    expect(text(segment)).toBe('Ada is a pilot.');
    expect(segment.anchor).toEqual({ slot: 'history', depth: 1, order: 100 });
    // depth 1 = 插在最后一条消息之前
    const list = ids(result.ir);
    expect(list.indexOf('persona:depth')).toBe(list.indexOf('history:h2') - 1);
  });

  it('at_depth 缺省 depth=2、role=system（ST DEFAULT_DEPTH / DEFAULT_ROLE）', () => {
    const result = withPersona({ position: 'at_depth' });
    const segment = find(result.ir, 'persona:depth');
    expect(segment.role).toBe('system');
    expect(segment.anchor).toEqual({ slot: 'history', depth: 2, order: 100 });
    expect(ids(result.ir).indexOf('persona:depth')).toBe(ids(result.ir).indexOf('history:h1') - 1);
  });

  it('at_depth 与作者注释 / 角色深度提示 / WI 同 (depth, role) 时按 key 字典序合并', () => {
    const result = withPersona(
      { position: 'at_depth', depth: 1, role: 0 },
      {
        authorsNote: note,
        characterDepthPrompt: { text: 'CHAR DEPTH', depth: 1, role: 0 },
        lorebooks: [
          makeBook([
            makeEntry({
              id: 'b1:0',
              bookId: 'b1',
              keys: ['harbour'],
              content: 'WI DEPTH',
              position: 4,
              depth: 1,
              role: 0,
            }),
          ]),
        ],
      },
    );
    // 2_floating_prompt < DEPTH_PROMPT < PERSONA_DESCRIPTION < customDepthWI_1_0
    expect(text(find(result.ir, 'authors_note'))).toBe(
      'AN BODY\nCHAR DEPTH\nAda is a pilot.\nWI DEPTH',
    );
    expect(ids(result.ir)).not.toContain('persona:depth');
  });

  it('at_depth 的描述并入 WI 扫描源（scan: true）', () => {
    const book = makeBook([
      makeEntry({ id: 'b1:0', bookId: 'b1', keys: ['pilot'], content: 'WI HIT', position: 0 }),
    ]);
    const inPrompt = withPersona({ position: 'in_prompt' }, { lorebooks: [book] });
    expect(inPrompt.wi.activations).toHaveLength(0);
    const atDepth = withPersona({ position: 'at_depth' }, { lorebooks: [book] });
    expect(atDepth.wi.activations.map((activation) => activation.entry.id)).toEqual(['b1:0']);
  });

  it('top_an / bottom_an：拼到作者注释前 / 后（`\\n` 连接）', () => {
    const top = withPersona({ position: 'top_an' }, { authorsNote: note });
    expect(text(find(top.ir, 'authors_note'))).toBe('Ada is a pilot.\nAN BODY');
    expect(ids(top.ir)).not.toContain('persona');

    const bottom = withPersona({ position: 'bottom_an' }, { authorsNote: note });
    expect(text(find(bottom.ir, 'authors_note'))).toBe('AN BODY\nAda is a pilot.');
  });

  it('top_an 在 WI 并入 AN 之后执行：描述排在 ANTop 条目之前', () => {
    const result = withPersona(
      { position: 'top_an' },
      {
        authorsNote: note,
        lorebooks: [
          makeBook([
            makeEntry({ id: 'b1:0', bookId: 'b1', keys: ['harbour'], content: 'TOP', position: 2 }),
          ]),
        ],
      },
    );
    expect(text(find(result.ir, 'authors_note'))).toBe('Ada is a pilot.\nTOP\nAN BODY');
  });

  it('top_an 跟随作者注释的位置（这里 BEFORE_PROMPT 紧贴 main 之前）', () => {
    const result = withPersona({ position: 'top_an' }, { authorsNote: { ...note, position: 2 } });
    const list = ids(result.ir);
    expect(list.indexOf('authors_note')).toBe(list.indexOf('preset:main') - 1);
    expect(text(find(result.ir, 'authors_note'))).toBe('Ada is a pilot.\nAN BODY');
  });

  it('作者注释为空时仍产生段（ST 不 trim；深度注入时 getExtensionPrompt 会 trim）', () => {
    const result = withPersona({ position: 'bottom_an' }, { authorsNote: { ...note, text: '' } });
    expect(text(find(result.ir, 'authors_note'))).toBe('Ada is a pilot.');
  });

  it('作者注释 interval 未命中（shouldWIAddPrompt=false）时 top_an 的描述也不放', () => {
    // 历史里只有 1 条 user，interval=2 → 不插入
    const result = withPersona({ position: 'top_an' }, { authorsNote: { ...note, interval: 2 } });
    expect(ids(result.ir)).not.toContain('authors_note');
    expect(allText(result.ir)).not.toContain('Ada is a pilot.');
  });

  it('描述为空时任何位置都不产生段', () => {
    for (const position of ['in_prompt', 'top_an', 'at_depth'] as const) {
      const result = withPersona({ position, description: '' }, { authorsNote: note });
      expect(ids(result.ir)).not.toContain('persona');
      expect(ids(result.ir)).not.toContain('persona:depth');
      expect(text(find(result.ir, 'authors_note'))).toBe('AN BODY');
    }
  });
});
