import { InkstoneAndBrush } from './illustrations';
import { hanzi } from './numerals';
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
 * 书斋 · Shuzhai 的记忆物件（DESIGN §3.2）。
 *
 *  1. 朱砂印发送键：方形、圆角 3px、白文「言」；按下像盖章（theme.css `.sz-seal`）
 *  2. 回目式分隔：每一轮由用户开启，前面居中一行细小的「第三回」，两侧各一段细双线
 *  3. 竹签 swipe：消息右侧一枚竹签，竖写「二／三」（窄屏平放在操作条里）
 *  4. 头像：角色是朱文方印，用户是圆形墨戳
 *  5. 空状态：一方砚台与一支笔；流式光标：一支笔尖的竖线，不闪不呼吸
 * 形态、颜色、印泥的不匀全部在 theme.css；这里只出结构。
 */

/* ------------------------------------------------------------------ */
/* 1. 朱砂印                                                            */
/* ------------------------------------------------------------------ */

/** 小篆意味的「言」：一点、三横、一口，笔画等粗，转角微圆 */
function GlyphYan() {
  return (
    <>
      <path d="M10 2.4v2.5" />
      <path d="M4 6.4c0-.6.4-1 1-1h10c.6 0 1 .4 1 1" />
      <path d="M6 8.9h8" />
      <path d="M6 11.6h8" />
      <path d="M5.6 14.2h8.8v4.4H5.6z" />
    </>
  );
}

/** 「止」：生成中，这枚印变成停笔 */
function GlyphZhi() {
  return (
    <>
      <path d="M10 3.2v14" />
      <path d="M10 9.4h4.6" />
      <path d="M5.6 8.4v8.8" />
      <path d="M3.4 17.2h13.2" />
    </>
  );
}

export function SendButton({ state, disabled, label, onClick }: SendButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-state={state}
      className="sz-seal focus-ring relative inline-flex size-9 shrink-0 cursor-pointer items-center justify-center disabled:cursor-not-allowed"
    >
      <svg
        viewBox="0 0 20 20"
        aria-hidden
        focusable="false"
        className="sz-seal-glyph relative size-[21px]"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.55}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {state === 'generating' ? <GlyphZhi /> : <GlyphYan />}
      </svg>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 3. 竹签                                                              */
/* ------------------------------------------------------------------ */

function Chevron() {
  return (
    <svg
      viewBox="0 0 8 5"
      aria-hidden
      focusable="false"
      className="sz-slip-chevron block h-[5px] w-2"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.1}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1 4 4 1l3 3" />
    </svg>
  );
}

export function SwipeIndicator({
  index,
  total,
  busy,
  labels,
  onPrev,
  onNext,
}: SwipeIndicatorProps) {
  const atEnd = index >= total - 1;
  const nextLabel = atEnd ? labels.new : labels.next;
  return (
    <div
      role="group"
      aria-label={`${index + 1} / ${total}`}
      data-single={total <= 1}
      className="sz-slip"
    >
      <button
        type="button"
        aria-label={labels.prev}
        title={labels.prev || undefined}
        disabled={index <= 0 || busy}
        onClick={onPrev}
        className="sz-slip-arrow focus-ring"
        data-dir="prev"
      >
        <Chevron />
      </button>
      <span aria-hidden className="sz-slip-count">
        {hanzi(index + 1)}
        <span className="sz-slip-sep">／</span>
        {hanzi(total)}
      </span>
      <button
        type="button"
        aria-label={nextLabel}
        title={nextLabel || undefined}
        disabled={busy}
        onClick={onNext}
        className="sz-slip-arrow focus-ring"
        data-dir="next"
      >
        <Chevron />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 4. 印与墨戳                                                          */
/* ------------------------------------------------------------------ */

export function AvatarFrame({ role, className, children }: AvatarFrameProps) {
  return (
    <div data-role={role} className={cn('avatar-frame sz-stamp shrink-0', className)}>
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 2. 回目                                                              */
/* ------------------------------------------------------------------ */

/**
 * 每一回由用户的一句话开启：开场白是楔子，不标；
 * 路径下标 1、3、5 的用户消息依次是第一、二、三回（没有开场白时 2、4 是第二、三回，第一回不标）。
 */
export function MessageDivider({ role, index }: MessageDividerProps) {
  if (role !== 'user') return null;
  const chapter = Math.floor(index / 2) + 1;
  return (
    <div aria-hidden className="sz-chapter">
      <span className="sz-chapter-rule" />
      <span className="sz-chapter-text">第{hanzi(chapter)}回</span>
      <span className="sz-chapter-rule" />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 5. 砚与笔                                                            */
/* ------------------------------------------------------------------ */

export function EmptyIllustration({ className }: EmptyIllustrationProps) {
  return <InkstoneAndBrush className={cn('sz-empty', className)} />;
}

/** 笔尖的竖线：上细、腹微丰、下收成锋；固定不动 */
export function StreamingCursor({ kind }: StreamingCursorProps) {
  return (
    <span
      aria-hidden
      data-kind={kind}
      className="sz-nib ms-[0.18em] inline-block h-[1.15em] w-[5px] translate-y-[0.2em]"
    >
      <svg viewBox="0 0 5 20" className="block size-full" focusable="false">
        <path
          d="M2.5 0c.9 4.6 1.2 10.4.95 15.6L2.5 20l-.95-4.4C1.3 10.4 1.6 4.6 2.5 0Z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 立绘框：一页画心（形态在 media.css 的 .sz-leaf）                        */
/* ------------------------------------------------------------------ */

/** 白文「人」：两笔，笔画等粗 */
function GlyphRen() {
  return (
    <>
      <path d="M10.4 3.2c-.3 5.6-2.4 10.2-6.6 13.8" />
      <path d="M10.2 8.6c1.4 3.6 3.4 6.4 6.2 8.4" />
    </>
  );
}

/**
 * 人画在一页比阅读面略白的纸上：纸叠在页面上（边缘一条暗线，没有影），
 * 纸上印着外粗内细的双线版框，左下角钤一方白文小印。换表情不做过渡（--sprite-fade: 0）。
 * 折叠成头像时是一方细墨线框住的小像。
 */
export function SpriteFrame({ layout, collapsed, children }: SpriteFrameProps) {
  return (
    <div
      data-part="sprite-frame"
      data-layout={layout}
      data-collapsed={collapsed}
      className="sz-leaf relative size-full"
    >
      <div className="sz-leaf-view">{children}</div>
      {!collapsed && (
        <svg aria-hidden viewBox="0 0 20 20" className="sz-leaf-seal">
          <GlyphRen />
        </svg>
      )}
    </div>
  );
}
