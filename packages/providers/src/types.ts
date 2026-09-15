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
  /**
   * 能否关闭推理（`thinking: { enabled: false }`）。按各家 API 语义在目录里标注：
   * Anthropic 发 `thinking:{type:'disabled'}`（Fable/Mythos 5 系列始终推理，不可关）；
   * OpenAI 系只有档位里有 `none` 的模型可关；Gemini 2.5 Flash 系 thinkingBudget=0 可关、Pro 与 3.x 不可关；
   * Z.AI GLM 发 `thinking:{type:'disabled'}`。缺省视为不可关。
   */
  canDisableThinking?: boolean;
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

/**
 * 推理控制的统一表示（会话覆盖 `chat.overrides.thinking`、`ir.sampling.thinking` 共用）。
 * - `enabled: false`：关闭推理，忽略其余字段；模型不支持关闭时适配器给 warning 并按默认处理
 * - `effort`：档位（adaptive / effort / level 型模型），取值见能力 `effortLevels`
 * - `budgetTokens`：预算（budget 型模型）
 * 全部缺省 = 不干预（适配器默认行为）。
 */
export interface ThinkingOptions {
  enabled?: boolean;
  effort?: string;
  budgetTokens?: number;
}

/** buildRequest 的可选参数：由聊天覆盖项（ChatOverrides.thinking）传入 */
export interface BuildOptions {
  thinking?: ThinkingOptions;
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
