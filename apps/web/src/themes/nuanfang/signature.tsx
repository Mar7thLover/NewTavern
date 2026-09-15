import { CatMugIllustration, STICKER_COUNT, Sticker, WindowsillScene } from './illustrations';
import {
  stableHash,
  type AvatarFrameProps,
  type BackdropProps,
  type EmptyIllustrationProps,
  type MessageDividerProps,
  type MessageOrnamentProps,
  type SendButtonProps,
  type StreamingCursorProps,
  type SwipeIndicatorProps,
} from '../signature';
import { cn } from '../../lib/utils';

/**
 * 暖房 · Nuanfang 的记忆物件（DESIGN §3.6）。
 *
 *  1. 软糖发送键：胶囊、杏子→草莓渐变、顶上一条糖衣高光，按下 scaleY(.94)，生成中像小动物一样呼吸
 *  2. 便签 + 贴纸：角色消息是一张便签，角上贴一枚按消息 id 稳定挑选、稳定歪斜的手绘贴纸
 *  3. 一串小豆子：swipe 指示是豆荚里的豆子，当前那颗是草莓色的软糖豆
 *  4. 贴纸头像：圆形 + 3px 奶油描边
 *  5. 空状态：马克杯里冒着热气的小猫
 *  6. 窗台：背景左下角的马克杯与小盆栽
 *
 * 形态全部由 theme.css 里的 `[data-nf=…]` 规则画出来，这里只出结构。
 */

/* ------------------------------------------------------------------ */
/* 1. 软糖发送键                                                        */
/* ------------------------------------------------------------------ */

export function SendButton({ state, disabled, label, onClick }: SendButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-nf="jelly"
      data-state={state}
      className="focus-ring shrink-0 cursor-pointer disabled:cursor-not-allowed"
    >
      <span data-nf="jelly-body">
        <svg viewBox="0 0 24 24" aria-hidden focusable="false" data-nf="jelly-icon">
          {state === 'generating' ? (
            <rect x="7.5" y="7.5" width="9" height="9" rx="2.8" fill="currentColor" />
          ) : (
            <path
              d="M12 18.5 V6.5 M6.8 11.5 L12 6.3 L17.2 11.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}
        </svg>
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 3. 一串小豆子                                                        */
/* ------------------------------------------------------------------ */

/** 豆荚里最多放几颗豆子；更多时只显示当前附近的一段，并在旁边写上「n/m」 */
const MAX_BEANS = 7;

export function SwipeIndicator({
  index,
  total,
  busy,
  labels,
  onPrev,
  onNext,
}: SwipeIndicatorProps) {
  const atEnd = index >= total - 1;
  const count = Math.min(total, MAX_BEANS);
  const start = Math.min(Math.max(0, index - Math.floor(MAX_BEANS / 2)), total - count);
  const beans = Array.from({ length: count }, (_, i) => start + i);

  return (
    <div data-nf="beans" className="flex items-center gap-1">
      <BeanArrow
        direction="prev"
        label={labels.prev}
        disabled={index <= 0 || busy}
        onClick={onPrev}
      />
      <span data-nf="pod" data-busy={busy} aria-hidden>
        {beans.map((bean) => (
          <span key={bean} data-nf="bean" data-current={bean === index} />
        ))}
      </span>
      {total > MAX_BEANS ? (
        <span data-nf="bean-count" className="tabular-nums">
          {index + 1}/{total}
        </span>
      ) : (
        <span className="sr-only">
          {index + 1} / {total}
        </span>
      )}
      <BeanArrow
        direction="next"
        label={atEnd ? labels.new : labels.next}
        disabled={busy}
        onClick={onNext}
        grows={atEnd}
      />
    </div>
  );
}

function BeanArrow({
  direction,
  label,
  disabled,
  onClick,
  grows = false,
}: {
  direction: 'prev' | 'next';
  label: string;
  disabled: boolean;
  onClick: () => void;
  /** 在最后一颗时，「下一颗」就是再长一颗新豆子：画成一个小加号 */
  grows?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-nf="bean-arrow"
      className="focus-ring cursor-pointer disabled:pointer-events-none"
    >
      <svg viewBox="0 0 16 16" aria-hidden focusable="false">
        <path
          d={
            grows
              ? 'M8 4.5 V11.5 M4.5 8 H11.5'
              : direction === 'prev'
                ? 'M9.5 4.5 L6 8 L9.5 11.5'
                : 'M6.5 4.5 L10 8 L6.5 11.5'
          }
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 4. 贴纸头像                                                          */
/* ------------------------------------------------------------------ */

export function AvatarFrame({ role, className, children }: AvatarFrameProps) {
  return (
    <div data-role={role} className={cn('avatar-frame shrink-0', className)}>
      {children}
    </div>
  );
}

/** 便签本身就是分隔：两张便签之间只有留白 */
export function MessageDivider(_props: MessageDividerProps) {
  return null;
}

/* ------------------------------------------------------------------ */
/* 5. 空状态：杯子里的小猫                                               */
/* ------------------------------------------------------------------ */

export function EmptyIllustration({ kind, className }: EmptyIllustrationProps) {
  return <CatMugIllustration kind={kind} className={cn('h-auto w-40', className)} />;
}

/** 流式光标：一颗草莓色的小圆豆，轻轻地跳 */
export function StreamingCursor({ kind }: StreamingCursorProps) {
  return <span aria-hidden data-nf="caret" data-kind={kind} />;
}

/* ------------------------------------------------------------------ */
/* 2. 便签上的贴纸                                                      */
/* ------------------------------------------------------------------ */

/** 贴纸线色：草莓 / 薄荷 / 焦糖，同样按 id 稳定挑 */
const TONES = ['berry', 'mint', 'caramel'] as const;

export function MessageOrnament({ role, id }: MessageOrnamentProps) {
  if (role !== 'assistant') return null;
  const hash = stableHash(id);
  const variant = hash % STICKER_COUNT;
  const tone = TONES[(hash >>> 8) % TONES.length];
  // -13° … +13°，同一条消息每次都歪成一样
  const tilt = ((hash >>> 16) % 27) - 13;
  return (
    <span data-nf="sticker" data-tone={tone} style={{ transform: `rotate(${tilt}deg)` }}>
      <Sticker variant={variant} />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* 6. 背景：午后的光 + 窗台                                              */
/* ------------------------------------------------------------------ */

export function Backdrop({ scope }: BackdropProps) {
  return (
    <>
      <span data-nf="sunlight" data-scope={scope} />
      <WindowsillScene className={scope === 'app' ? 'nf-sill' : 'nf-sill nf-sill-mini'} />
    </>
  );
}
