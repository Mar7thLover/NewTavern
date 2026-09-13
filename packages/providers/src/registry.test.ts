import { describe, expect, it } from 'vitest';

import { ProviderRegistry } from './registry.js';
import type { ProviderAdapter } from './types.js';

const dummy = { id: 'anthropic' } as ProviderAdapter;

describe('ProviderRegistry', () => {
  it('注册后可按 id 获取', () => {
    const reg = new ProviderRegistry();
    reg.register(dummy);
    expect(reg.get('anthropic')).toBe(dummy);
    expect(reg.has('anthropic')).toBe(true);
    expect(reg.list()).toHaveLength(1);
  });

  it('未注册时抛出', () => {
    const reg = new ProviderRegistry();
    expect(() => reg.get('google')).toThrow('未注册');
  });
});
