/** 布局器共用的小工具（strict / cache-aware 都要用）。 */

import { type Segment } from '../ir.js';
import { type LayoutBreakpoint, type LayoutContext } from './types.js';

/** 段的纯文本（多个 text part 用 `\n` 连接；非文本 part 不计入 token 估算） */
export function segmentText(segment: Segment): string {
  return segment.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

export function segmentTokens(segment: Segment, countTokens: (text: string) => number): number {
  const text = segmentText(segment);
  return text === '' ? 0 : countTokens(text);
}

/** 段所属的缓存层：与 `Segment.stability` 一一对应 */
export function layerOf(segment: Segment): LayoutBreakpoint['layer'] {
  switch (segment.stability) {
    case 'static':
      return 'static';
    case 'session':
      return 'session';
    default:
      return 'history';
  }
}

export function isHistoryMessage(segment: Segment): boolean {
  return segment.origin.kind === 'history' || segment.origin.kind === 'user_input';
}

/** 深度注入段：落在历史槽但不是历史消息本身 */
export function isDepthInjection(segment: Segment): boolean {
  return segment.anchor.slot === 'history' && !isHistoryMessage(segment);
}

/**
 * 把候选下标变成 `LayoutBreakpoint[]`：
 * 计算前缀 token、标 `belowMin`、去重排序、按 `maxBreakpoints` 截断（靠前优先）。
 */
export function buildBreakpoints(
  segments: readonly Segment[],
  candidates: readonly number[],
  ctx: LayoutContext,
): { breakpoints: LayoutBreakpoint[]; warnings: string[] } {
  const warnings: string[] = [];
  const unique = [...new Set(candidates.filter((index) => index >= 0 && index < segments.length))];
  unique.sort((a, b) => a - b);

  const prefix: number[] = [];
  let running = 0;
  for (const segment of segments) {
    running += segmentTokens(segment, ctx.countTokens);
    prefix.push(running);
  }

  const max = ctx.providerCaps.maxBreakpoints ?? unique.length;
  const kept = unique.slice(0, Math.max(0, max));
  if (kept.length < unique.length) {
    warnings.push(
      `提供商最多支持 ${max} 个缓存断点，已丢弃靠后的 ${unique.length - kept.length} 个`,
    );
  }

  const minTokens = ctx.providerCaps.cacheMinTokens;
  const breakpoints: LayoutBreakpoint[] = kept.map((index) => {
    const segment = segments[index];
    const estTokens = prefix[index] ?? 0;
    const belowMin = typeof minTokens === 'number' && estTokens < minTokens;
    if (belowMin) {
      warnings.push(
        `缓存断点「${segment?.id ?? index}」前缀仅约 ${estTokens} token，低于该模型的最小缓存粒度 ${minTokens}`,
      );
    }
    return {
      index,
      segmentId: segment?.id ?? '',
      layer: segment ? layerOf(segment) : 'history',
      estTokens,
      ...(belowMin ? { belowMin: true } : {}),
    };
  });

  return { breakpoints, warnings };
}

/** static + session 层的累计 token（prefix-auto 提供商的「预计可缓存前缀」） */
export function cacheablePrefixTokens(
  segments: readonly Segment[],
  countTokens: (text: string) => number,
): number {
  let total = 0;
  for (const segment of segments) {
    if (segment.stability !== 'static' && segment.stability !== 'session') break;
    total += segmentTokens(segment, countTokens);
  }
  return total;
}

/** 最后一个满足条件的下标 */
export function lastIndexWhere(
  segments: readonly Segment[],
  predicate: (segment: Segment) => boolean,
): number {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment !== undefined && predicate(segment)) return i;
  }
  return -1;
}
