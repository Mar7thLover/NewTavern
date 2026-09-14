/**
 * 布局器类型（M3 契约 §5）。
 *
 * 布局器的三条不变量：
 * 1. 只做**跨层移动**，不改层内相对顺序；
 * 2. 以 segment 为粒度（不做 token 级裁剪 / 摘要等有损策略）；
 * 3. `locked` 段绝不移动。
 */

import { type PromptIR, type Segment } from '../ir.js';

/** 布局需要的提供商能力子集（与 `@newtavern/providers` 的 `ModelCapabilities` 同名字段） */
export interface LayoutProviderCaps {
  caching: 'none' | 'prefix-auto' | 'breakpoints' | 'explicit-object';
  cacheMinTokens?: number;
  maxBreakpoints?: number;
  /** system 是否作为普通消息发送（false = 抽到顶层 system 字段） */
  systemInMessages: boolean;
  prefill: boolean;
}

export interface LayoutPolicy {
  /** 尾部窗口 k：深度注入夹紧的上限、触发式 WI 的落点 */
  tailWindow: number;
  lockedSegmentIds?: string[];
  /** static 段含易变宏时：freeze = 用冻结表替换文本，warn = 只告警 */
  volatileHandling: 'freeze' | 'warn';
  /** segmentId → 冻结文本（服务端从 `chat.metadata.frozenVolatile` 取/存） */
  frozenVolatile?: Record<string, string>;
  /** 移入尾部的触发式 WI 的承载角色；`systemInMessages=false` 时强制 user */
  wiCarrierRole: 'system' | 'user';
  ttl?: '5m' | '1h';
}

export const DEFAULT_LAYOUT_POLICY: LayoutPolicy = {
  tailWindow: 4,
  volatileHandling: 'warn',
  wiCarrierRole: 'system',
};

export function resolveLayoutPolicy(policy?: Partial<LayoutPolicy>): LayoutPolicy {
  return { ...DEFAULT_LAYOUT_POLICY, ...(policy ?? {}) };
}

export interface LayoutContext {
  providerCaps: LayoutProviderCaps;
  policy: LayoutPolicy;
  countTokens: (text: string) => number;
}

export interface LayoutMove {
  segmentId: string;
  kind: 'moved' | 'clamped' | 'frozen';
  from: Segment['anchor'];
  to: Segment['anchor'];
  reason: string;
}

export interface LayoutBreakpoint {
  /** 指向**布局后** segments 的下标 */
  index: number;
  segmentId: string;
  layer: 'static' | 'session' | 'history' | 'tools';
  /** 该断点之前（含）的累计估算 token */
  estTokens: number;
  /** 低于 `cacheMinTokens`，提供商可能不会真正缓存 */
  belowMin?: boolean;
}

export interface LayoutReport {
  mode: 'strict' | 'cache-aware';
  moves: LayoutMove[];
  breakpoints: LayoutBreakpoint[];
  estimatedCacheablePrefixTokens: number;
  warnings: string[];
  /**
   * 本次为 volatile static 段记录的文本（`volatileHandling:'freeze'` 且冻结表里还没有时）。
   * 服务端应把它并入 `chat.metadata.frozenVolatile` 以便下一轮复用。
   */
  newFrozenVolatile: Record<string, string>;
}

export interface LayoutResult {
  segments: Segment[];
  cachePlan: PromptIR['cachePlan'];
  report: LayoutReport;
}

export interface LayoutDiff {
  moved: string[];
  clamped: string[];
  unchanged: number;
}
