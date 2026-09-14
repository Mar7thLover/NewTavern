/**
 * strict 布局（M3 契约 §5）：**完全按 ST 顺序输出，一个段都不动**。
 * 只决定缓存断点的位置：
 * - static 层末尾 1 个；
 * - `caching === 'breakpoints'` 时，再在「最后一条未受深度注入影响的历史段」加 1 个
 *   （要求至少 2 条历史段）。
 */

import { type PromptIR, type Segment } from '../ir.js';
import {
  buildBreakpoints,
  cacheablePrefixTokens,
  isDepthInjection,
  isHistoryMessage,
  lastIndexWhere,
} from './shared.js';
import { type LayoutContext, type LayoutResult } from './types.js';

/**
 * 最后一条「未受深度注入影响」的历史段下标。
 *
 * 深度注入会插在历史中间，它之后的历史消息前缀每轮都在变，因此断点只能放在
 * **第一条深度注入之前**的最后一条历史消息上；没有深度注入时退化为倒数第二条历史
 * （最后一条每轮都变，做断点没有意义）。
 */
export function lastStableHistoryIndex(segments: readonly Segment[]): number {
  const historyIndexes: number[] = [];
  segments.forEach((segment, index) => {
    if (isHistoryMessage(segment)) historyIndexes.push(index);
  });
  if (historyIndexes.length < 2) return -1;

  const firstInjection = segments.findIndex(isDepthInjection);
  if (firstInjection >= 0) {
    const before = historyIndexes.filter((index) => index < firstInjection);
    const candidate = before[before.length - 1];
    return candidate ?? -1;
  }
  return historyIndexes[historyIndexes.length - 2] ?? -1;
}

export function layoutStrict(segments: readonly Segment[], ctx: LayoutContext): LayoutResult {
  const output = [...segments];
  const warnings: string[] = [];

  const candidates: number[] = [];
  if (ctx.providerCaps.caching !== 'none') {
    const lastStatic = lastIndexWhere(output, (segment) => segment.stability === 'static');
    if (lastStatic >= 0) candidates.push(lastStatic);
  }
  if (ctx.providerCaps.caching === 'breakpoints') {
    const stableHistory = lastStableHistoryIndex(output);
    if (stableHistory >= 0) candidates.push(stableHistory);
  }

  const { breakpoints, warnings: bpWarnings } =
    ctx.providerCaps.caching === 'none'
      ? { breakpoints: [], warnings: [] }
      : buildBreakpoints(output, candidates, ctx);
  warnings.push(...bpWarnings);

  // strict 不移动段，但含易变宏的 static 段仍然会打断缓存 —— 只告警，不冻结
  for (const segment of output) {
    if (segment.volatile === true && segment.stability === 'static') {
      warnings.push(`static 段「${segment.id}」含易变宏，会导致缓存前缀每轮失效`);
    }
  }

  const cachePlan: PromptIR['cachePlan'] = {
    breakpoints:
      ctx.providerCaps.caching === 'breakpoints' ? breakpoints.map((bp) => bp.index) : [],
    ...(ctx.policy.ttl ? { ttl: ctx.policy.ttl } : {}),
  };

  return {
    segments: output,
    cachePlan,
    report: {
      mode: 'strict',
      moves: [],
      breakpoints,
      estimatedCacheablePrefixTokens: cacheablePrefixTokens(output, ctx.countTokens),
      warnings,
      newFrozenVolatile: {},
    },
  };
}
