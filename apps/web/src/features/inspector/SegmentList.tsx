import { estimateTokens, type PromptIR, type Segment } from '@newtavern/core';
import { ChevronDown, Lock, Zap } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ORIGIN_BAR_CLASS, segmentText, type LayoutBreakpoint, type LayoutMove } from './types';
import { Badge } from '../../components/ui/badge';
import { cn } from '../../lib/utils';

export interface SegmentListProps {
  ir: PromptIR;
  /** 布局报告里的断点（带层级与估算 token）；strict 参照视图不传 */
  breakpoints?: LayoutBreakpoint[];
  /** 本段的移动 / 夹紧标注 */
  moves?: LayoutMove[];
  /** 跳转后高亮的段 id */
  focusId?: string | null;
  /** 点「跳到原位」 */
  onJump?: (segmentId: string) => void;
}

export function SegmentList({ ir, breakpoints, moves, focusId, onJump }: SegmentListProps) {
  const { t } = useTranslation();
  if (ir.segments.length === 0) {
    return <p className="p-4 text-sm text-ink-2">{t('inspector.segments.empty')}</p>;
  }

  const bpAt = new Map<number, LayoutBreakpoint>();
  for (const breakpoint of breakpoints ?? []) bpAt.set(breakpoint.index, breakpoint);
  // 布局报告没给断点时退回 IR 的 cachePlan（strict 模式下两者一致）
  if (!breakpoints) {
    for (const index of ir.cachePlan.breakpoints) {
      const segment = ir.segments[index];
      if (segment) bpAt.set(index, { index, segmentId: segment.id, layer: 'static', estTokens: 0 });
    }
  }

  return (
    <ol className="divide-y divide-edge">
      {ir.segments.map((segment, index) => {
        const breakpoint = bpAt.get(index);
        return (
          <li key={segment.id}>
            <SegmentCard
              segment={segment}
              moves={(moves ?? []).filter((move) => move.segmentId === segment.id)}
              focused={focusId === segment.id}
              {...(onJump ? { onJump } : {})}
            />
            {breakpoint && <BreakpointRow breakpoint={breakpoint} />}
          </li>
        );
      })}
    </ol>
  );
}

/** 单个段：左侧 2px 明度色条 + 元信息 + 可折叠正文；不填底、下方一根发丝线 */
function SegmentCard({
  segment,
  moves,
  focused,
  onJump,
}: {
  segment: Segment;
  moves: LayoutMove[];
  focused: boolean;
  onJump?: (segmentId: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const text = segmentText(segment);
  const tokens = estimateTokens(text);

  return (
    <article
      id={`nt-segment-${segment.id}`}
      data-part="segment"
      data-origin={segment.origin.kind}
      className={cn(
        'relative ps-3',
        focused && 'outline outline-2 -outline-offset-2 outline-accent',
      )}
    >
      <span
        aria-hidden
        data-part="segment-bar"
        className={cn('absolute inset-y-0 start-0 w-0.5', ORIGIN_BAR_CLASS[segment.origin.kind])}
      />
      <div data-part="segment-header" className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2.5">
        <span className="text-xs font-medium">{t(`inspector.origins.${segment.origin.kind}`)}</span>
        <Badge variant="muted">{segment.role}</Badge>
        <Badge variant="outline">{t(`inspector.stability.${segment.stability}`)}</Badge>
        {segment.anchor.slot === 'history' && segment.anchor.depth !== undefined && (
          <Badge variant="outline">
            {t('inspector.segments.depth', { depth: segment.anchor.depth })}
          </Badge>
        )}
        <span className="ms-auto flex items-center gap-1.5">
          {segment.volatile && (
            <Zap aria-label={t('inspector.flags.volatile')} className="size-3.5 text-accent" />
          )}
          {segment.locked && (
            <Lock aria-label={t('inspector.flags.locked')} className="size-3.5 text-ink-2" />
          )}
          <span className="text-[11px] text-ink-2 tabular-nums">
            {t('inspector.segments.tokens', { total: tokens })}
          </span>
        </span>
      </div>

      <button
        type="button"
        data-part="segment-body"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="block w-full cursor-pointer px-2.5 pt-1.5 pb-2 text-left focus-ring-inset"
      >
        <span
          className={cn(
            'block text-xs leading-relaxed whitespace-pre-wrap text-ink-2',
            !expanded && 'line-clamp-3',
          )}
        >
          {text || '—'}
        </span>
        <span className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent">
          <ChevronDown aria-hidden className={cn('size-3', expanded && 'rotate-180')} />
          {expanded ? t('common.collapse') : t('common.expand')}
        </span>
      </button>

      {moves.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-2.5 pb-2.5">
          {moves.map((move) => (
            <button
              key={`${move.segmentId}-${move.kind}`}
              type="button"
              disabled={!onJump}
              onClick={() => onJump?.(move.segmentId)}
              title={move.reason}
              // moved / clamped 是唯一用强调色的地方（DESIGN §3）
              className="chip-accent focus-ring inline-flex cursor-pointer items-center gap-1 px-2 py-0.5 text-[11px] transition-opacity hover:opacity-70 disabled:pointer-events-none"
            >
              {move.kind === 'clamped'
                ? t('inspector.moves.clamped', {
                    from: move.from.depth ?? 0,
                    to: move.to.depth ?? 0,
                  })
                : t(`inspector.moves.${move.kind}`)}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}

/** 缓存断点分隔线：含层级与估算 token；belowMin 用语义危险色 */
function BreakpointRow({ breakpoint }: { breakpoint: LayoutBreakpoint }) {
  const { t } = useTranslation();
  const below = breakpoint.belowMin === true;
  return (
    <div className="flex items-center gap-2 px-1 py-1.5" role="separator">
      <span className={cn('h-px flex-1', below ? 'bg-danger' : 'bg-edge')} />
      <span
        className={cn(
          'rounded-pill border px-2 py-0.5 text-[10px] whitespace-nowrap',
          below ? 'border-danger text-danger' : 'border-edge text-ink-3',
        )}
      >
        {t('inspector.breakpoint', {
          layer: t(`inspector.layers.${breakpoint.layer}`),
          tokens: breakpoint.estTokens.toLocaleString(),
        })}
        {below ? ` · ${t('inspector.belowMin')}` : ''}
      </span>
      <span className={cn('h-px flex-1', below ? 'bg-danger' : 'bg-edge')} />
    </div>
  );
}
