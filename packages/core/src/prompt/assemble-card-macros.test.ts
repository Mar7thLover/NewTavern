/**
 * 卡类宏（{{persona}} {{description}} {{scenario}} …）在各处的展开结果，对齐 SillyTavern 1.18 默认的新宏引擎
 * （`power_user.experimental_macro_engine: true`，发行版 `default/content/settings.json` 的默认值）。
 *
 * 期望值是 2026-09-16 用黄金录制工具驱动本机 ST 1.18 实录的请求（`probe-new-inprompt` /
 * `probe-new-atdepth` / `probe-new-topan` 三组，逐字节照抄），机制见 docs/M4-CONTRACT.md §9「修正（2026-09-16，MSS）」：
 * - 卡字段（description / personality / scenario / mes_example / system_prompt / post_history_instructions /
 *   depth_prompt）先 `baseChatReplace`（`replaceCharacterCard: false`），其中的卡类宏一律展开为**空串**；
 * - 档案描述进提示词（IN_PROMPT / AT_DEPTH / TOP_AN）、聊天消息、作者注释是「非卡字段文本」，
 *   其中的卡类宏展开为对应字段的 baseChatReplace 值。
 */

import { describe, expect, it } from 'vitest';

import { makeSettings } from '../worldinfo/test-helpers.js';
import { assemblePrompt, type AssembleInputV2, type AssemblePersona } from './assemble.js';
import type { PromptIR } from './ir.js';

const ORDER = [
  'main',
  'worldInfoBefore',
  'personaDescription',
  'charDescription',
  'charPersonality',
  'scenario',
  'enhanceDefinitions',
  'nsfw',
  'worldInfoAfter',
  'dialogueExamples',
  'chatHistory',
  'jailbreak',
];

/** tools/fixtures/presets/baseline.json 里与本用例相关的部分 */
const BASELINE_PRESET = {
  id: 'baseline',
  format: 'st-openai' as const,
  data: {
    prompts: [
      {
        identifier: 'main',
        role: 'system',
        system_prompt: true,
        content:
          "Write {{char}}'s next reply in a fictional chat between {{char}} and {{user}}. Keep it grounded and concrete.",
      },
      { identifier: 'nsfw', role: 'system', system_prompt: true, content: '' },
      { identifier: 'dialogueExamples', marker: true, system_prompt: true },
      { identifier: 'jailbreak', role: 'system', system_prompt: true, content: '' },
      { identifier: 'chatHistory', marker: true, system_prompt: true },
      { identifier: 'worldInfoAfter', marker: true, system_prompt: true },
      { identifier: 'worldInfoBefore', marker: true, system_prompt: true },
      { identifier: 'enhanceDefinitions', role: 'system', system_prompt: true, content: '' },
      { identifier: 'charDescription', marker: true, system_prompt: true },
      { identifier: 'charPersonality', marker: true, system_prompt: true },
      { identifier: 'scenario', marker: true, system_prompt: true },
      { identifier: 'personaDescription', marker: true, system_prompt: true },
    ],
    prompt_order: [
      { character_id: 100001, order: ORDER.map((identifier) => ({ identifier, enabled: true })) },
    ],
    new_chat_prompt: '[Start a new Chat]',
    new_example_chat_prompt: '[Example Chat]',
    names_behavior: 0,
    wi_format: '{0}',
    personality_format: '{{personality}}',
    scenario_format: '{{scenario}}',
    openai_max_context: 100000,
    openai_max_tokens: 300,
  },
};

const PERSONA_DESCRIPTION =
  'PDESC[char={{char}}|description={{description}}|persona={{persona}}|scenario={{scenario}}]';

function probeInput(persona: Partial<AssemblePersona>, extra: Partial<AssembleInputV2> = {}) {
  const input: AssembleInputV2 = {
    chatId: 'probe',
    model: 'newtavern-golden-mock',
    provider: 'openai-chat',
    preset: BASELINE_PRESET,
    character: {
      id: 'quill',
      name: 'Quill',
      data: {
        name: 'Quill',
        description: 'DESC[persona={{persona}}|user={{user}}|char={{char}}|scenario={{scenario}}]',
        personality: 'PERS[persona={{persona}}]',
        scenario: 'SCEN[persona={{persona}}|description={{description}}]',
        mes_example: '<START>\n{{user}}: EX[persona={{persona}}]\n{{char}}: ok',
        creator_notes: 'NewTavern 合成 fixture，CC0。Synthetic CC0 fixture.',
        system_prompt: 'SYS[persona={{persona}}]',
        post_history_instructions: 'PHI[persona={{persona}}]',
      },
    },
    persona: { id: 'wren', name: 'Wren', description: PERSONA_DESCRIPTION, ...persona },
    history: [
      {
        id: 'first',
        role: 'assistant',
        name: 'Quill',
        parts: [{ type: 'text', text: 'FIRST[persona={{persona}}|description={{description}}]' }],
      },
      {
        id: 'usermsg',
        role: 'user',
        name: 'Wren',
        parts: [{ type: 'text', text: 'USERMSG[persona={{persona}}]' }],
      },
      {
        id: 'now',
        role: 'user',
        name: 'Wren',
        parts: [{ type: 'text', text: 'NOW[persona={{persona}}]' }],
      },
    ],
    lorebooks: [],
    wiSettings: makeSettings(),
    characterDepthPrompt: { text: 'DP[persona={{persona}}]', depth: 1, role: 0 },
    variables: { chat: {}, global: {} },
    messageCount: 3,
    providerCaps: { caching: 'none', systemInMessages: true, prefill: true },
    rng: { seed: 'probe' },
    layoutMode: 'strict',
    ...extra,
  };
  return input;
}

function messages(ir: PromptIR) {
  return ir.segments.map((segment) => ({
    role: segment.role,
    content: segment.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''),
    ...(segment.name === undefined ? {} : { name: segment.name }),
  }));
}

// ── ST 实录（新宏引擎）的公共部分
const PDESC_BASE = 'PDESC[char=Quill|description=|persona=|scenario=]';
const DESC_BASE = 'DESC[persona=|user=Wren|char=Quill|scenario=]';
const SCEN_BASE = 'SCEN[persona=|description=]';
const PDESC_FULL = `PDESC[char=Quill|description=${DESC_BASE}|persona=${PDESC_BASE}|scenario=${SCEN_BASE}]`;

const sys = (content: string) => ({ role: 'system', content });
const HEAD = [
  sys(DESC_BASE),
  sys('PERS[persona=]'),
  sys(SCEN_BASE),
  sys('[Example Chat]'),
  { role: 'system', content: 'EX[persona=]', name: 'example_user' },
  { role: 'system', content: 'ok', name: 'example_assistant' },
  sys('[Start a new Chat]'),
  { role: 'assistant', content: `FIRST[persona=${PDESC_BASE}|description=${DESC_BASE}]` },
];
const USERMSG = { role: 'user', content: `USERMSG[persona=${PDESC_BASE}]` };
const TAIL = [
  sys('DP[persona=]'),
  { role: 'user', content: `NOW[persona=${PDESC_BASE}]` },
  sys('PHI[persona=]'),
];

describe('卡类宏的展开（ST 1.18 新宏引擎实录）', () => {
  it('probe-new-inprompt：卡字段里为空；档案描述、聊天消息里展开为 baseChatReplace 值', () => {
    const { ir } = assemblePrompt(probeInput({ position: 'in_prompt' }));
    expect(messages(ir)).toEqual([
      sys('SYS[persona=]'),
      sys(PDESC_FULL),
      ...HEAD,
      USERMSG,
      ...TAIL,
    ]);
  });

  it('probe-new-atdepth：AT_DEPTH 注入的档案描述同样完整展开', () => {
    const { ir } = assemblePrompt(probeInput({ position: 'at_depth', depth: 2, role: 0 }));
    expect(messages(ir)).toEqual([
      sys('SYS[persona=]'),
      ...HEAD,
      sys(PDESC_FULL),
      USERMSG,
      ...TAIL,
    ]);
  });

  it('probe-new-topan：TOP_AN 拼进作者注释的档案描述同样完整展开', () => {
    const { ir } = assemblePrompt(
      probeInput(
        { position: 'top_an' },
        {
          authorsNote: {
            text: 'AN[persona={{persona}}]',
            position: 0,
            depth: 4,
            role: 0,
            interval: 1,
          },
        },
      ),
    );
    expect(messages(ir)).toEqual([
      sys('SYS[persona=]'),
      sys(`${PDESC_FULL}\nAN[persona=${PDESC_BASE}]`),
      ...HEAD,
      USERMSG,
      ...TAIL,
    ]);
  });

  it('{{charPrompt}} / {{charDepthPrompt}} / {{creatorNotes}} 取 baseChatReplace 值；卡覆盖里的 {{original}} 仍可用', () => {
    const input = probeInput({ position: 'none' });
    const data = input.character!.data;
    data.system_prompt = '{{original}} / SYS[persona={{persona}}]';
    data.creator_notes = '  NOTES[persona={{persona}}|char={{char}}]  ';
    input.preset = {
      ...BASELINE_PRESET,
      data: {
        ...BASELINE_PRESET.data,
        prompts: BASELINE_PRESET.data.prompts.map((prompt) =>
          prompt.identifier === 'nsfw'
            ? { ...prompt, content: '{{charPrompt}}|{{charDepthPrompt}}|{{creatorNotes}}' }
            : prompt,
        ),
      },
    };
    const out = messages(assemblePrompt(input).ir);
    expect(out[0]).toEqual(
      sys(
        "Write Quill's next reply in a fictional chat between Quill and Wren. Keep it grounded and concrete. / SYS[persona=]",
      ),
    );
    expect(out).toContainEqual(
      sys('{{original}} / SYS[persona=]|DP[persona=]|NOTES[persona=|char=Quill]'),
    );
  });

  it('卡覆盖内容在 baseChatReplace 阶段含易变宏时，main 段仍标记为易变', () => {
    const input = probeInput({ position: 'none' });
    input.character!.data.system_prompt = 'Now is {{time}}.';
    const main = assemblePrompt(input).ir.segments[0];
    expect(main?.volatile).toBe(true);
  });
});
