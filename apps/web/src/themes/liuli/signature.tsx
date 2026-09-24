import { useId, type CSSProperties } from 'react';

import { IceShard } from './illustrations';
import type {
  AvatarFrameProps,
  BackdropProps,
  EmptyIllustrationProps,
  MessageDividerProps,
  MessageOrnamentProps,
  SendButtonProps,
  SpriteFrameProps,
  StreamingCursorProps,
  SwipeIndicatorProps,
} from '../signature';
import { cn } from '../../lib/utils';

/**
 * 琉璃 · Liuli 的记忆物件（docs/DESIGN.md §3.1）。
 *
 *  1. 切面水晶发送键：正八边形的明亮式切割，八块斜面各自受光，台面里是一枚细箭头；
 *     悬停时边上的虹变亮，按下时透明度降低像被按进冰里，生成中内部的折射光缓慢流动。
 *  2. 光痕分隔：消息之间一道 1px 从透明到白到透明的光，最亮处随消息下标换位置（光从不同角度来）。
 *  3. 冰晶点 swipe：一串菱形小冰晶，当前项是实心的冰青。
 *  4. 空状态：悬浮的冰棱与其中的气泡（illustrations.tsx）。
 *  另有：用户消息垫一片薄冰（MessageOrnament）、冰室背景层（Backdrop）、冰丝光标。
 *
 * 形态与颜色都在 theme.css 里（这里只出结构与 SVG），组件不写颜色字面量。
 */

/* ------------------------------------------------------------------ */
/* 1. 切面水晶发送键                                                   */
/* ------------------------------------------------------------------ */

/** 正八边形（40×40，切角 11.72）与台面（缩到 0.5） */
const OUTER = [
  [11.72, 0],
  [28.28, 0],
  [40, 11.72],
  [40, 28.28],
  [28.28, 40],
  [11.72, 40],
  [0, 28.28],
  [0, 11.72],
] as const;
const TABLE = OUTER.map(([x, y]) => [20 + (x - 20) * 0.5, 20 + (y - 20) * 0.5] as const);

const points = (list: ReadonlyArray<readonly [number, number]>) =>
  list.map(([x, y]) => `${x},${y}`).join(' ');

export function SendButton({ state, disabled, label, onClick }: SendButtonProps) {
  const raw = useId();
  const id = `liuli-crystal-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-state={state}
      className="liuli-crystal relative inline-flex size-9 shrink-0 cursor-pointer items-center justify-center disabled:cursor-not-allowed"
    >
      {/* 晶体本身：八边形裁出来的折射渐变（生成中背景位置循环流动） */}
      <span aria-hidden className="liuli-crystal-body absolute inset-0" />
      <svg aria-hidden viewBox="-1 -1 42 42" className="liuli-crystal-cut absolute inset-0">
        <defs>
          <linearGradient id={`${id}-iris`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="oklch(0.84 0.1 195)" />
            <stop offset="0.5" stopColor="oklch(0.76 0.1 295)" />
            <stop offset="1" stopColor="oklch(0.9 0.08 88)" />
          </linearGradient>
        </defs>
        {OUTER.map((outer, index) => {
          const next = (index + 1) % OUTER.length;
          const facet = [outer, OUTER[next], TABLE[next], TABLE[index]].filter(
            (point): point is readonly [number, number] => point !== undefined,
          );
          return (
            <polygon
              key={index}
              points={points(facet)}
              className="liuli-facet"
              data-facet={index}
            />
          );
        })}
        <polygon points={points(TABLE)} className="liuli-table" />
        {/* 台面到外角的棱 */}
        {OUTER.map(([x, y], index) => {
          const inner = TABLE[index];
          return inner ? (
            <line key={index} x1={x} y1={y} x2={inner[0]} y2={inner[1]} className="liuli-ridge" />
          ) : null;
        })}
        {/* 外缘：白色受光边 + 1px 的虹 */}
        <polygon points={points(OUTER)} className="liuli-crystal-edge" />
        <polygon
          points={points(OUTER)}
          className="liuli-crystal-iris"
          stroke={`url(#${id}-iris)`}
        />
        {/* 焦点：沿八边形外扩一圈冰青线 */}
        <polygon
          points="11.3,-1.6 28.7,-1.6 41.6,11.3 41.6,28.7 28.7,41.6 11.3,41.6 -1.6,28.7 -1.6,11.3"
          className="liuli-crystal-focus"
        />
        {state === 'generating' ? (
          <rect x="16" y="16" width="8" height="8" rx="1.2" className="liuli-crystal-glyph-fill" />
        ) : (
          <path d="M20 26.5 V13.8 M15 18.6 L20 13.6 L25 18.6" className="liuli-crystal-glyph" />
        )}
      </svg>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 3. 冰晶点 swipe                                                     */
/* ------------------------------------------------------------------ */

/** 同时显示的冰晶上限；超过时以当前项为中心开窗，并在末尾补一个小计数 */
const MAX_CRYSTALS = 7;

export function SwipeIndicator({
  index,
  total,
  busy,
  labels,
  onPrev,
  onNext,
}: SwipeIndicatorProps) {
  const atEnd = index >= total - 1;
  const windowed = total > MAX_CRYSTALS;
  const start = windowed
    ? Math.min(Math.max(0, index - Math.floor(MAX_CRYSTALS / 2)), total - MAX_CRYSTALS)
    : 0;
  const count = windowed ? MAX_CRYSTALS : total;

  return (
    <div className="liuli-swipe">
      <Chevron
        direction="prev"
        label={labels.prev}
        disabled={index <= 0 || busy}
        onClick={onPrev}
      />
      <span aria-hidden className="liuli-grains">
        {Array.from({ length: count }, (_, offset) => {
          const position = start + offset;
          return (
            <svg
              key={position}
              viewBox="0 0 8 12"
              className="liuli-grain"
              data-current={position === index}
            >
              <path d="M4 0.6 L7.4 6 L4 11.4 L0.6 6 Z" className="liuli-grain-body" />
              <path d="M4 0.6 L0.6 6" className="liuli-grain-glint" />
            </svg>
          );
        })}
      </span>
      {windowed && (
        <span aria-hidden className="liuli-swipe-count">
          {index + 1}/{total}
        </span>
      )}
      <span className="sr-only">
        {index + 1} / {total}
      </span>
      <Chevron
        direction="next"
        label={atEnd ? labels.new : labels.next}
        disabled={busy}
        onClick={onNext}
      />
    </div>
  );
}

function Chevron({
  direction,
  label,
  disabled,
  onClick,
}: {
  direction: 'prev' | 'next';
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="liuli-chevron focus-ring"
    >
      <svg aria-hidden viewBox="0 0 10 10" className="liuli-chevron-glyph">
        <path
          d={direction === 'prev' ? 'M6.2 1.6 L2.8 5 L6.2 8.4' : 'M3.8 1.6 L7.2 5 L3.8 8.4'}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 头像：一方冰砖（角色）/ 一颗冰珠（用户），形态见 theme.css             */
/* ------------------------------------------------------------------ */

export function AvatarFrame({ role, className, children }: AvatarFrameProps) {
  return (
    <div data-role={role} className={cn('avatar-frame shrink-0', className)}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. 光痕                                                             */
/* ------------------------------------------------------------------ */

/** 光最亮处的横向位置：随下标轮换，像光从不同角度照进来 */
const TRACE_PEAKS = [38, 61, 47, 69, 31, 55] as const;

export function MessageDivider({ index }: MessageDividerProps) {
  const peak = TRACE_PEAKS[index % TRACE_PEAKS.length] ?? 50;
  return (
    <div
      aria-hidden
      className="liuli-trace"
      style={{ '--liuli-peak': `${peak}%` } as CSSProperties}
    />
  );
}

/* ------------------------------------------------------------------ */
/* 4. 空状态插画                                                       */
/* ------------------------------------------------------------------ */

export function EmptyIllustration({ kind, className }: EmptyIllustrationProps) {
  return <IceShard kind={kind} className={className} />;
}

/* ------------------------------------------------------------------ */
/* 冰丝光标                                                            */
/* ------------------------------------------------------------------ */

export function StreamingCursor({ kind }: StreamingCursorProps) {
  if (kind === 'reasoning') {
    return (
      <span aria-hidden className="liuli-thinking">
        <i />
        <i />
        <i />
      </span>
    );
  }
  return <span aria-hidden className="liuli-caret" />;
}

/* ------------------------------------------------------------------ */
/* 消息装饰：用户的话写在一片薄冰上                                      */
/* ------------------------------------------------------------------ */

export function MessageOrnament({ role }: MessageOrnamentProps) {
  if (role !== 'user') return null;
  return <span className="liuli-sheet" />;
}

/* ------------------------------------------------------------------ */
/* 冰室：竖立的冰板 + 缓慢漂移的冷光                                     */
/* ------------------------------------------------------------------ */

export function Backdrop({ scope }: BackdropProps) {
  const raw = useId();
  const id = `liuli-room-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <div className="liuli-room" data-scope={scope}>
      <svg
        className="liuli-panes"
        viewBox="0 0 1440 900"
        preserveAspectRatio="xMidYMid slice"
        aria-hidden
      >
        <defs>
          <linearGradient id={`${id}-pane`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--liuli-pane)" stopOpacity="1" />
            <stop offset="0.55" stopColor="var(--liuli-pane)" stopOpacity="0.35" />
            <stop offset="1" stopColor="var(--liuli-pane)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${id}-pane-r`} x1="1" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--liuli-pane)" stopOpacity="0.9" />
            <stop offset="0.6" stopColor="var(--liuli-pane)" stopOpacity="0.2" />
            <stop offset="1" stopColor="var(--liuli-pane)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${id}-edge`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--liuli-pane-edge)" stopOpacity="1" />
            <stop offset="0.7" stopColor="var(--liuli-pane-edge)" stopOpacity="0.4" />
            <stop offset="1" stopColor="var(--liuli-pane-edge)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`${id}-iris`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="oklch(0.84 0.1 195)" stopOpacity="0" />
            <stop offset="0.35" stopColor="oklch(0.84 0.1 195)" />
            <stop offset="0.6" stopColor="oklch(0.76 0.1 295)" />
            <stop offset="0.85" stopColor="oklch(0.9 0.08 88)" />
            <stop offset="1" stopColor="oklch(0.9 0.08 88)" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* 左边一块宽冰板，向右倾 */}
        <polygon points="96,-60 500,-60 404,960 -10,960" fill={`url(#${id}-pane)`} />
        <line
          x1="96"
          y1="-60"
          x2="-10"
          y2="960"
          stroke={`url(#${id}-edge)`}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1="500"
          y1="-60"
          x2="404"
          y2="960"
          className="liuli-pane-shade"
          vectorEffect="non-scaling-stroke"
        />
        {/* 左板右缘上一小段被折开的虹 */}
        <line
          x1="486"
          y1="90"
          x2="458"
          y2="390"
          stroke={`url(#${id}-iris)`}
          className="liuli-pane-iris"
          vectorEffect="non-scaling-stroke"
        />

        {/* 中间一条窄冰棱，刚好接住光 */}
        <polygon points="700,-60 760,-60 842,960 790,960" fill={`url(#${id}-pane)`} />
        <line
          x1="700"
          y1="-60"
          x2="790"
          y2="960"
          stroke={`url(#${id}-edge)`}
          vectorEffect="non-scaling-stroke"
        />

        {/* 右边一块冰板，向左倾，和左板在远处相叠 */}
        <polygon points="930,-60 1400,-60 1500,960 1030,960" fill={`url(#${id}-pane-r)`} />
        <line
          x1="1400"
          y1="-60"
          x2="1500"
          y2="960"
          stroke={`url(#${id}-edge)`}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1="930"
          y1="-60"
          x2="1030"
          y2="960"
          className="liuli-pane-shade"
          vectorEffect="non-scaling-stroke"
        />

        {/* 低处一块横卧的冰：地面的反光 */}
        <polygon
          points="-40,760 1480,640 1480,960 -40,960"
          fill={`url(#${id}-pane-r)`}
          opacity="0.6"
        />
      </svg>

      {/* 从四面照进来的冷光：三道很宽、很软的光带，慢慢横移 */}
      <span className="liuli-beam liuli-beam-a" />
      <span className="liuli-beam liuli-beam-b" />
      <span className="liuli-beam liuli-beam-c" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 立绘框：一面竖起的冰屏（形态在 media.css 的 .liuli-stand）             */
/* ------------------------------------------------------------------ */

/**
 * 人站在一面削了两角的冰屏前：屏是透的（不做 backdrop-filter，只是一层渐变的冰），
 * 边上一道白棱与 1px 的虹，脚下是冰屏的厚度（一条亮的横棱），一道斜光扫过左上的削角。
 * 折叠成头像时是一粒切角的冰晶。
 */
export function SpriteFrame({ layout, collapsed, children }: SpriteFrameProps) {
  return (
    <div
      data-part="sprite-frame"
      data-layout={layout}
      data-collapsed={collapsed}
      className="liuli-stand relative size-full"
    >
      <span aria-hidden className="liuli-stand-rim" />
      <span aria-hidden className="liuli-stand-pane" />
      <div className="liuli-stand-view">{children}</div>
      <span aria-hidden className="liuli-stand-glint" />
    </div>
  );
}
