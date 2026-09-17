import { describe, expect, it } from 'vitest';

import {
  catalogModels,
  defaultMaxTokens,
  globMatch,
  loadCatalog,
  lookupCapabilities,
} from './catalog.js';

describe('catalog.json', () => {
  it('是 version 2 且没有悬空 $schema 引用', () => {
    const c = loadCatalog();
    expect(c.version).toBe(2);
    expect((c as unknown as Record<string, unknown>).$schema).toBeUndefined();
    expect(Array.isArray((c as unknown as { _notes?: unknown })._notes)).toBe(true);
  });

  it('defaults 覆盖 ModelCapabilities 全部必填字段', () => {
    const d = loadCatalog().defaults;
    for (const key of [
      'thinking',
      'caching',
      'systemInMessages',
      'reasoningRoundtrip',
      'imageIn',
      'imageOut',
      'documentIn',
      'tools',
      'structuredOutput',
      'prefill',
      'maxContext',
      'maxOutput',
    ]) {
      expect(d).toHaveProperty(key);
    }
  });

  it('每个 models 条目的 provider 都在 providers 里登记', () => {
    const c = loadCatalog();
    for (const m of c.models) expect(Object.keys(c.providers)).toContain(m.provider);
  });
});

describe('globMatch', () => {
  it('* 通配且大小写不敏感', () => {
    expect(globMatch('claude-fable-5*', 'claude-fable-5-1')).toBe(true);
    expect(globMatch('claude-fable-5*', 'CLAUDE-FABLE-5')).toBe(true);
    expect(globMatch('gpt-5*', 'gpt-4o')).toBe(false);
    expect(globMatch('gemini-2.5-pro*', 'gemini-2X5-pro')).toBe(false);
  });
});

describe('lookupCapabilities', () => {
  it('defaults → providers → models 逐层合并', () => {
    const caps = lookupCapabilities('anthropic', 'claude-opus-5');
    expect(caps.thinking).toBe('adaptive');
    expect(caps.systemInMessages).toBe(true);
    expect(caps.prefill).toBe(false);
    expect(caps.caching).toBe('breakpoints');
    expect(caps.maxBreakpoints).toBe(4);
    expect(caps.reasoningRoundtrip).toBe('signature');
    expect(caps.maxOutput).toBe(128000);
  });

  it('未登记的模型落到 provider 默认值', () => {
    const caps = lookupCapabilities('anthropic', 'claude-未来-9');
    expect(caps.thinking).toBe('none');
    expect(caps.maxContext).toBe(200000);
    expect(caps.caching).toBe('breakpoints');
  });

  it('未登记的 provider 落到 defaults', () => {
    expect(lookupCapabilities('nonexistent', 'x')).toMatchObject({
      thinking: 'none',
      caching: 'none',
      maxContext: 32768,
      maxOutput: 4096,
    });
  });

  it('conn.modelOverrides 优先级最高', () => {
    const caps = lookupCapabilities('anthropic', 'claude-opus-5', {
      maxOutput: 8192,
      prefill: true,
    });
    expect(caps.maxOutput).toBe(8192);
    expect(caps.prefill).toBe(true);
    expect(caps.thinking).toBe('adaptive');
  });

  it('Haiku 4.5 走 budget thinking', () => {
    expect(lookupCapabilities('anthropic', 'claude-haiku-4-5').thinking).toBe('budget');
  });

  it('defaultMaxTokens = min(4096, maxOutput)', () => {
    expect(defaultMaxTokens(lookupCapabilities('anthropic', 'claude-opus-5'))).toBe(4096);
    expect(defaultMaxTokens(lookupCapabilities('nonexistent', 'x'))).toBe(4096);
    expect(defaultMaxTokens({ ...loadCatalog().defaults, maxOutput: 1024 })).toBe(1024);
  });

  it('多模态能力（M4 核对）：imageIn / documentIn', () => {
    const io = (provider: string, model: string) => {
      const c = lookupCapabilities(provider, model);
      return [c.imageIn, c.documentIn];
    };
    for (const model of ['gpt-4o', 'gpt-4.1-mini', 'gpt-5', 'gpt-6', 'o1', 'o3', 'o4-mini']) {
      expect(io('openai-chat', model), model).toEqual([true, true]);
    }
    for (const model of ['o1-mini', 'o1-preview', 'o3-mini']) {
      expect(io('openai-chat', model), model).toEqual([false, false]);
      expect(io('openai-responses', model), model).toEqual([false, false]);
    }
    expect(io('openai-responses', 'gpt-5')).toEqual([true, true]);
    for (const model of ['claude-opus-5', 'claude-haiku-4-5', 'claude-3-opus']) {
      expect(io('anthropic', model), model).toEqual([true, true]);
    }
    for (const model of ['gemini-3-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-flash-image']) {
      expect(io('google', model), model).toEqual([true, true]);
    }
    // GLM 文本模型与 DeepSeek
    expect(io('openai-chat', 'glm-5.3-flash')).toEqual([false, false]);
    expect(io('anthropic', 'glm-5.3-flash')).toEqual([false, false]);
    expect(io('openai-chat', 'deepseek-chat')).toEqual([false, false]);
    expect(io('openai-chat', 'deepseek-reasoner')).toEqual([false, false]);
    // GLM 视觉模型
    expect(lookupCapabilities('openai-chat', 'glm-4.6v').imageIn).toBe(true);
    expect(lookupCapabilities('openai-chat', 'glm-4.6v-flash').imageIn).toBe(true);
  });

  it('多模态能力（M4 核对）：imageOut', () => {
    const out = (provider: string, model: string) => lookupCapabilities(provider, model).imageOut;
    for (const model of [
      'gemini-2.0-flash-preview-image-generation',
      'gemini-2.5-flash-image',
      'gemini-2.5-flash-image-preview',
      'gemini-3-pro-image-preview',
      'gemini-3.1-flash-image',
      'gemini-3.1-flash-lite-image',
      'gemini-9-ultra-image',
    ]) {
      expect(out('google', model), model).toBe(true);
      expect(lookupCapabilities('google', model).thinking, model).toBe('none');
    }
    expect(out('google', 'gemini-3-pro-preview')).toBe(false);
    expect(out('google', 'gemini-2.5-flash')).toBe(false);
    expect(out('openai-chat', 'google/gemini-2.5-flash-image')).toBe(true);
    expect(out('openai-chat', 'openai/gpt-5-image-mini')).toBe(true);
    expect(out('openai-chat', 'gpt-5')).toBe(false);
    for (const model of ['gpt-4o', 'gpt-4.1', 'gpt-5', 'gpt-5.1', 'o3']) {
      expect(out('openai-responses', model), model).toBe(true);
    }
    expect(out('openai-responses', 'o3-mini')).toBe(false);
    expect(out('openai-responses', 'gpt-6')).toBe(false);
    expect(out('anthropic', 'claude-opus-5')).toBe(false);
    expect(catalogModels('openai-responses').some((m) => m.match === 'gpt-image-*')).toBe(false);
  });

  it('catalogModels 可按 provider 过滤', () => {
    const all = catalogModels();
    const anthropic = catalogModels('anthropic');
    expect(anthropic.length).toBeGreaterThan(0);
    expect(anthropic.length).toBeLessThan(all.length);
    expect(anthropic.every((m) => m.provider === 'anthropic')).toBe(true);
  });
});
