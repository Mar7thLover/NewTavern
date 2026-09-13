import type { PromptIR } from '@newtavern/core';

/**
 * 提供商适配层统一接口与事件模型。见 docs/PLAN.md §3.1。
 */

export type ProviderId = 'openai-chat' | 'openai-responses' | 'anthropic' | 'google';

export interface Connection {
  id: string;
  provider: ProviderId;
  /** 用户可见的连接名 */
  label?: string;
  baseUrl: string;
  /** 轮换/故障转移的多 Key 由服务端在发请求时解析注入 */
  apiKey?: string;
  headers?: Record<string, string>;
  proxy?: string;
  /** OpenAI 兼容端点自动识别/用户覆盖的 quirks（developer 角色、reasoning_content、prefill 等） */
  quirks?: Record<string, boolean>;
  /** 按模型覆盖 catalog 能力（合并顺序最后一位） */
  modelOverrides?: Record<string, Partial<ModelCapabilities>>;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
  maxOutput?: number;
}

export interface ModelCapabilities {
  /** Haiku budget / OpenAI effort / Gemini level / Anthropic adaptive */
  thinking: 'none' | 'budget' | 'effort' | 'level' | 'adaptive';
  effortLevels?: string[];
  caching: 'none' | 'prefix-auto' | 'breakpoints' | 'explicit-object';
  cacheMinTokens?: number;
  maxBreakpoints?: number;
  systemInMessages: boolean;
  reasoningRoundtrip: 'none' | 'signature' | 'encrypted' | 'thoughtSignature';
  imageIn: boolean;
  imageOut: boolean;
  documentIn: boolean;
  tools: boolean;
  structuredOutput: boolean;
  prefill: boolean;
  maxContext: number;
  maxOutput: number;
}

export interface ProviderRequest {
  method: 'POST';
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** buildRequest 过程中被丢弃/降级的参数说明，供检查器展示 */
  warnings?: string[];
}

/** buildRequest 的可选参数：由聊天覆盖项（ChatOverrides.thinking）传入 */
export interface BuildOptions {
  thinking?: { effort?: string; budgetTokens?: number };
}

export type ProviderErrorKind =
  'auth' | 'rateLimit' | 'overloaded' | 'contextLength' | 'filter' | 'invalid' | 'network';

export interface ProviderError {
  kind: ProviderErrorKind;
  message: string;
  status?: number;
  retryable: boolean;
  detail?: unknown;
}

/** 归一化流式事件 */
export type GenEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'reasoning.opaque'; provider: string; model: string; payload: unknown }
  | { type: 'image'; mime: string; data: string }
  | { type: 'tool.call'; id: string; name: string; argsDelta: string }
  | {
      type: 'usage';
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
    }
  | {
      type: 'stop';
      reason: 'end' | 'length' | 'refusal' | 'filter' | 'tool' | 'abort';
      detail?: string;
    }
  | { type: 'error'; error: ProviderError; retryable: boolean };

export interface ProviderAdapter {
  id: ProviderId;
  listModels(conn: Connection): Promise<ModelInfo[]>;
  /** catalog.json + 远端探测 + 用户覆盖 + 端点 quirks 合并 */
  capabilities(model: string, conn: Connection): ModelCapabilities;
  /** 纯函数：web 端可预览、可做黄金测试 */
  buildRequest(ir: PromptIR, conn: Connection, model: string, opts?: BuildOptions): ProviderRequest;
  stream(conn: Connection, req: ProviderRequest, signal: AbortSignal): AsyncIterable<GenEvent>;
  countTokens?(conn: Connection, req: ProviderRequest): Promise<number>;
  normalizeError(e: unknown): ProviderError;
}
