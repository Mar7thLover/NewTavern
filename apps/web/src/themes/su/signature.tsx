import type {
  AvatarFrameProps,
  EmptyIllustrationProps,
  MessageDividerProps,
  SendButtonProps,
  SpriteFrameProps,
  StreamingCursorProps,
  SwipeIndicatorProps,
} from '../signature';
import { cn } from '../../lib/utils';

/**
 * 素 · Su 的记忆物件（DESIGN §3.3）。
 * 它同时是引擎的 `_default`：新主题不覆盖的物件就长这样。
 *
 * 三件记忆物件：
 *  1. 黑色圆点发送键（悬停变国际橙、按下缩 4%，见 theme.css）
 *  2. 消息之间没有分隔物 —— MessageDivider 什么也不画
 *  3. 「2 / 3」纯文字 swipe + 两个排版用的极简箭头
 * 另外：空状态没有插画（只留一行大字），流式光标是 2px 实心块、固定不闪。
 */

/**
 * 1. 黑圆点发送键：直径 36px。
 * 空输入是 1px 墨色圆环（空心），有内容变实心黑（黑模式为白），
 * 悬停变国际橙，按下缩 4%（见 theme.css），生成中实心圆内挖一个方块。
 */
export function SendButton({ state, disabled, label, onClick }: SendButtonProps) {
  const hollow = state === 'idle';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'focus-ring inline-flex size-9 shrink-0 items-center justify-center rounded-pill',
        hollow
          ? 'cursor-not-allowed border border-ink bg-transparent'
          : 'action-primary cursor-pointer disabled:cursor-not-allowed',
      )}
    >
      {state === 'generating' && <span aria-hidden className="block size-2.5 bg-ink-on-primary" />}
    </button>
  );
}

/** 3. 「2 / 3」+ 两个极简箭头（用排版符号，不用图标库） */
export function SwipeIndicator({
  index,
  total,
  busy,
  labels,
  onPrev,
  onNext,
}: SwipeIndicatorProps) {
  const atEnd = index >= total - 1;
  return (
    <div className="flex items-center gap-1.5">
      <Arrow glyph="‹" label={labels.prev} disabled={index <= 0 || busy} onClick={onPrev} />
      <span className="min-w-9 text-center text-[11px] tabular-nums text-ink-3">
        {index + 1} / {total}
      </span>
      <Arrow glyph="›" label={atEnd ? labels.new : labels.next} disabled={busy} onClick={onNext} />
    </div>
  );
}

function Arrow({
  glyph,
  label,
  disabled,
  onClick,
}: {
  glyph: string;
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
      className="focus-ring inline-flex size-4 cursor-pointer items-center justify-center text-[15px] leading-none text-ink-2 transition-opacity hover:text-ink disabled:pointer-events-none disabled:opacity-25"
    >
      <span aria-hidden>{glyph}</span>
    </button>
  );
}

/** 头像框：只有圆角，没有描边、没有阴影 */
export function AvatarFrame({ role, className, children }: AvatarFrameProps) {
  return (
    <div data-role={role} className={cn('avatar-frame shrink-0', className)}>
      {children}
    </div>
  );
}

/** 2. 没有分隔物 —— 留白就是分隔 */
export function MessageDivider(_props: MessageDividerProps) {
  return null;
}

/** 没有插画，只有一行大字（大字由 EmptyState 自己排） */
export function EmptyIllustration(_props: EmptyIllustrationProps) {
  return null;
}

/** 流式光标：2px 宽的实心块，固定不闪 */
export function StreamingCursor({ kind }: StreamingCursorProps) {
  return (
    <span
      aria-hidden
      className={cn(
        'ms-[0.12em] inline-block h-[1.05em] w-[2px] translate-y-[0.15em]',
        kind === 'reasoning' ? 'bg-ink-2' : 'bg-ink',
      )}
    />
  );
}

/**
 * 立绘框：没有框。人站在一根 1px 的线上（stage），线就是地面；
 * 折叠成头像时和消息头像一样，只有图，不描边。
 */
export function SpriteFrame({ layout, collapsed, children }: SpriteFrameProps) {
  return (
    <div
      data-part="sprite-frame"
      data-layout={layout}
      data-collapsed={collapsed}
      className="su-stand relative size-full"
    >
      {children}
    </div>
  );
}
