import type { ProviderAdapter, ProviderId } from './types.js';

/**
 * 适配器注册表：按 ProviderId 查找适配器。
 * 具体适配器（openai-chat / openai-responses / anthropic / google）在 M2 实现后注册。
 */
export class ProviderRegistry {
  private readonly adapters = new Map<ProviderId, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: ProviderId): ProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`未注册的提供商适配器：${id}`);
    }
    return adapter;
  }

  has(id: ProviderId): boolean {
    return this.adapters.has(id);
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }
}

export const registry = new ProviderRegistry();
