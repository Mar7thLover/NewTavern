import { registry, type ProviderRegistry } from '../registry.js';
import type { ProviderAdapter } from '../types.js';

import { anthropicAdapter } from './anthropic.js';
import { googleAdapter } from './google.js';
import { openaiChatAdapter } from './openai-chat.js';
import { openaiResponsesAdapter } from './openai-responses.js';

export * from './anthropic.js';
export * from './google.js';
export * from './openai-chat.js';
export * from './openai-responses.js';

/** 内置适配器清单（四类协议，见 docs/PLAN.md §3.1） */
export const builtinAdapters: ProviderAdapter[] = [
  openaiChatAdapter,
  openaiResponsesAdapter,
  anthropicAdapter,
  googleAdapter,
];

/** 把内置适配器注册进 registry（服务端启动时调用一次） */
export function registerBuiltinAdapters(target: ProviderRegistry = registry): ProviderRegistry {
  for (const adapter of builtinAdapters) target.register(adapter);
  return target;
}
