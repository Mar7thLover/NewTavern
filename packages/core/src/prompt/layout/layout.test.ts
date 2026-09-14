/** 布局器测试（M3 契约 §5.1）。 */

import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../../tokenizer.js';
import { type PromptIR, type Segment } from '../ir.js';
import { layoutCacheAware, WI_CARRIER_SEGMENT_ID } from './cacheAware.js';
import { diffLayouts } from './diff.js';
import { layoutStrict } from './strict.js';
import {
  resolveLayoutPolicy,
  type LayoutContext,
  type LayoutPolicy,
  type LayoutProviderCaps,
} from './types.js';

const CAPS: LayoutProviderCaps = {
  caching: 'breakpoints',
  maxBreakpoints: 4,
  systemInMessages: true,
  prefill: true,
};

function ctx(
  policy: Partial<LayoutPolicy> = {},
  caps: Partial<LayoutProviderCaps> = {},
): LayoutContext {
  return {
    providerCaps: { ...CAPS, ...caps },
    policy: resolveLayoutPolicy(policy),
    countTokens: estimateTokens,
  };
}

function seg(partial: Partial<Segment> & { id: string }): Segment {
  return {
    role: 'system',
    parts: [{ type: 'text', text: partial.id }],
    origin: { kind: 'preset' },
    anchor: { slot: 'system', order: 0 },
    stability: 'static',
    ...partial,
  };
}

function history(id: string, order: number, last = false): Segment {
  return seg({
    id: `history:${id}`,
    role: last ? 'user' : 'assistant',
    origin: { kind: last ? 'user_input' : 'history', ref: id },
    anchor: { slot: 'history', order },
    stability: last ? 'turn' : 'history',
  });
}

/** 典型段序：preset → 触发式 WI → session → 历史 ×4 → depth 8 注入 */
function sample(): Segment[] {
  return [
    seg({ id: 'preset:main', anchor: { slot: 'system', order: 0 } }),
    seg({
      id: 'worldinfo:before',
      origin: { kind: 'worldinfo', ref: 'before' },
      anchor: { slot: 'system', order: 1 },
      stability: 'turn',
    }),
    seg({
      id: 'authors_note',
      origin: { kind: 'authors_note' },
      anchor: { slot: 'system', order: 2 },
      stability: 'session',
    }),
    seg({ id: 'preset:jailbreak', anchor: { slot: 'system', order: 3 } }),
    history('h1', 0),
    history('h2', 1),
    history('h3', 2),
    seg({
      id: 'injection:deep',
      origin: { kind: 'injection', ref: 'deep' },
      anchor: { slot: 'history', depth: 8, order: 100 },
      stability: 'turn',
    }),
    history('h4', 3, true),
  ];
}

const ids = (segments: readonly Segment[]): string[] => segments.map((segment) => segment.id);

function toIr(segments: Segment[], cachePlan: PromptIR['cachePlan']): PromptIR {
  return {
    model: 'm',
    sampling: {},
    segments,
    cachePlan,
    meta: {
      chatId: 'c',
      presetId: 'p',
      layoutMode: 'strict',
      activations: [],
      warnings: [],
      tokenEstimate: 0,
    },
  };
}

// ───────────── strict ─────────────

describe('layoutStrict', () => {
  it('一个段都不动', () => {
    const segments = sample();
    const result = layoutStrict(segments, ctx());
    expect(ids(result.segments)).toEqual(ids(segments));
    expect(result.report.moves).toEqual([]);
    expect(result.report.mode).toBe('strict');
  });

  it('断点 = static 末尾 + 最后一条未受深度注入影响的历史', () => {
    const segments = sample();
    const result = layoutStrict(segments, ctx());
    const bpIds = result.report.breakpoints.map((bp) => bp.segmentId);
    expect(bpIds).toEqual(['preset:jailbreak', 'history:h3']);
    expect(result.cachePlan.breakpoints).toEqual(result.report.breakpoints.map((bp) => bp.index));
  });

  it('没有深度注入时退化为倒数第二条历史', () => {
    const segments = sample().filter((segment) => segment.id !== 'injection:deep');
    const result = layoutStrict(segments, ctx());
    expect(result.report.breakpoints.map((bp) => bp.segmentId)).toEqual([
      'preset:jailbreak',
      'history:h3',
    ]);
  });

  it('caching=none 时没有断点；prefix-auto 只给 static 末尾与可缓存前缀', () => {
    const none = layoutStrict(sample(), ctx({}, { caching: 'none' }));
    expect(none.report.breakpoints).toEqual([]);
    expect(none.cachePlan.breakpoints).toEqual([]);

    const auto = layoutStrict(sample(), ctx({}, { caching: 'prefix-auto' }));
    expect(auto.report.breakpoints.map((bp) => bp.segmentId)).toEqual(['preset:jailbreak']);
    expect(auto.cachePlan.breakpoints).toEqual([]);
    expect(auto.report.estimatedCacheablePrefixTokens).toBeGreaterThan(0);
  });

  it('cacheMinTokens 之下的断点标 belowMin 并告警', () => {
    const result = layoutStrict(sample(), ctx({}, { cacheMinTokens: 100_000 }));
    expect(result.report.breakpoints.every((bp) => bp.belowMin === true)).toBe(true);
    expect(result.report.warnings.some((w) => w.includes('最小缓存粒度'))).toBe(true);
  });

  it('maxBreakpoints 截断靠后的断点', () => {
    const result = layoutStrict(sample(), ctx({}, { maxBreakpoints: 1 }));
    expect(result.report.breakpoints).toHaveLength(1);
    expect(result.report.warnings.some((w) => w.includes('缓存断点'))).toBe(true);
  });

  it('static 段含易变宏时告警但不动', () => {
    const segments = sample().map((segment) =>
      segment.id === 'preset:main' ? { ...segment, volatile: true } : segment,
    );
    const result = layoutStrict(segments, ctx());
    expect(result.report.warnings.some((w) => w.includes('易变宏'))).toBe(true);
    expect(ids(result.segments)).toEqual(ids(segments));
  });
});

// ───────────── cache-aware ─────────────

describe('layoutCacheAware', () => {
  it('规则 1：static 区的触发式 WI 合并后移到 depth=k', () => {
    const result = layoutCacheAware(sample(), ctx({ tailWindow: 2 }));
    expect(ids(result.segments)).not.toContain('worldinfo:before');
    const index = ids(result.segments).indexOf(WI_CARRIER_SEGMENT_ID);
    expect(index).toBeGreaterThan(ids(result.segments).indexOf('history:h2'));
    expect(result.segments[index]?.anchor).toEqual({ slot: 'history', depth: 2, order: 0 });
    expect(result.report.moves).toContainEqual(
      expect.objectContaining({ segmentId: 'worldinfo:before', kind: 'moved' }),
    );
  });

  it('规则 1：systemInMessages=false 时强制 user 并包裹 [World Info]', () => {
    const result = layoutCacheAware(sample(), ctx({}, { systemInMessages: false }));
    const carrier = result.segments.find((segment) => segment.id === WI_CARRIER_SEGMENT_ID);
    expect(carrier?.role).toBe('user');
    expect(carrier?.parts[0]).toEqual({ type: 'text', text: '[World Info]\nworldinfo:before' });
  });

  it('规则 2：depth > k 的注入夹紧到 k', () => {
    const result = layoutCacheAware(sample(), ctx({ tailWindow: 1 }));
    const clamped = result.segments.find((segment) => segment.id === 'injection:deep');
    expect(clamped?.anchor.depth).toBe(1);
    expect(result.report.moves).toContainEqual(
      expect.objectContaining({ segmentId: 'injection:deep', kind: 'clamped' }),
    );
    // 夹紧后落在最后一条历史之前
    const list = ids(result.segments);
    expect(list.indexOf('injection:deep')).toBe(list.indexOf('history:h4') - 1);
  });

  it('规则 2：depth ≤ k 的注入不动', () => {
    const result = layoutCacheAware(sample(), ctx({ tailWindow: 10 }));
    expect(result.report.moves.some((move) => move.kind === 'clamped')).toBe(false);
  });

  it('规则 3：freeze 模式用冻结表替换文本；无记录时写进 report', () => {
    const segments = sample().map((segment) =>
      segment.id === 'preset:main' ? { ...segment, volatile: true } : segment,
    );
    const first = layoutCacheAware(segments, ctx({ volatileHandling: 'freeze' }));
    expect(first.report.newFrozenVolatile).toEqual({ 'preset:main': 'preset:main' });

    const second = layoutCacheAware(
      segments,
      ctx({ volatileHandling: 'freeze', frozenVolatile: { 'preset:main': 'FROZEN' } }),
    );
    const main = second.segments.find((segment) => segment.id === 'preset:main');
    expect(main?.parts[0]).toEqual({ type: 'text', text: 'FROZEN' });
    expect(main?.volatile).toBe(false);
    expect(second.report.moves).toContainEqual(
      expect.objectContaining({ segmentId: 'preset:main', kind: 'frozen' }),
    );
  });

  it('规则 3：warn 模式只告警', () => {
    const segments = sample().map((segment) =>
      segment.id === 'preset:main' ? { ...segment, volatile: true } : segment,
    );
    const result = layoutCacheAware(segments, ctx({ volatileHandling: 'warn' }));
    expect(result.report.moves.some((move) => move.kind === 'frozen')).toBe(false);
    expect(result.report.warnings.some((w) => w.includes('易变宏'))).toBe(true);
  });

  it('规则 4：session 层排到 static 之后、历史之前', () => {
    const result = layoutCacheAware(sample(), ctx());
    const list = ids(result.segments);
    expect(list.indexOf('authors_note')).toBeGreaterThan(list.indexOf('preset:jailbreak'));
    expect(list.indexOf('authors_note')).toBeLessThan(list.indexOf('history:h1'));
  });

  it('规则 5：断点为 static 末尾 / session 末尾 / 尾部窗口前的最后一条历史', () => {
    const result = layoutCacheAware(sample(), ctx({ tailWindow: 2 }));
    expect(result.report.breakpoints.map((bp) => bp.segmentId)).toEqual([
      'preset:jailbreak',
      'authors_note',
      'history:h2',
    ]);
    expect(result.report.breakpoints.map((bp) => bp.layer)).toEqual([
      'static',
      'session',
      'history',
    ]);
  });

  it('locked 段绝不动', () => {
    const segments = sample().map((segment) =>
      segment.id === 'worldinfo:before' || segment.id === 'injection:deep'
        ? { ...segment, locked: true }
        : segment,
    );
    const result = layoutCacheAware(segments, ctx({ tailWindow: 1 }));
    expect(ids(result.segments)).toContain('worldinfo:before');
    expect(ids(result.segments)).not.toContain(WI_CARRIER_SEGMENT_ID);
    expect(result.segments.find((s) => s.id === 'injection:deep')?.anchor.depth).toBe(8);
    expect(result.report.moves.some((move) => move.segmentId === 'worldinfo:before')).toBe(false);
  });

  it('policy.lockedSegmentIds 与 locked 字段等价', () => {
    const result = layoutCacheAware(
      sample(),
      ctx({ tailWindow: 1, lockedSegmentIds: ['worldinfo:before'] }),
    );
    expect(ids(result.segments)).toContain('worldinfo:before');
  });

  it('estimatedCacheablePrefixTokens = static + session 前缀', () => {
    const result = layoutCacheAware(sample(), ctx());
    const prefixEnd = result.segments.findIndex(
      (segment) => segment.stability !== 'static' && segment.stability !== 'session',
    );
    const expected = result.segments
      .slice(0, prefixEnd)
      .reduce(
        (sum, segment) =>
          sum + estimateTokens(segment.parts[0]?.type === 'text' ? segment.parts[0].text : ''),
        0,
      );
    expect(result.report.estimatedCacheablePrefixTokens).toBe(expected);
  });

  it('ttl 写进 cachePlan', () => {
    const result = layoutCacheAware(sample(), ctx({ ttl: '1h' }));
    expect(result.cachePlan.ttl).toBe('1h');
  });
});

// ───────────── diff ─────────────

describe('diffLayouts', () => {
  it('按 id 对齐，输出 moved / clamped / unchanged', () => {
    const segments = sample();
    const strict = layoutStrict(segments, ctx({ tailWindow: 1 }));
    const cacheAware = layoutCacheAware(segments, ctx({ tailWindow: 1 }));
    const diff = diffLayouts(
      toIr(strict.segments, strict.cachePlan),
      toIr(cacheAware.segments, cacheAware.cachePlan),
    );
    expect(diff.moved).toContain('worldinfo:before');
    expect(diff.moved).toContain(WI_CARRIER_SEGMENT_ID);
    expect(diff.clamped).toContain('injection:deep');
    expect(diff.unchanged).toBeGreaterThan(0);
  });

  it('strict 与自身 diff 时全部 unchanged', () => {
    const strict = layoutStrict(sample(), ctx());
    const ir = toIr(strict.segments, strict.cachePlan);
    const diff = diffLayouts(ir, ir);
    expect(diff.moved).toEqual([]);
    expect(diff.clamped).toEqual([]);
    expect(diff.unchanged).toBe(strict.segments.length);
  });
});
