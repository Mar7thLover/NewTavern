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
  /**
   * ST 预设的 `reasoning_effort` 原值（min/low/medium/high/max；auto 不写入）。
   * 各家映射不同，由 providers 适配器按 ST 的来源规则转换；会话覆盖的 thinking 优先于它。
   */
  reasoningEffort?: string;
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
  /** name：原始文件名（上传/导入时记录，渲染 PDF 的 filename 与界面展示用） */
  | { type: 'image'; assetId: string; mime: string; name?: string }
  | { type: 'document'; assetId: string; mime: string; name?: string }
  | { type: 'reasoning_opaque'; provider: string; model: string; payload: unknown }
  /** assistant 段里模型发起的工具调用；args 为 JSON 字符串（原样回传，不重新序列化） */
  | { type: 'tool_call'; id: string; name: string; args: string }
  /** 工具结果；放在 role='user' 的段里（Anthropic 语义），适配器负责转成各家形态 */
  | { type: 'tool_result'; callId: string; name: string; content: string; isError?: boolean };

/** 工具选择：缺省 'auto'；`{ name }` = 强制调用该工具（M6 契约 §1.1） */
export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

/** 结构化输出：JSON Schema（M6 契约 §1.1） */
export interface ResponseFormat {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

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

export interface WIActivationSummary {
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
  /**
   * 工具定义。组装流水线（assemble.ts）不产生工具相关字段与 part，
   * 只有直接构造 IR 的调用方（AI 协作者、前端卡 generate）会用（M6 契约 §1）。
   */
  tools?: ToolDef[];
  /** 缺省 'auto'；{ name } = 强制调用该工具 */
  toolChoice?: ToolChoice;
  /** 结构化输出：JSON Schema（与 tools 同时给时以各家限制为准，冲突时给 warning） */
  responseFormat?: ResponseFormat;
  /** 最终顺序的段列表 */
  segments: Segment[];
  /** breakpoints 指向 segments 下标 */
  cachePlan: { breakpoints: number[]; ttl?: '5m' | '1h' };
  meta: {
    chatId: string;
    presetId: string;
    layoutMode: 'strict' | 'cache-aware';
    activations: WIActivationSummary[];
    warnings: string[];
    tokenEstimate: number;
    /**
     * 预设 `squash_system_messages`。IR **保留段粒度**（检查器要看得到每一段的来源），
     * 真正的合并由渲染层在最终消息列表上做（providers `irToChatMessages`），
     * 与 ST 在 `ChatCompletion.squashSystemMessages` 里合并的时机一致。
     */
    squashSystemMessages?: boolean;
    /** 内容经过 EJS 模板渲染的段 id（M5（三）契约 §4，检查器据此标注） */
    templated?: string[];
  };
}

/** ST `squashSystemMessages` 的 excludeList（newMainChat / newChat / groupNudge）对应的段 ref */
export const SQUASH_EXCLUDED_REFS: ReadonlySet<string> = new Set([
  'new_chat_prompt',
  'new_example_chat_prompt',
]);

/**
 * 该段能否参与 `squash_system_messages` 合并：system 角色、无 name、单个文本 part、
 * 且不是分隔段。带 image / document / reasoning_opaque / tool_call / tool_result 的段不合并。
 */
export function isSquashableSegment(segment: Segment): boolean {
  if (segment.role !== 'system' || segment.name !== undefined) return false;
  if (SQUASH_EXCLUDED_REFS.has(segment.origin.ref ?? '')) return false;
  if (segment.parts.some((p) => p.type === 'tool_call' || p.type === 'tool_result')) return false;
  return segment.parts.length === 1 && segment.parts[0]?.type === 'text';
}
