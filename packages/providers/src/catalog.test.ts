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

  it('catalogModels 可按 provider 过滤', () => {
    const all = catalogModels();
    const anthropic = catalogModels('anthropic');
    expect(anthropic.length).toBeGreaterThan(0);
    expect(anthropic.length).toBeLessThan(all.length);
    expect(anthropic.every((m) => m.provider === 'anthropic')).toBe(true);
  });
});
