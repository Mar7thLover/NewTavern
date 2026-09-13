/**
 * 提示词中间表示（PromptIR）：组装流水线的产物，适配器据此渲染原生请求。
 * 见 docs/PLAN.md §3.2。
 */

export type Role = 'system' | 'user' | 'assistant';

export interface SamplingParams {
  temperature?: number;
  topP?: number;
  topK?: number;
  minP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  repetitionPenalty?: number;
  maxTokens?: number;
  seed?: number;
  stop?: string[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema */
  parameters: Record<string, unknown>;
  strict?: boolean;
}

export type Part =
  | { type: 'text'; text: string }
  | { type: 'image'; assetId: string; mime: string }
  | { type: 'document'; assetId: string; mime: string }
  | { type: 'reasoning_opaque'; provider: string; model: string; payload: unknown };

export type SegmentOriginKind =
  | 'preset'
  | 'character'
  | 'persona'
  | 'worldinfo'
  | 'authors_note'
  | 'history'
  | 'injection'
  | 'user_input'
  | 'variables'
  | 'global_system';

export interface Segment {
  /** 来源 + uid 的稳定 id，用于 diff */
  id: string;
  role: Role;
  parts: Part[];
  /** 历史消息的发言者名，适配器可选用于 OpenAI `name` */
  name?: string;
  origin: { kind: SegmentOriginKind; ref?: string };
  /** ST 原始位置，strict 模式与 diff 的依据 */
  anchor: { slot: 'system' | 'history'; depth?: number; order: number };
  stability: 'static' | 'session' | 'turn' | 'history';
  /** 含易变宏（time/date/random/roll/lastMessage） */
  volatile?: boolean;
  /** 保真锁：禁止布局器移动 */
  locked?: boolean;
}

export interface WIActivation {
  entryId: string;
  bookId?: string;
  /** ST position 0–6 */
  position: number;
  depth?: number;
  role: Role;
  order: number;
}

export interface PromptIR {
  model: string;
  sampling: SamplingParams;
  tools?: ToolDef[];
  /** 最终顺序的段列表 */
  segments: Segment[];
  /** breakpoints 指向 segments 下标 */
  cachePlan: { breakpoints: number[]; ttl?: '5m' | '1h' };
  meta: {
    chatId: string;
    presetId: string;
    layoutMode: 'strict' | 'cache-aware';
    activations: WIActivation[];
    warnings: string[];
    tokenEstimate: number;
  };
}
