import { useId, type CSSProperties } from 'react';

import type {
  AvatarFrameProps,
  BackdropProps,
  EmptyIllustrationProps,
  MessageDividerProps,
  MessageOrnamentProps,
  SendButtonProps,
  StreamingCursorProps,
  SwipeIndicatorProps,
} from '../signature';
import { cn } from '../../lib/utils';

/**
 * 酒馆 · Jiuguan 的记忆物件（docs/DESIGN.md §3.4）。
 *
 *  1. 黄铜灯发送键：圆形浮雕黄铜，按下陷进去 3px；生成中灯芯发光、呼吸。
 *  2. 羊皮纸条 + 黄铜铆钉：每条消息是一张略歪的羊皮纸条，左上角一颗 6px 铆钉（MessageOrnament）。
 *  3. 蜡封 swipe：深红蜡滴，上压当前序号。
 *  4. 铜框肖像：头像嵌在黄铜圆框里（形态在 theme.css 的 .avatar-frame）。
 *  5. 空状态：一盏灯与一杯酒，单线带投影。
 *
 * 材质、光影、模式差异全部在 theme.css；这里只出结构与 SVG。
 * 注意：不要从 '../signature' 引入值（registry 会 eager 导入本文件，值引入会形成循环）。
 */

/** FNV-1a：同一条消息永远得到同一张纸条 */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** SVG 渐变 id：useId 带冒号，url(#…) 里不能用 */
function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

/* ------------------------------------------------------------------ */
/* 1. 黄铜灯发送键                                                      */
/* ------------------------------------------------------------------ */

const LAMP_PATHS = [
  // 提环
  'M10.7 5.7a1.3 1.3 0 1 1 2.6 0',
  'M12 7v1.5',
  // 灯罩顶盖
  'M9.3 8.6h5.4',
  // 玻璃罩
  'M10 8.6c-2.8 1.5-3.8 4.1-2.7 6.6.6 1.3 1.6 2.1 2.8 2.4h3.8c1.2-.3 2.2-1.1 2.8-2.4 1.1-2.5.1-5.1-2.7-6.6',
  // 灯座
  'M9.8 17.6l-.7 1.7h5.8l-.7-1.7',
  'M7.6 20.2h8.8',
];

const FLAME_PATH = 'M12 10.7c1 1.2 1.5 2.1 1.5 3a1.5 1.5 0 0 1-3 0c0-.9.5-1.8 1.5-3z';

export function SendButton({ state, disabled, label, onClick }: SendButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      data-lamp={state}
      className="jg-lamp focus-ring relative inline-flex size-10 shrink-0 cursor-pointer items-center justify-center disabled:cursor-not-allowed"
    >
      <span aria-hidden className="jg-lamp-glow" />
      <svg aria-hidden viewBox="0 0 24 24" className="jg-lamp-glyph relative size-[23px]">
        {/* 刻线的亮边：光从上来，槽的下壁被照亮 */}
        <g className="jg-cut-hi" transform="translate(0 0.75)">
          {LAMP_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
          <path d={FLAME_PATH} />
        </g>
        <g className="jg-cut">
          {LAMP_PATHS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
        <path className="jg-flame" d={FLAME_PATH} />
      </svg>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 3. 蜡封                                                             */
/* ------------------------------------------------------------------ */

/** 不规则的蜡滴轮廓：14 个半径起伏的点，用中点二次曲线闭合 */
const SEAL_PATH = (() => {
  const radii = [
    15.3, 14.2, 15.0, 14.5, 15.5, 14.1, 14.9, 15.4, 14.3, 15.1, 14.4, 15.4, 14.0, 14.8,
  ];
  const n = radii.length;
  const points = radii.map((r, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [16 + Math.cos(a) * r, 16 + Math.sin(a) * r] as const;
  });
  const mid = (i: number) => {
    const p = points[i % n]!;
    const q = points[(i + 1) % n]!;
    return `${((p[0] + q[0]) / 2).toFixed(2)} ${((p[1] + q[1]) / 2).toFixed(2)}`;
  };
  let d = `M${mid(n - 1)}`;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    d += `Q${p[0].toFixed(2)} ${p[1].toFixed(2)} ${mid(i)}`;
  }
  return `${d}Z`;
})();

export function SwipeIndicator({
  index,
  total,
  busy,
  labels,
  onPrev,
  onNext,
}: SwipeIndicatorProps) {
  const gradient = useSvgId('jg-wax-');
  const atEnd = index >= total - 1;
  return (
    <div className="jg-swipe flex items-center gap-1.5">
      <SealArrow dir="prev" label={labels.prev} disabled={index <= 0 || busy} onClick={onPrev} />
      {/* 一整枚蜡封：印模上压着「当前/总数」 */}
      <span className="jg-seal relative inline-flex size-9 shrink-0 items-center justify-center">
        <svg
          aria-hidden
          viewBox="0 0 32 32"
          className="absolute inset-0 size-full overflow-visible"
        >
          <defs>
            <radialGradient id={gradient} cx="36%" cy="30%" r="78%">
              <stop offset="0" className="jg-wax-hi" />
              <stop offset="0.5" className="jg-wax-mid" />
              <stop offset="1" className="jg-wax-lo" />
            </radialGradient>
          </defs>
          <path d={SEAL_PATH} fill={`url(#${gradient})`} />
          {/* 印模压出的环：上沿暗、下沿亮 */}
          <circle cx="16" cy="16.7" r="11.6" className="jg-wax-ring-hi" />
          <circle cx="16" cy="16" r="11.6" className="jg-wax-ring" />
        </svg>
        <span className="jg-seal-num relative tabular-nums">
          {index + 1}/{total}
        </span>
      </span>
      <SealArrow
        dir="next"
        label={atEnd ? labels.new : labels.next}
        disabled={busy}
        onClick={onNext}
      />
    </div>
  );
}

function SealArrow({
  dir,
  label,
  disabled,
  onClick,
}: {
  dir: 'prev' | 'next';
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
      className="jg-seal-arrow focus-ring inline-flex size-6 cursor-pointer items-center justify-center disabled:pointer-events-none"
    >
      <svg aria-hidden viewBox="0 0 12 12" className="size-3">
        <path d={dir === 'prev' ? 'M7.5 2.5 4 6l3.5 3.5' : 'M4.5 2.5 8 6 4.5 9.5'} />
      </svg>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 4. 铜框肖像（形态在 theme.css：黄铜边框 border-box + 肖像 padding-box） */
/* ------------------------------------------------------------------ */

export function AvatarFrame({ role, className, children }: AvatarFrameProps) {
  return (
    <div data-role={role} className={cn('avatar-frame relative shrink-0', className)}>
      {children}
    </div>
  );
}

/** 纸条之间露出的皮革就是分隔，不另画东西 */
export function MessageDivider(_props: MessageDividerProps) {
  return null;
}

/* ------------------------------------------------------------------ */
/* 2. 羊皮纸条 + 黄铜铆钉                                               */
/* ------------------------------------------------------------------ */

/** 每张纸条钉上去时歪的角度（度）：很小，只够让人觉得是手钉的 */
const TILTS = [-0.32, -0.16, 0.1, 0.22, 0.34, -0.06, 0.16];
/** 裁得不齐的四角 */
const SHAPES = [
  '9px 13px 8px 12px / 12px 8px 13px 9px',
  '12px 8px 11px 9px / 9px 12px 8px 13px',
  '8px 11px 13px 9px / 11px 9px 12px 8px',
  '11px 9px 8px 13px / 8px 13px 10px 11px',
  '10px 12px 9px 8px / 13px 10px 9px 12px',
];
/** 烧灼最重的那一角 */
const BURNS = ['0% 0%', '100% 0%', '100% 100%', '0% 100%', '50% 110%', '-10% 50%'];

export function MessageOrnament({ role, id }: MessageOrnamentProps) {
  const h = hash(id);
  const style = {
    '--jg-tilt': `${TILTS[h % TILTS.length]}deg`,
    '--jg-shape': SHAPES[(h >>> 4) % SHAPES.length],
    '--jg-burn-at': BURNS[(h >>> 9) % BURNS.length],
  } as CSSProperties;
  return (
    <>
      <div className="jg-strip" data-role={role} style={style} />
      <span className="jg-rivet" />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 5. 空状态：一盏灯与一杯酒                                            */
/* ------------------------------------------------------------------ */

export function EmptyIllustration({ className }: EmptyIllustrationProps) {
  const glow = useSvgId('jg-glow-');
  return (
    <svg
      aria-hidden
      viewBox="0 0 160 112"
      className={cn('jg-still-life h-[112px] w-[160px]', className)}
    >
      {/* 灯焰的光晕（只在夜灯下可见） */}
      <defs>
        <radialGradient id={glow}>
          <stop offset="0" className="jg-still-glow-core" />
          <stop offset="1" className="jg-still-glow-edge" />
        </radialGradient>
      </defs>
      <circle className="jg-still-glow" cx="52" cy="51" r="30" fill={`url(#${glow})`} />
      <g className="jg-still-lines">
        {/* 桌沿 */}
        <path d="M14 98.5h132" />
        <path className="jg-still-faint" d="M24 102.5h112" />
        {/* 灯：提环、顶盖、玻璃罩、灯焰、灯座 */}
        <path d="M47.5 21a4.5 4.5 0 0 1 9 0" />
        <path d="M52 25.5v6" />
        <path d="M43.5 31.5h17" />
        <path d="M46 31.5c-9.5 5-13 14.5-9.3 23.4 2 4.7 5.6 7.5 9.8 8.6h11c4.2-1.1 7.8-3.9 9.8-8.6 3.7-8.9.2-18.4-9.3-23.4" />
        <path d="M52 42c3.4 4.2 5 7.4 5 10.2a5 5 0 0 1-10 0c0-2.8 1.6-6 5-10.2z" />
        <path d="M52 57.2v6.3" />
        <path d="M45.5 63.5l-3 9h19l-3-9" />
        <path d="M38 72.5h28l2.5 6h-33z" />
        <path d="M33 78.5h38v4H33z" />
        <path d="M36 82.5l-1.5 16M68 82.5l1.5 16" />
        <path d="M36 90.5h32" />
        {/* 酒杯：杯身、酒面、杯柄、杯脚 */}
        <path d="M100 44h30c.6 12.5-4.8 22-15 23.5-10.2-1.5-15.6-11-15-23.5z" />
        <path className="jg-still-faint" d="M101.2 53.5c4.2 1.5 8.8 1.5 13.8 0s9.6-1.5 13.8 0" />
        <path d="M115 67.5v24" />
        <path d="M103 98.5c1.2-4.3 6-7 12-7s10.8 2.7 12 7" />
        {/* 杯壁上的一道高光 */}
        <path className="jg-still-faint" d="M104.5 48.5c-.2 5 .8 9 3 12" />
      </g>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 流式光标：纸上洇开的一点墨                                            */
/* ------------------------------------------------------------------ */

export function StreamingCursor({ kind }: StreamingCursorProps) {
  return (
    <span
      aria-hidden
      data-kind={kind}
      className="jg-ink-drop ms-[0.2em] inline-block size-[0.42em] translate-y-[-0.05em] rounded-full"
    />
  );
}

/* ------------------------------------------------------------------ */
/* 背景层：夜里是桌上那盏灯的光池，白天是窗里斜进来的光                    */
/* ------------------------------------------------------------------ */

export function Backdrop({ scope }: BackdropProps) {
  return (
    <>
      <div className="jg-light absolute inset-0" data-scope={scope} />
      <div className="jg-vignette absolute inset-0" data-scope={scope} />
    </>
  );
}
