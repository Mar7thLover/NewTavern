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
  tools?: ToolDef[];
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
  };
}

/** ST `squashSystemMessages` 的 excludeList（newMainChat / newChat / groupNudge）对应的段 ref */
export const SQUASH_EXCLUDED_REFS: ReadonlySet<string> = new Set([
  'new_chat_prompt',
  'new_example_chat_prompt',
]);

/**
 * 该段能否参与 `squash_system_messages` 合并：system 角色、无 name、单个文本 part、
 * 且不是分隔段。带 image / document / reasoning_opaque 的段不合并。
 */
export function isSquashableSegment(segment: Segment): boolean {
  if (segment.role !== 'system' || segment.name !== undefined) return false;
  if (SQUASH_EXCLUDED_REFS.has(segment.origin.ref ?? '')) return false;
  return segment.parts.length === 1 && segment.parts[0]?.type === 'text';
}
