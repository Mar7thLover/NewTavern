import { describe, expect, it } from 'vitest';

import {
  extractPresetSampling,
  looksLikeStPreset,
  parsePreset,
  presetApiFamily,
  serializePreset,
} from './preset.js';

const presetFixture = {
  chat_completion_source: 'claude',
  temperature: 1,
  frequency_penalty: 0,
  presence_penalty: 0,
  top_p: 0.95,
  top_k: 40,
  openai_max_context: 200000,
  openai_max_tokens: 8192,
  squash_system_messages: false,
  wi_format: '{0}',
  scenario_format: '{{scenario}}',
  personality_format: '{{personality}}',
  continue_prefill: false,
  reasoning_effort: 'high',
  show_thoughts: true,
  some_future_setting: { nested: ['保留'] },
  prompts: [
    {
      name: 'Main Prompt',
      system_prompt: true,
      role: 'system',
      content: '你是 {{char}}。',
      identifier: 'main',
    },
    { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
    {
      identifier: 'a1b2c3',
      name: '文风',
      role: 'user',
      content: '保持第三人称。',
      injection_position: 1,
      injection_depth: 2,
      injection_order: 100,
      forbid_overrides: false,
      custom_prompt_field: 42,
    },
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'a1b2c3', enabled: false },
      ],
    },
  ],
};

describe('ST 预设', () => {
  it('往返 deep-equal，未知字段保留', () => {
    const preset = parsePreset(presetFixture);
    expect(JSON.parse(serializePreset(preset))).toEqual(presetFixture);
  });

  it('抽取采样参数与适配器族', () => {
    const preset = parsePreset(presetFixture);
    expect(extractPresetSampling(preset)).toEqual({
      temperature: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      top_p: 0.95,
      top_k: 40,
      openai_max_context: 200000,
      openai_max_tokens: 8192,
      reasoning_effort: 'high',
    });
    expect(presetApiFamily(preset)).toBe('anthropic');
    expect(presetApiFamily(parsePreset({ chat_completion_source: 'makersuite' }))).toBe('google');
    expect(presetApiFamily(parsePreset({ chat_completion_source: 'openrouter' }))).toBe(
      'openai-chat',
    );
    expect(presetApiFamily(parsePreset({}))).toBeNull();
  });

  it('格式识别与非法输入', () => {
    expect(looksLikeStPreset(presetFixture)).toBe(true);
    expect(looksLikeStPreset({ entries: {} })).toBe(false);
    expect(() => parsePreset([])).toThrow(/必须是对象/);
    expect(() => parsePreset({ prompts: [{ name: '缺 identifier' }] })).toThrow(/ST 预设解析失败/);
  });
});
