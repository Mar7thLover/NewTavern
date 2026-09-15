import { useId } from 'react';

import { stableHash, type EmptyIllustrationKind } from '../signature';
import { cn } from '../../lib/utils';

/**
 * 琉璃的空状态插画：一块悬浮在冰室里的冰棱（双头六棱柱），里面封着几粒气泡。
 * 光从左上来：左面最亮、右面带一点冰青，棱线是白的高光，一条棱上折出 25% 的虹。
 * 冰棱之下不是阴影，而是一圈透下去的冷光。
 * 气泡的排布按 kind 稳定地变化——每个空页面是同一块冰的不同时刻。
 */

/** 三组气泡布局（坐标在冰棱本地坐标系里，半径 1.2–4.4） */
const BUBBLE_SETS: ReadonlyArray<ReadonlyArray<readonly [number, number, number]>> = [
  [
    [74, 58, 3.4],
    [86, 74, 1.8],
    [70, 88, 2.4],
    [90, 98, 4.2],
    [78, 112, 1.4],
  ],
  [
    [84, 54, 2.2],
    [72, 70, 4.4],
    [88, 86, 1.6],
    [76, 102, 2.8],
    [86, 116, 1.2],
    [70, 118, 1.8],
  ],
  [
    [76, 52, 1.6],
    [88, 64, 3.2],
    [72, 80, 1.4],
    [84, 94, 2.2],
    [74, 108, 3.8],
  ],
];

export function IceShard({
  kind,
  className,
}: {
  kind: EmptyIllustrationKind;
  className?: string | undefined;
}) {
  const raw = useId();
  const id = `liuli-shard-${raw.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const bubbles = BUBBLE_SETS[stableHash(kind) % BUBBLE_SETS.length] ?? BUBBLE_SETS[0] ?? [];
  const tilt = (stableHash(`tilt-${kind}`) % 3) * 4 - 16; // -16 / -12 / -8 度

  return (
    <svg aria-hidden viewBox="0 0 160 170" className={cn('liuli-shard', className)} fill="none">
      <defs>
        <radialGradient id={`${id}-pool`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="var(--liuli-light)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--liuli-light)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}-left`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--liuli-glint)" stopOpacity="0.95" />
          <stop offset="1" stopColor="var(--liuli-ice-2)" stopOpacity="0.35" />
        </linearGradient>
        <linearGradient id={`${id}-right`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--liuli-ice-1)" stopOpacity="0.55" />
          <stop offset="1" stopColor="var(--liuli-ice-3)" stopOpacity="0.5" />
        </linearGradient>
        <linearGradient id={`${id}-iris`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="oklch(0.84 0.1 195)" />
          <stop offset="0.5" stopColor="oklch(0.76 0.1 295)" />
          <stop offset="1" stopColor="oklch(0.9 0.08 88)" />
        </linearGradient>
      </defs>

      {/* 冰棱之下透下去的冷光 */}
      <ellipse cx="80" cy="156" rx="40" ry="6" fill={`url(#${id}-pool)`} />

      <g className="liuli-shard-float">
        <g transform={`rotate(${tilt} 80 84)`}>
          {/* 上端两块斜面 */}
          <path d="M80 14 L58 46 L84 54 Z" fill={`url(#${id}-left)`} />
          <path d="M80 14 L84 54 L102 44 Z" fill="var(--liuli-ice-1)" fillOpacity="0.5" />
          {/* 主体两面 */}
          <path d="M58 46 L84 54 L84 118 L58 108 Z" fill={`url(#${id}-left)`} fillOpacity="0.8" />
          <path d="M84 54 L102 44 L102 106 L84 118 Z" fill={`url(#${id}-right)`} />
          {/* 下端两块斜面 */}
          <path d="M58 108 L84 118 L78 150 Z" fill="var(--liuli-ice-2)" fillOpacity="0.45" />
          <path d="M84 118 L102 106 L78 150 Z" fill="var(--liuli-ice-3)" fillOpacity="0.45" />

          {/* 封在里面的气泡 */}
          {bubbles.map(([cx, cy, r], index) => (
            <g key={index}>
              <circle
                cx={cx}
                cy={cy}
                r={r}
                fill="var(--liuli-glint)"
                fillOpacity="0.18"
                stroke="var(--liuli-glint)"
                strokeOpacity="0.85"
                strokeWidth="0.7"
              />
              {r > 2 && (
                <circle
                  cx={cx - r * 0.35}
                  cy={cy - r * 0.35}
                  r={r * 0.28}
                  fill="var(--liuli-glint)"
                  fillOpacity="0.9"
                />
              )}
            </g>
          ))}

          {/* 外轮廓：极细的冷线 */}
          <path
            d="M80 14 L102 44 L102 106 L78 150 L58 108 L58 46 Z"
            stroke="var(--liuli-ice-line)"
            strokeWidth="0.8"
            strokeLinejoin="round"
          />
          {/* 中棱与左上棱：白色高光 */}
          <path
            d="M80 14 L84 54 L84 118"
            stroke="var(--liuli-glint)"
            strokeOpacity="0.95"
            strokeWidth="0.9"
            strokeLinecap="round"
          />
          <path
            d="M58 46 L80 14"
            stroke="var(--liuli-glint)"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
          {/* 右棱折出的虹：只 1 条、25% */}
          <path
            d="M102 44 L102 106"
            stroke={`url(#${id}-iris)`}
            strokeOpacity="0.25"
            strokeWidth="1.2"
          />
        </g>
      </g>
    </svg>
  );
}
