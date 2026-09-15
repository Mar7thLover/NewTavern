import type { PromptIR } from '@newtavern/core';
import { describe, expect, it } from 'vitest';

import { lookupCapabilities } from './catalog.js';
import {
  canDisableThinking,
  resolveThinking,
  stEffortToClaude,
  stEffortToGoogle,
  stEffortToOpenAI,
} from './thinking.js';

function irWith(sampling: Record<string, unknown>): PromptIR {
  return {
    model: 'm',
    sampling: sampling as PromptIR['sampling'],
    segments: [],
    cachePlan: { breakpoints: [] },
    meta: {
      chatId: 'c',
      presetId: 'p',
      layoutMode: 'strict',
      activations: [],
      warnings: [],
      tokenEstimate: 0,
    },
  };
}

describe('resolveThinking', () => {
  it('会话覆盖 > ir.sampling.thinking > 预设 reasoningEffort', () => {
    const ir = irWith({ thinking: { effort: 'low' }, reasoningEffort: 'high' });
    expect(resolveThinking(ir, { thinking: { enabled: false } })).toEqual({
      thinking: { enabled: false },
    });
    expect(resolveThinking(ir)).toEqual({ thinking: { effort: 'low' } });
    expect(resolveThinking(irWith({ reasoningEffort: 'high' }))).toEqual({
      thinking: {},
      stEffort: 'high',
    });
  });

  it('空覆盖不算覆盖；auto 与未知 ST 值不产生 stEffort', () => {
    const ir = irWith({ reasoningEffort: 'max' });
    expect(resolveThinking(ir, { thinking: {} }).stEffort).toBe('max');
    expect(resolveThinking(irWith({ reasoningEffort: 'auto' }))).toEqual({ thinking: {} });
    expect(resolveThinking(irWith({ reasoningEffort: 'ultra' }))).toEqual({ thinking: {} });
  });
});

describe('canDisableThinking', () => {
  it('按能力目录：Claude 可关、Fable 不可关、2.5 Flash 可关、2.5 Pro 不可关、无推理模型 false', () => {
    expect(canDisableThinking(lookupCapabilities('anthropic', 'claude-opus-5'))).toBe(true);
    expect(canDisableThinking(lookupCapabilities('anthropic', 'claude-fable-5-1'))).toBe(false);
    expect(canDisableThinking(lookupCapabilities('google', 'gemini-2.5-flash'))).toBe(true);
    expect(canDisableThinking(lookupCapabilities('google', 'gemini-2.5-pro'))).toBe(false);
    expect(canDisableThinking(lookupCapabilities('anthropic', 'claude-3-5-sonnet'))).toBe(false);
  });
});

describe('ST reasoning_effort 映射', () => {
  it('OpenAI：min → gpt-5 minimal / gpt-5.4 none / 其他 low；max → high', () => {
    expect(stEffortToOpenAI('min', 'gpt-5-mini')).toBe('minimal');
    expect(stEffortToOpenAI('min', 'gpt-5.4')).toBe('none');
    expect(stEffortToOpenAI('min', 'o3')).toBe('low');
    expect(stEffortToOpenAI('max', 'gpt-5')).toBe('high');
    expect(stEffortToOpenAI('medium', 'gpt-5')).toBe('medium');
  });

  it('Claude：adaptive 走档位（min → low），budget 按 max_tokens 比例且下限 1024', () => {
    const adaptive = lookupCapabilities('anthropic', 'claude-opus-5');
    expect(stEffortToClaude('min', adaptive, 4096)).toEqual({ effort: 'low' });
    expect(stEffortToClaude('max', adaptive, 4096)).toEqual({ effort: 'max' });
    const budget = lookupCapabilities('anthropic', 'claude-haiku-4-5');
    expect(stEffortToClaude('min', budget, 20000)).toEqual({ budgetTokens: 1024 });
    expect(stEffortToClaude('high', budget, 20000)).toEqual({ budgetTokens: 10000 });
    expect(stEffortToClaude('max', budget, 20000)).toEqual({ budgetTokens: 19000 });
    expect(stEffortToClaude('low', budget, 4096)).toEqual({ budgetTokens: 1024 });
  });

  it('Gemini：3 Pro / 3 Flash 档位，2.5 Flash / Lite / Pro 预算夹取', () => {
    expect(stEffortToGoogle('medium', 'gemini-3-pro-preview', 8192)).toEqual({ effort: 'low' });
    expect(stEffortToGoogle('max', 'gemini-3-pro-preview', 8192)).toEqual({ effort: 'high' });
    expect(stEffortToGoogle('min', 'gemini-3-flash', 8192)).toEqual({ effort: 'minimal' });
    expect(stEffortToGoogle('min', 'gemini-2.5-flash', 8192)).toEqual({ budgetTokens: 0 });
    expect(stEffortToGoogle('max', 'gemini-2.5-flash', 65536)).toEqual({ budgetTokens: 24576 });
    expect(stEffortToGoogle('low', 'gemini-2.5-flash-lite', 1000)).toEqual({ budgetTokens: 512 });
    expect(stEffortToGoogle('min', 'gemini-2.5-pro', 8192)).toEqual({ budgetTokens: 128 });
    expect(stEffortToGoogle('medium', 'gemini-2.5-pro', 8192)).toEqual({ budgetTokens: 2048 });
  });
});
