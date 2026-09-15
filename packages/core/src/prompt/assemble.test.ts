import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../tokenizer.js';
import { type WISettings } from '../worldinfo/types.js';
import {
  assemblePrompt,
  DEFAULT_PRESET,
  NO_PRESET,
  type AssembleCharacter,
  type AssembleHistoryNode,
  type AssembleInputV2,
  type AssemblePersona,
  type AssemblePreset,
} from './assemble.js';
import { type PromptIR, type Segment } from './ir.js';
import { type LayoutProviderCaps } from './layout/index.js';

/** 组装测试只关心段序，世界书全关 */
export const EMPTY_WI_SETTINGS: WISettings = {
  scanDepth: 2,
  budgetTokens: 0,
  budgetCap: 0,
  recursive: false,
  caseSensitive: false,
  matchWholeWords: false,
  useGroupScoring: false,
  maxRecursionSteps: 0,
  minActivations: 0,
  minActivationsDepthMax: 0,
  includeNames: true,
};

export const TEST_CAPS: LayoutProviderCaps = {
  caching: 'breakpoints',
  maxBreakpoints: 4,
  systemInMessages: true,
  prefill: true,
};

// ───────────── fixture：贴近真实 ST 预设形状 ─────────────

function stPreset(overrides: Record<string, unknown> = {}): AssemblePreset {
  return {
    id: 'preset-1',
    format: 'st-openai',
    data: {
      prompts: [
        {
          identifier: 'main',
          name: 'Main Prompt',
          system_prompt: true,
          role: 'system',
          content: "Write {{char}}'s next reply.",
        },
        {
          identifier: 'nsfw',
          name: 'Auxiliary Prompt',
          system_prompt: true,
          role: 'system',
          content: 'Anything goes.',
        },
        {
          identifier: 'dialogueExamples',
          name: 'Chat Examples',
          system_prompt: true,
          marker: true,
        },
        {
          identifier: 'jailbreak',
          name: 'Post-History Instructions',
          system_prompt: true,
          role: 'system',
          content: 'Stay in character as {{char}}.',
        },
        { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
        { identifier: 'worldInfoBefore', name: 'World Info (before)', marker: true },
        {
          identifier: 'charDescription',
          name: 'Char Description',
          system_prompt: true,
          marker: true,
        },
        {
          identifier: 'charPersonality',
          name: 'Char Personality',
          system_prompt: true,
          marker: true,
        },
        { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
        {
          identifier: 'personaDescription',
          name: 'Persona Description',
          system_prompt: true,
          marker: true,
        },
        {
          identifier: 'a1b2-note',
          name: 'Author Note',
          system_prompt: false,
          role: 'system',
          content: '[Keep replies under 200 words.]',
          injection_position: 1,
          injection_depth: 1,
          injection_order: 50,
        },
        {
          identifier: 'c3d4-style',
          name: 'Style',
          system_prompt: false,
          role: 'user',
          content: '[Style: noir.]',
          injection_position: 1,
          injection_depth: 0,
          injection_order: 200,
        },
        {
          identifier: 'e5f6-empty',
          name: 'Empty',
          system_prompt: false,
          role: 'system',
          content: '',
        },
      ],
      prompt_order: [
        // 100000 列表存在但应被 100001 覆盖
        { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
        {
          character_id: 100001,
          order: [
            { identifier: 'main', enabled: true },
            { identifier: 'worldInfoBefore', enabled: true },
            { identifier: 'charDescription', enabled: true },
            { identifier: 'charPersonality', enabled: true },
            { identifier: 'scenario', enabled: true },
            { identifier: 'personaDescription', enabled: true },
            { identifier: 'nsfw', enabled: false },
            { identifier: 'dialogueExamples', enabled: true },
            { identifier: 'chatHistory', enabled: true },
            { identifier: 'jailbreak', enabled: true },
            { identifier: 'a1b2-note', enabled: true },
            { identifier: 'c3d4-style', enabled: true },
            { identifier: 'e5f6-empty', enabled: true },
            { identifier: 'does-not-exist', enabled: true },
          ],
        },
      ],
      personality_format: "[{{char}}'s personality: {{personality}}]",
      scenario_format: '[Circumstances: {{scenario}}]',
      new_chat_prompt: '[Start a new Chat]',
      new_example_chat_prompt: '[Example Chat]',
      squash_system_messages: false,
      temperature: 0.9,
      top_p: 0.95,
      frequency_penalty: 0.2,
      openai_max_tokens: 500,
      openai_max_context: 8000,
      ...overrides,
    },
  };
}

const character: AssembleCharacter = {
  id: 'char-1',
  name: 'Seraphine',
  data: {
    description: 'A {{char}} of few words.',
    personality: 'stoic',
    scenario: 'A rainy rooftop.',
    mes_example: '<START>\n{{user}}: Hi\n{{char}}: ...\n<START>\n{{user}}: Again?\n{{char}}: Mm.',
  },
};

const persona: AssemblePersona = {
  id: 'persona-1',
  name: 'Ren',
  description: 'Ren is a tired detective.',
};

const history: AssembleHistoryNode[] = [
  { id: 'n1', role: 'assistant', name: 'Seraphine', parts: [{ type: 'text', text: 'Rain taps.' }] },
  { id: 'n2', role: 'user', name: 'Ren', parts: [{ type: 'text', text: 'I light a cigarette.' }] },
  {
    id: 'n3',
    role: 'assistant',
    name: 'Seraphine',
    parts: [
      { type: 'text', text: 'She watches the smoke.' },
      { type: 'image', assetId: 'asset-1', mime: 'image/png' },
    ],
    reasoning: {
      opaque: [{ provider: 'anthropic', model: 'claude-opus-5', payload: { signature: 'sig' } }],
    },
  },
  { id: 'nx', role: 'user', parts: [{ type: 'text', text: '被隐藏的' }], isHidden: true },
  { id: 'n4', role: 'user', name: 'Ren', parts: [{ type: 'text', text: 'What now, {{char}}?' }] },
];

/** v2 必填字段的中性默认值：世界书为空、无变量、无正则、strict 布局 */
export function baseInput(overrides: Partial<AssembleInputV2> = {}): AssembleInputV2 {
  return {
    chatId: 'chat-1',
    model: 'claude-opus-5',
    provider: 'anthropic',
    preset: stPreset(),
    character,
    persona,
    history,
    lorebooks: [],
    wiSettings: EMPTY_WI_SETTINGS,
    variables: { chat: {}, global: {} },
    messageCount: history.filter((node) => node.isHidden !== true).length,
    providerCaps: TEST_CAPS,
    rng: { seed: 'seed' },
    ...overrides,
  };
}

/** M2 的断言都针对 `PromptIR`；v2 返回 `AssembleResult`，这里取出 ir */
function assembleIr(input: AssembleInputV2): PromptIR {
  return assemblePrompt(input).ir;
}

function ids(ir: PromptIR): string[] {
  return ir.segments.map((segment) => segment.id);
}

function find(ir: PromptIR, id: string): Segment {
  const segment = ir.segments.find((item) => item.id === id);
  if (!segment) throw new Error(`未找到段 ${id}`);
  return segment;
}

function textOf(segment: Segment): string {
  return segment.parts
    .filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

// ───────────── 段序与基本属性 ─────────────

describe('assemblePrompt 段序', () => {
  const ir = assembleIr(baseInput());

  it('按 prompt_order（100001 优先）展开，跳过禁用/缺失/空内容/未实现标记', () => {
    expect(ids(ir)).toEqual([
      'preset:main',
      'character:description',
      'character:personality',
      'character:scenario',
      'persona',
      'preset:newExampleChat',
      'character:mes_example',
      'character:mes_example#1',
      'preset:newExampleChat#1',
      'character:mes_example#2',
      'character:mes_example#3',
      'preset:newMainChat',
      'history:n1',
      'history:n2',
      'history:n3',
      'injection:a1b2-note',
      'history:n4',
      'injection:c3d4-style',
      'preset:jailbreak',
    ]);
    // nsfw 被禁用、e5f6-empty 内容为空、does-not-exist 不存在、worldInfoBefore 留到 M3
    expect(ids(ir)).not.toContain('preset:nsfw');
    expect(ids(ir)).not.toContain('preset:e5f6-empty');
    expect(ids(ir)).not.toContain('preset:worldInfoBefore');
  });

  it('角色卡字段走格式串并做宏替换', () => {
    expect(textOf(find(ir, 'preset:main'))).toBe("Write Seraphine's next reply.");
    expect(textOf(find(ir, 'character:description'))).toBe('A Seraphine of few words.');
    expect(textOf(find(ir, 'character:personality'))).toBe("[Seraphine's personality: stoic]");
    expect(textOf(find(ir, 'character:scenario'))).toBe('[Circumstances: A rainy rooftop.]');
    expect(textOf(find(ir, 'persona'))).toBe('Ren is a tired detective.');
  });

  // ST setOpenAIMessageExamples → parseExampleIntoIndividual：块内再按发言人拆成独立消息，
  // role 恒为 system，name 为 example_user / example_assistant（M2 的「整块一段」偏差在 M3 纠正）
  it('mes_example 按 <START> 切块，块前插 [Example Chat]，块内按发言人拆成独立消息', () => {
    expect(textOf(find(ir, 'preset:newExampleChat'))).toBe('[Example Chat]');
    expect(textOf(find(ir, 'character:mes_example'))).toBe('Hi');
    expect(find(ir, 'character:mes_example').name).toBe('example_user');
    expect(textOf(find(ir, 'character:mes_example#1'))).toBe('...');
    expect(find(ir, 'character:mes_example#1').name).toBe('example_assistant');
    expect(textOf(find(ir, 'character:mes_example#2'))).toBe('Again?');
    expect(textOf(find(ir, 'character:mes_example#3'))).toBe('Mm.');
  });

  it('role / origin / anchor / stability 正确', () => {
    expect(find(ir, 'preset:main')).toMatchObject({
      role: 'system',
      origin: { kind: 'preset', ref: 'main' },
      anchor: { slot: 'system', order: 0 },
      stability: 'static',
    });
    expect(find(ir, 'character:description').origin).toEqual({
      kind: 'character',
      ref: 'description',
    });
    expect(find(ir, 'persona').origin).toEqual({ kind: 'persona' });
    // names_behavior 缺省 DEFAULT(0)：ST 单人聊天里既不写 name 字段也不给正文加前缀
    expect(find(ir, 'history:n1').name).toBeUndefined();
    expect(find(ir, 'history:n1')).toMatchObject({
      role: 'assistant',
      origin: { kind: 'history', ref: 'n1' },
      anchor: { slot: 'history', order: 0 },
      stability: 'history',
    });
    // 最后一条 user 是本轮输入
    expect(find(ir, 'history:n4')).toMatchObject({
      role: 'user',
      origin: { kind: 'user_input', ref: 'n4' },
      stability: 'turn',
    });
    expect(find(ir, 'preset:jailbreak').anchor).toEqual({ slot: 'system', order: 12 });
  });

  it('隐藏节点被剔除；历史文本也做宏替换；非文本 part 原样保留', () => {
    expect(ids(ir)).not.toContain('history:nx');
    expect(textOf(find(ir, 'history:n4'))).toBe('What now, Seraphine?');
    expect(find(ir, 'history:n3').parts).toContainEqual({
      type: 'image',
      assetId: 'asset-1',
      mime: 'image/png',
    });
  });

  it('深度注入按 depth 落点，stability=turn，role 取自 prompt', () => {
    expect(find(ir, 'injection:a1b2-note')).toMatchObject({
      role: 'system',
      origin: { kind: 'injection', ref: 'a1b2-note' },
      anchor: { slot: 'history', depth: 1, order: 50 },
      stability: 'turn',
    });
    expect(find(ir, 'injection:c3d4-style')).toMatchObject({
      role: 'user',
      anchor: { slot: 'history', depth: 0, order: 200 },
    });
  });

  it('采样参数从预设键映射', () => {
    expect(ir.sampling).toEqual({
      temperature: 0.9,
      topP: 0.95,
      frequencyPenalty: 0.2,
      maxTokens: 500,
    });
  });

  it('cachePlan 断点 = 最后一个 static 段 + 倒数第二条历史段', () => {
    expect(ir.cachePlan).toEqual({ breakpoints: [14, 18] });
    expect(ir.segments[14]?.id).toBe('history:n3');
    expect(ir.segments[18]?.id).toBe('preset:jailbreak');
  });

  it('meta 与 tokenEstimate', () => {
    expect(ir.model).toBe('claude-opus-5');
    expect(ir.meta.chatId).toBe('chat-1');
    expect(ir.meta.presetId).toBe('preset-1');
    expect(ir.meta.layoutMode).toBe('strict');
    expect(ir.meta.activations).toEqual([]);
    expect(ir.meta.warnings).toEqual([]);
    expect(ir.meta.tokenEstimate).toBe(
      ir.segments.reduce((sum, segment) => sum + estimateTokens(textOf(segment)), 0),
    );
    expect(ir.meta.tokenEstimate).toBeGreaterThan(0);
  });
});

// ───────────── 深度注入落点 ─────────────

describe('assemblePrompt 深度注入落点', () => {
  function injectAt(depth: number): string[] {
    const preset = stPreset();
    const prompts = preset.data.prompts as Record<string, unknown>[];
    for (const prompt of prompts) {
      if (prompt.identifier === 'a1b2-note') prompt.injection_depth = depth;
      if (prompt.identifier === 'c3d4-style') prompt.content = '';
    }
    return ids(assembleIr(baseInput({ preset }))).filter(
      (id) => id.startsWith('history:') || id.startsWith('injection:'),
    );
  }

  it('depth 0 落在最后一条之后', () => {
    expect(injectAt(0)).toEqual([
      'history:n1',
      'history:n2',
      'history:n3',
      'history:n4',
      'injection:a1b2-note',
    ]);
  });

  it('depth 2 落在倒数第 2 条之前', () => {
    expect(injectAt(2)).toEqual([
      'history:n1',
      'history:n2',
      'injection:a1b2-note',
      'history:n3',
      'history:n4',
    ]);
  });

  it('depth 超过历史长度时放在历史最前', () => {
    expect(injectAt(99)).toEqual([
      'injection:a1b2-note',
      'history:n1',
      'history:n2',
      'history:n3',
      'history:n4',
    ]);
  });

  it('同 depth 按 injection_order 升序', () => {
    const preset = stPreset();
    const prompts = preset.data.prompts as Record<string, unknown>[];
    for (const prompt of prompts) {
      if (prompt.identifier === 'a1b2-note') {
        prompt.injection_depth = 0;
        prompt.injection_order = 300;
      }
      if (prompt.identifier === 'c3d4-style') {
        prompt.injection_depth = 0;
        prompt.injection_order = 10;
        prompt.role = 'system';
      }
    }
    const tail = ids(assembleIr(baseInput({ preset }))).filter((id) => id.startsWith('injection:'));
    expect(tail).toEqual(['injection:c3d4-style', 'injection:a1b2-note']);
  });
});

// ───────────── 覆盖 ─────────────

describe('assemblePrompt 角色卡覆盖', () => {
  const card: AssembleCharacter = {
    ...character,
    data: {
      ...character.data,
      system_prompt: 'Card main. {{original}}',
      post_history_instructions: 'Card PHI.',
    },
  };

  it('默认用卡的 system_prompt / post_history_instructions，并支持 {{original}}', () => {
    const ir = assembleIr(baseInput({ character: card }));
    expect(textOf(find(ir, 'preset:main'))).toBe("Card main. Write Seraphine's next reply.");
    expect(textOf(find(ir, 'preset:jailbreak'))).toBe('Card PHI.');
  });

  it('preferCharacterPrompt=false 时不覆盖', () => {
    const ir = assembleIr(
      baseInput({ character: card, options: { preferCharacterPrompt: false } }),
    );
    expect(textOf(find(ir, 'preset:main'))).toBe("Write Seraphine's next reply.");
    expect(textOf(find(ir, 'preset:jailbreak'))).toBe('Stay in character as Seraphine.');
  });

  it('forbid_overrides 的 prompt 不被覆盖', () => {
    const preset = stPreset();
    const prompts = preset.data.prompts as Record<string, unknown>[];
    for (const prompt of prompts) {
      if (prompt.identifier === 'main') prompt.forbid_overrides = true;
    }
    const ir = assembleIr(baseInput({ preset, character: card }));
    expect(textOf(find(ir, 'preset:main'))).toBe("Write Seraphine's next reply.");
    expect(textOf(find(ir, 'preset:jailbreak'))).toBe('Card PHI.');
  });

  it('nsfw 不参与覆盖', () => {
    const preset = stPreset();
    const order = (preset.data.prompt_order as { character_id: number; order: unknown[] }[])[1];
    (order?.order as { identifier: string; enabled: boolean }[])[6] = {
      identifier: 'nsfw',
      enabled: true,
    };
    const ir = assembleIr(baseInput({ preset, character: card }));
    expect(textOf(find(ir, 'preset:nsfw'))).toBe('Anything goes.');
  });
});

// ───────────── squash ─────────────

describe('assemblePrompt squash_system_messages', () => {
  it('false 时不合并', () => {
    const ir = assembleIr(baseInput({ preset: stPreset({ squash_system_messages: false }) }));
    expect(ir.segments).toHaveLength(19);
  });

  it('true 时合并相邻 system 段（\\n 连接，id 取首段），分隔段与带 name 的段不参与', () => {
    const ir = assembleIr(baseInput({ preset: stPreset({ squash_system_messages: true }) }));
    expect(ids(ir)).toEqual([
      'preset:main',
      'preset:newExampleChat',
      'character:mes_example',
      'character:mes_example#1',
      'preset:newExampleChat#1',
      'character:mes_example#2',
      'character:mes_example#3',
      'preset:newMainChat',
      'history:n1',
      'history:n2',
      'history:n3',
      'injection:a1b2-note',
      'history:n4',
      'injection:c3d4-style',
      'preset:jailbreak',
    ]);
    expect(textOf(find(ir, 'preset:main'))).toBe(
      [
        "Write Seraphine's next reply.",
        'A Seraphine of few words.',
        "[Seraphine's personality: stoic]",
        '[Circumstances: A rainy rooftop.]',
        'Ren is a tired detective.',
      ].join('\n'),
    );
  });
});

// ───────────── 历史裁剪 ─────────────

describe('assemblePrompt 历史裁剪', () => {
  it('超预算时从最早的历史段开始丢，并记 warning', () => {
    const full = assembleIr(baseInput());
    const n1Tokens = estimateTokens(textOf(find(full, 'history:n1')));
    const ir = assembleIr(
      baseInput({ options: { maxContextTokens: 500 + full.meta.tokenEstimate - n1Tokens } }),
    );
    expect(ids(ir)).not.toContain('history:n1');
    expect(ids(ir)).toContain('history:n2');
    expect(ir.meta.warnings).toEqual(['上下文预算不足，已丢弃最早的 1 条历史消息']);
  });

  it('极端预算下保留全部非历史段与最后一条 user', () => {
    const ir = assembleIr(baseInput({ options: { maxContextTokens: 501 } }));
    expect(ids(ir)).toEqual([
      'preset:main',
      'character:description',
      'character:personality',
      'character:scenario',
      'persona',
      'preset:newExampleChat',
      'character:mes_example',
      'character:mes_example#1',
      'preset:newExampleChat#1',
      'character:mes_example#2',
      'character:mes_example#3',
      'preset:newMainChat',
      'injection:a1b2-note',
      'history:n4',
      'injection:c3d4-style',
      'preset:jailbreak',
    ]);
    expect(ir.meta.warnings[0]).toContain('已丢弃最早的 3 条历史消息');
  });
});

// ───────────── 推理块回传 ─────────────

describe('assemblePrompt 推理块', () => {
  it('provider+model 匹配时放回 parts 开头', () => {
    const ir = assembleIr(baseInput());
    expect(find(ir, 'history:n3').parts[0]).toEqual({
      type: 'reasoning_opaque',
      provider: 'anthropic',
      model: 'claude-opus-5',
      payload: { signature: 'sig' },
    });
    expect(ir.meta.warnings).toEqual([]);
  });

  it('模型切换时丢弃并记一条 warning', () => {
    const ir = assembleIr(baseInput({ model: 'claude-sonnet-5' }));
    expect(find(ir, 'history:n3').parts.some((part) => part.type === 'reasoning_opaque')).toBe(
      false,
    );
    expect(ir.meta.warnings).toEqual(['部分推理块因 provider/模型切换被丢弃']);
  });
});

// ───────────── 默认预设与 layoutMode ─────────────

describe('assemblePrompt 默认预设', () => {
  it('preset=null 时启用 DEFAULT_PRESET', () => {
    const ir = assembleIr(baseInput({ preset: null }));
    expect(ir.meta.presetId).toBe('builtin:default');
    expect(DEFAULT_PRESET.id).toBe('builtin:default');
    expect(ids(ir)).toEqual([
      'preset:main',
      'character:description',
      'character:personality',
      'character:scenario',
      'persona',
      'preset:newExampleChat',
      'character:mes_example',
      'character:mes_example#1',
      'preset:newExampleChat#1',
      'character:mes_example#2',
      'character:mes_example#3',
      'history:n1',
      'history:n2',
      'history:n3',
      'history:n4',
    ]);
    // 内置 main 是中英双语且宏可用
    const main = textOf(find(ir, 'preset:main'));
    expect(main).toContain('Seraphine');
    expect(main).toContain('Ren');
    expect(main.split('\n')).toHaveLength(4);
    expect(ir.sampling).toEqual({ temperature: 1, maxTokens: 4096 });
  });

  it('无角色卡与 Persona 时只剩预设与历史段', () => {
    const ir = assembleIr(baseInput({ preset: null, character: null, persona: null }));
    expect(ids(ir)).toEqual([
      'preset:main',
      'history:n1',
      'history:n2',
      'history:n3',
      'history:n4',
    ]);
  });

  it('NO_PRESET：没有主提示词，其余段与内置预设一致，采样只有 temperature', () => {
    const withDefault = assembleIr(baseInput({ preset: null }));
    const ir = assembleIr(baseInput({ preset: NO_PRESET }));
    expect(ir.meta.presetId).toBe('builtin:none');
    expect(ids(ir)).not.toContain('preset:main');
    expect(ids(ir)).toEqual(ids(withDefault).filter((id) => id !== 'preset:main'));
    expect(ir.sampling).toEqual({ temperature: 1 });
    // 不改变 DEFAULT_PRESET 本身
    expect(
      (DEFAULT_PRESET.data.prompts as { identifier: string }[]).some(
        (p) => p.identifier === 'main',
      ),
    ).toBe(true);
  });

  it('layoutMode 原样写入 meta', () => {
    expect(assembleIr(baseInput({ layoutMode: 'cache-aware' })).meta.layoutMode).toBe(
      'cache-aware',
    );
    expect(assembleIr(baseInput({ layoutMode: 'strict' })).meta.layoutMode).toBe('strict');
  });

  it('空历史时不产生历史段，cachePlan 只有 static 断点', () => {
    const ir = assembleIr(baseInput({ preset: null, history: [] }));
    expect(ids(ir).filter((id) => id.startsWith('history:'))).toEqual([]);
    expect(ir.cachePlan.breakpoints).toEqual([ir.segments.length - 1]);
  });
});

// ───────────── 易变宏传播 ─────────────

describe('assemblePrompt volatile', () => {
  it('含 {{time}} 的段被标记 volatile', () => {
    const preset = stPreset();
    const prompts = preset.data.prompts as Record<string, unknown>[];
    for (const prompt of prompts) {
      if (prompt.identifier === 'main') prompt.content = '现在是 {{time}}。';
    }
    const ir = assembleIr(baseInput({ preset, options: { now: new Date(2026, 8, 13, 20, 5) } }));
    expect(find(ir, 'preset:main')).toMatchObject({ volatile: true });
    expect(textOf(find(ir, 'preset:main'))).toBe('现在是 8:05 PM。');
    expect(find(ir, 'character:description').volatile).toBeUndefined();
  });
});
