import { RainWindow } from './illustrations';
import {
  stableHash,
  type AvatarFrameProps,
  type BackdropProps,
  type EmptyIllustrationProps,
  type MessageDividerProps,
  type MessageOrnamentProps,
  type SendButtonProps,
  type SpriteFrameProps,
  type StreamingCursorProps,
  type SwipeIndicatorProps,
} from '../signature';
import { cn } from '../../lib/utils';

/**
 * 雨夜 · Yuye 的记忆物件（DESIGN §3.5）。
 *
 *  1. 远灯发送键：圆形暗铜底，中心一点暖光；悬停光晕扩大，生成中呼吸
 *  2. 背景的雨：三层不同远近的斜雨 + 胶片颗粒 + 远处一盏灯（Backdrop）
 *  3. 水痕分隔：一道从左侧淡入淡出的 1px 蓝白线，线头挂一颗水珠
 *  4. swipe 指示：消息右侧一组小水珠，当前那颗映着灯光
 *  5. 空状态：雨窗与窗台上的一杯热饮
 * 形态与动效全部在 theme.css（`yy-*` 类，写在 @scope 里）。
 */

/* ------------------------------------------------------------------ */
/* 1. 远灯发送键                                                        */
/* ------------------------------------------------------------------ */

export function SendButton({ state, disabled, label, onClick }: SendButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-state={state}
      className="yy-lamp focus-ring"
    >
      <span aria-hidden className="yy-lamp-halo" />
      <span aria-hidden className="yy-lamp-core" />
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 4. swipe：一组小水珠                                                 */
/* ------------------------------------------------------------------ */

/** 超过这个数量就只显示当前附近的几颗，再加一行等宽小字 */
const MAX_DROPS = 7;

export function SwipeIndicator({
  index,
  total,
  busy,
  labels,
  onPrev,
  onNext,
}: SwipeIndicatorProps) {
  const atEnd = index >= total - 1;
  // 只有一条时不画水珠：只留一个「再生成」的入口，跟其它操作一起悬停才出现
  const single = total <= 1;
  const count = single ? 0 : Math.min(total, MAX_DROPS);
  // 窗口：让当前那颗尽量居中
  const start = Math.max(0, Math.min(index - Math.floor(count / 2), total - count));
  const drops = Array.from({ length: count }, (_, i) => start + i);

  return (
    <div className="yy-swipe" data-single={single}>
      <button
        type="button"
        aria-label={labels.prev}
        title={labels.prev}
        disabled={index <= 0 || busy}
        onClick={onPrev}
        className="yy-swipe-step focus-ring"
      >
        <Chevron direction="prev" />
      </button>
      <span className="yy-drops" aria-hidden>
        {drops.map((i) => (
          <span
            key={i}
            className="yy-drop"
            data-current={i === index}
            // 水珠大小各不相同，但对同一个位置固定
            data-size={stableHash(`drop-${i}`) % 3}
          />
        ))}
      </span>
      <span className={total > MAX_DROPS ? 'yy-swipe-count' : 'sr-only'}>
        {index + 1} / {total}
      </span>
      <button
        type="button"
        aria-label={atEnd ? labels.new : labels.next}
        title={atEnd ? labels.new : labels.next}
        disabled={busy}
        onClick={onNext}
        className="yy-swipe-step focus-ring"
      >
        <Chevron direction="next" />
      </button>
    </div>
  );
}

function Chevron({ direction }: { direction: 'prev' | 'next' }) {
  return (
    <svg aria-hidden viewBox="0 0 8 12" className="size-2.5">
      <path
        d={direction === 'prev' ? 'M6 1.5 1.8 6 6 10.5' : 'M2 1.5 6.2 6 2 10.5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 头像：起雾的小窗                                                     */
/* ------------------------------------------------------------------ */

export function AvatarFrame({ role, className, children }: AvatarFrameProps) {
  return (
    <div data-role={role} className={cn('avatar-frame yy-avatar shrink-0', className)}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 3. 水痕分隔                                                          */
/* ------------------------------------------------------------------ */

/** 每道水痕的长度略有不同（对同一个位置固定），不像尺子画的线 */
const TRACE_LENGTHS = ['58%', '72%', '46%', '64%', '52%'] as const;

export function MessageDivider({ role, index }: MessageDividerProps) {
  const length = TRACE_LENGTHS[index % TRACE_LENGTHS.length];
  return (
    <div
      aria-hidden
      role="presentation"
      data-role={role}
      className="yy-trace"
      style={{ width: length }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* 5. 空状态                                                            */
/* ------------------------------------------------------------------ */

export function EmptyIllustration({ kind, className }: EmptyIllustrationProps) {
  return <RainWindow kind={kind} className={cn('yy-empty', className)} />;
}

/* ------------------------------------------------------------------ */
/* 流式光标：玻璃上一颗将落未落的水珠，轻轻明灭                           */
/* ------------------------------------------------------------------ */

export function StreamingCursor({ kind }: StreamingCursorProps) {
  return <span aria-hidden data-kind={kind} className="yy-caret" />;
}

/* ------------------------------------------------------------------ */
/* 消息装饰：用户消息写在起雾的玻璃上，偶有一两颗水珠                     */
/* ------------------------------------------------------------------ */

/** 水珠的候选位置（相对消息右上角），每条消息稳定地挑一组 */
const BEADS: readonly (readonly { top: string; right: string; size: number }[])[] = [
  [{ top: '16%', right: '18px', size: 7 }],
  [{ top: '58%', right: '16px', size: 7 }],
  [{ top: '62%', right: '28px', size: 6 }],
  [{ top: '18%', right: '24px', size: 6.5 }],
];

export function MessageOrnament({ role, id }: MessageOrnamentProps) {
  if (role !== 'user') return null;
  const set = BEADS[stableHash(id) % BEADS.length] ?? [];
  return (
    <>
      {set.map((bead, i) => (
        <span
          key={i}
          className="yy-bead"
          style={{ top: bead.top, right: bead.right, width: bead.size, height: bead.size * 1.15 }}
        />
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 2. 背景：窗外的夜、远灯、雨、颗粒                                      */
/* ------------------------------------------------------------------ */

export function Backdrop({ scope }: BackdropProps) {
  return (
    <div className="yy-night" data-scope={scope}>
      <span className="yy-far-lamp" />
      <span className="yy-rain yy-rain-far" />
      <span className="yy-rain yy-rain-mid" />
      <span className="yy-rain yy-rain-near" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 立绘框：隔着一扇湿玻璃（形态在 media.css 的 .yy-pane）                  */
/* ------------------------------------------------------------------ */

/**
 * 人在玻璃那一边：玻璃是一层很淡的夜蓝，上缘一道 1px 高光，下半截起了雾；
 * 玻璃上停着几颗水珠、挂着一两道流下来的水痕——都是静态的，不做滤镜，雨照常在背景里下。
 * 折叠成头像时是一枚起雾的圆玻璃。
 */
export function SpriteFrame({ layout, collapsed, children }: SpriteFrameProps) {
  return (
    <div
      data-part="sprite-frame"
      data-layout={layout}
      data-collapsed={collapsed}
      className="yy-pane relative size-full"
    >
      <div className="yy-pane-view">{children}</div>
      <span aria-hidden className="yy-pane-glass" />
      {!collapsed && (
        <>
          <span aria-hidden className="yy-pane-run" data-run="a" />
          <span aria-hidden className="yy-pane-run" data-run="b" />
        </>
      )}
    </div>
  );
}
