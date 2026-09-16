/**
 * cache-aware 布局（M3 契约 §5）。规则顺序：
 *
 * 1. 触发式世界书（`origin.kind='worldinfo'` 且 `stability='turn'`）若落在 static 区，
 *    合并成一段移到尾部（depth = k），角色按 `policy.wiCarrierRole`；
 * 2. 深度注入 `depth > k` 夹紧到 k；
 * 3. static 段含 `volatile`：freeze 用冻结表替换文本，warn 只告警；
 * 4. session 层整体排到 static 层之后、历史之前；
 * 5. 按提供商能力放断点。
 *
 * 不变量：只跨层移动、层内相对顺序不变、`locked` 段绝不动、段粒度。
 */

import { type Part, type PromptIR, type Segment } from '../ir.js';
import {
  buildBreakpoints,
  cacheablePrefixTokens,
  isDepthInjection,
  isHistoryMessage,
  lastIndexWhere,
  segmentText,
} from './shared.js';
import { type LayoutContext, type LayoutMove, type LayoutResult } from './types.js';

const STABILITY_RANK: Record<Segment['stability'], number> = {
  static: 0,
  session: 1,
  history: 2,
  turn: 3,
};

/** 移入尾部的触发式 WI 用 user 角色承载时的包裹前缀（契约 §5） */
const WI_CARRIER_PREFIX = '[World Info]\n';

export const WI_CARRIER_SEGMENT_ID = 'layout:wiCarrier';

function isLocked(segment: Segment, lockedIds: ReadonlySet<string>): boolean {
  return segment.locked === true || lockedIds.has(segment.id);
}

/** 历史区的结束位置（最后一个 `anchor.slot==='history'` 的段之后） */
function historyRegionEnd(segments: readonly Segment[]): number {
  const last = lastIndexWhere(segments, (segment) => segment.anchor.slot === 'history');
  return last >= 0 ? last + 1 : segments.length;
}

/** depth = d 的注入应插入的下标（d=0 在最后一条历史之后，d>=历史条数时在最前） */
export function depthInsertIndex(segments: readonly Segment[], depth: number): number {
  const historyIndexes: number[] = [];
  segments.forEach((segment, index) => {
    if (isHistoryMessage(segment)) historyIndexes.push(index);
  });
  if (historyIndexes.length === 0) return historyRegionEnd(segments);
  if (depth <= 0) return historyRegionEnd(segments);
  if (depth >= historyIndexes.length) return historyIndexes[0] ?? 0;
  return historyIndexes[historyIndexes.length - depth] ?? historyRegionEnd(segments);
}

function withText(segment: Segment, text: string): Segment {
  const parts: Part[] = [
    { type: 'text', text },
    ...segment.parts.filter((part) => part.type !== 'text'),
  ];
  return { ...segment, parts };
}

export function layoutCacheAware(segments: readonly Segment[], ctx: LayoutContext): LayoutResult {
  const k = Math.max(0, ctx.policy.tailWindow);
  const lockedIds = new Set(ctx.policy.lockedSegmentIds ?? []);
  const moves: LayoutMove[] = [];
  const warnings: string[] = [];
  const newFrozenVolatile: Record<string, string> = {};

  let working = [...segments];

  // ── 规则 4：session 段排到 static 之后（只在 system 槽的前缀区内部做稳定重排）
  {
    const firstHistory = working.findIndex((segment) => segment.anchor.slot === 'history');
    const prefixEnd = firstHistory >= 0 ? firstHistory : working.length;
    const movablePositions: number[] = [];
    for (let i = 0; i < prefixEnd; i += 1) {
      const segment = working[i];
      if (segment !== undefined && !isLocked(segment, lockedIds)) movablePositions.push(i);
    }
    const movable = movablePositions.map((index) => working[index] as Segment);
    const sorted = movable
      .map((segment, index) => ({ segment, index }))
      .sort(
        (a, b) =>
          STABILITY_RANK[a.segment.stability] - STABILITY_RANK[b.segment.stability] ||
          a.index - b.index,
      )
      .map((item) => item.segment);
    movablePositions.forEach((position, index) => {
      const segment = sorted[index];
      if (segment !== undefined) working[position] = segment;
    });
    /**
     * 只报「被排到后面」的段。排到前面的（比如被降级的 session 段让出位置后往前补的
     * static 段）相对同层的顺序并没有变，是被动补位，标成「已移动」只会是噪音。
     */
    const oldIndexById = new Map(movable.map((segment, index) => [segment.id, index]));
    sorted.forEach((segment, newIndex) => {
      const oldIndex = oldIndexById.get(segment.id);
      if (oldIndex === undefined || newIndex <= oldIndex) return;
      moves.push({
        segmentId: segment.id,
        kind: 'moved',
        from: segment.anchor,
        to: segment.anchor,
        reason: `按稳定性分层重排：${segment.stability} 层排到 static 层之后，以保住 static 前缀的缓存`,
      });
    });
  }

  // ── 规则 1：static 区的触发式 WI 合并后移到尾部
  {
    const carriers = working.filter(
      (segment) =>
        segment.origin.kind === 'worldinfo' &&
        segment.stability === 'turn' &&
        segment.anchor.slot === 'system' &&
        !isLocked(segment, lockedIds),
    );
    if (carriers.length > 0) {
      working = working.filter((segment) => !carriers.includes(segment));
      const role: Segment['role'] = ctx.providerCaps.systemInMessages
        ? ctx.policy.wiCarrierRole
        : 'user';
      const body = carriers
        .map(segmentText)
        .filter((text) => text !== '')
        .join('\n\n');
      const text = role === 'user' ? `${WI_CARRIER_PREFIX}${body}` : body;
      const anchor: Segment['anchor'] = { slot: 'history', depth: k, order: 0 };
      const carrier: Segment = {
        id: WI_CARRIER_SEGMENT_ID,
        role,
        parts: [{ type: 'text', text }],
        origin: { kind: 'worldinfo', ref: 'cache-aware-carrier' },
        anchor,
        stability: 'turn',
        ...(carriers.some((segment) => segment.volatile) ? { volatile: true } : {}),
      };
      working.splice(depthInsertIndex(working, k), 0, carrier);
      for (const segment of carriers) {
        moves.push({
          segmentId: segment.id,
          kind: 'moved',
          from: segment.anchor,
          to: anchor,
          reason: `触发式世界书移入尾部窗口（depth=${k}），以保住 static 前缀的缓存`,
        });
      }
    }
  }

  // ── 规则 2：depth > k 的深度注入夹紧到 k
  {
    const clamped = working.filter(
      (segment) =>
        isDepthInjection(segment) &&
        (segment.anchor.depth ?? 0) > k &&
        segment.id !== WI_CARRIER_SEGMENT_ID &&
        !isLocked(segment, lockedIds),
    );
    if (clamped.length > 0) {
      working = working.filter((segment) => !clamped.includes(segment));
      const index = depthInsertIndex(working, k);
      const rewritten = clamped.map((segment) => ({
        ...segment,
        anchor: { ...segment.anchor, depth: k },
      }));
      working.splice(index, 0, ...rewritten);
      clamped.forEach((segment, i) => {
        const next = rewritten[i];
        if (!next) return;
        moves.push({
          segmentId: segment.id,
          kind: 'clamped',
          from: segment.anchor,
          to: next.anchor,
          reason: `深度注入 ${segment.anchor.depth ?? 0} → ${k}（尾部窗口之外的注入会打断历史缓存）`,
        });
      });
    }
  }

  // ── 规则 3：static 段里的易变宏
  {
    const frozen = ctx.policy.frozenVolatile ?? {};
    working = working.map((segment) => {
      if (segment.volatile !== true || segment.stability !== 'static') return segment;
      if (ctx.policy.volatileHandling === 'warn') {
        warnings.push(`static 段「${segment.id}」含易变宏，会导致缓存前缀每轮失效`);
        return segment;
      }
      const remembered = frozen[segment.id];
      if (remembered !== undefined) {
        moves.push({
          segmentId: segment.id,
          kind: 'frozen',
          from: segment.anchor,
          to: segment.anchor,
          reason: '易变宏已按会话冻结为首次生成时的值',
        });
        return withText({ ...segment, volatile: false }, remembered);
      }
      newFrozenVolatile[segment.id] = segmentText(segment);
      warnings.push(`static 段「${segment.id}」含易变宏，本轮的值已记录为会话冻结值`);
      return segment;
    });
  }

  // ── 规则 5：断点
  const candidates: number[] = [];
  const caching = ctx.providerCaps.caching;
  if (caching !== 'none') {
    const lastStatic = lastIndexWhere(working, (segment) => segment.stability === 'static');
    if (lastStatic >= 0) candidates.push(lastStatic);
  }
  if (caching === 'breakpoints' || caching === 'explicit-object') {
    const lastSession = lastIndexWhere(working, (segment) => segment.stability === 'session');
    if (lastSession >= 0) candidates.push(lastSession);
    const historyIndexes: number[] = [];
    working.forEach((segment, index) => {
      if (isHistoryMessage(segment)) historyIndexes.push(index);
    });
    const tailStart = Math.max(0, historyIndexes.length - k);
    const lastStableHistory = historyIndexes[tailStart - 1];
    if (lastStableHistory !== undefined) candidates.push(lastStableHistory);
  }

  const { breakpoints, warnings: bpWarnings } =
    caching === 'none' || caching === 'prefix-auto'
      ? { breakpoints: [], warnings: [] }
      : buildBreakpoints(working, candidates, ctx);
  warnings.push(...bpWarnings);

  const cachePlan: PromptIR['cachePlan'] = {
    breakpoints: breakpoints.map((bp) => bp.index),
    ...(ctx.policy.ttl ? { ttl: ctx.policy.ttl } : {}),
  };

  return {
    segments: working,
    cachePlan,
    report: {
      mode: 'cache-aware',
      moves,
      breakpoints,
      estimatedCacheablePrefixTokens: cacheablePrefixTokens(working, ctx.countTokens),
      warnings,
      newFrozenVolatile,
    },
  };
}
