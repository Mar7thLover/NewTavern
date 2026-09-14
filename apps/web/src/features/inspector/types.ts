import type { PromptIR, Segment, SegmentOriginKind, WIActivation } from '@newtavern/core';

import type { LayoutMode, Usage } from '../../lib/api';

/**
 * 检查器的数据形状，对应 docs/M3-CONTRACT.md §5（LayoutReport）与 §6（inspect 响应）。
 * `LayoutReport` 尚未从 `@newtavern/core` 导出（AS 未完成），先在前端按契约声明。
 */

export type LayoutLayer = 'static' | 'session' | 'history' | 'tools';

export interface LayoutMove {
  segmentId: string;
  kind: 'moved' | 'clamped' | 'frozen';
  from: Segment['anchor'];
  to: Segment['anchor'];
  reason: string;
}

export interface LayoutBreakpoint {
  /** 指向 segments 下标 */
  index: number;
  segmentId: string;
  layer: LayoutLayer;
  estTokens: number;
  /** 低于 provider 的最小可缓存长度 */
  belowMin?: boolean;
}

export interface LayoutReport {
  mode: LayoutMode;
  moves: LayoutMove[];
  breakpoints: LayoutBreakpoint[];
  estimatedCacheablePrefixTokens: number;
  warnings: string[];
}

export interface InspectWorldInfo {
  activations: WIActivation[];
  rejected: { entryId: string; reason: string }[];
  budgetUsed: number;
  overflowed: boolean;
}

export interface InspectLayoutDiff {
  moved: string[];
  clamped: string[];
  unchanged: number;
}

/** SB 接入后的完整响应（契约 §6） */
export interface InspectData {
  layoutMode: LayoutMode;
  ir: PromptIR;
  /** 适配器构造出的原生请求体（已去 headers） */
  request: unknown;
  strictIr?: PromptIR | null;
  diff?: InspectLayoutDiff | null;
  layout: LayoutReport;
  wi: InspectWorldInfo;
  warnings: string[];
  tokenEstimate: number;
  lastUsage: Usage | null;
}

/** SA 阶段的占位响应（契约 §3.6） */
export interface InspectPlaceholder {
  todo: true;
  chatId: string;
  parentId: string | null;
  connectionId: string | null;
  model: string | null;
  layoutMode: LayoutMode;
}

export type InspectResponse = InspectData | InspectPlaceholder;

export function isInspectPlaceholder(value: InspectResponse): value is InspectPlaceholder {
  return (value as InspectPlaceholder).todo === true;
}

/** `POST /api/inspect/compare` 的响应（契约 §6） */
export interface CompareMessage {
  role: string;
  content: unknown;
}

export interface CompareResult {
  same: boolean;
  firstDiffIndex: number;
  ours: CompareMessage[];
  theirs: CompareMessage[];
  hints: string[];
}

/** 段左侧 4px 色条：颜色在 tokens.css 里按明暗各定义一套 */
export const ORIGIN_BAR_CLASS: Record<SegmentOriginKind, string> = {
  preset: 'bg-inspector-preset',
  character: 'bg-inspector-character',
  persona: 'bg-inspector-persona',
  worldinfo: 'bg-inspector-worldinfo',
  authors_note: 'bg-inspector-authors-note',
  history: 'bg-inspector-history',
  injection: 'bg-inspector-injection',
  user_input: 'bg-inspector-user-input',
  variables: 'bg-inspector-variables',
  global_system: 'bg-inspector-global-system',
};

/** 段正文：只有 text part 能直接展示，其余给一个占位 */
export function segmentText(segment: Segment): string {
  return segment.parts
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join('');
}
