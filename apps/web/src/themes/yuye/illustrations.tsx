import { useId } from 'react';

import type { EmptyIllustrationKind } from '../signature';

/**
 * 空状态插画：雨窗与窗台上的一杯热饮（DESIGN §3.5）。
 * 全部自绘：线用 currentColor，玻璃上的水与雾用蓝白，唯一的暖色是窗外远处那盏灯（--accent）。
 * 不同页面只换窗台上杯子旁的一件小东西，窗与雨不变。
 */
export function RainWindow({
  kind,
  className,
}: {
  kind: EmptyIllustrationKind;
  className?: string;
}) {
  const uid = useId().replace(/:/g, '');
  const glass = `yy-glass-${uid}`;
  const fog = `yy-fog-${uid}`;

  return (
    <svg
      aria-hidden
      viewBox="0 0 200 150"
      width="200"
      height="150"
      fill="none"
      className={className}
    >
      <defs>
        <clipPath id={glass}>
          <rect x="44" y="10" width="112" height="100" rx="3" />
        </clipPath>
        <linearGradient id={fog} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0" />
          <stop offset="0.55" stopColor="currentColor" stopOpacity="0.03" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.1" />
        </linearGradient>
      </defs>

      {/* 玻璃里：远灯（光晕 + 一点）、雨痕、下缘的雾 */}
      <g clipPath={`url(#${glass})`}>
        <circle cx="128" cy="72" r="16" style={{ fill: 'var(--accent)' }} opacity="0.07" />
        <circle cx="128" cy="72" r="6" style={{ fill: 'var(--accent)' }} opacity="0.16" />
        <circle cx="128" cy="72" r="1.8" style={{ fill: 'var(--accent)' }} opacity="0.95" />
        {/* 灯光在湿玻璃上往下拖出的一道 */}
        <rect
          x="127.2"
          y="76"
          width="1.6"
          height="22"
          rx="0.8"
          style={{ fill: 'var(--accent)' }}
          opacity="0.12"
        />

        <g stroke="currentColor" strokeLinecap="round" strokeWidth="0.9">
          <path d="M66 14 60.4 26" opacity="0.28" />
          <path d="M92 30 88.6 37.4" opacity="0.2" />
          <path d="M140 18 134 31" opacity="0.24" />
          <path d="M76 52 72.2 60" opacity="0.18" />
          <path d="M110 40 105.2 50.4" opacity="0.26" />
          <path d="M150 50 147 56.6" opacity="0.18" />
          <path d="M58 70 54.6 77.4" opacity="0.2" />
          <path d="M100 76 96.8 83" opacity="0.16" />
        </g>

        {/* 顺着玻璃流下的两道水痕，末端挂着水珠 */}
        <path
          d="M84 12c.4 10-1.2 18-.4 28s1 16 .2 24"
          stroke="currentColor"
          strokeWidth="0.8"
          opacity="0.2"
        />
        <ellipse cx="83.8" cy="66.4" rx="1.6" ry="2" fill="currentColor" opacity="0.4" />
        <path
          d="M116 20c-.6 8 .8 14 .2 22"
          stroke="currentColor"
          strokeWidth="0.7"
          opacity="0.16"
        />
        <ellipse cx="116.2" cy="44" rx="1.3" ry="1.6" fill="currentColor" opacity="0.34" />

        <rect x="44" y="10" width="112" height="100" fill={`url(#${fog})`} />
      </g>

      {/* 窗框：外框、竖棂、横棂 */}
      <rect
        x="44"
        y="10"
        width="112"
        height="100"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.3"
        opacity="0.5"
      />
      <path d="M100 10v100M44 58h112" stroke="currentColor" strokeWidth="1.1" opacity="0.38" />

      {/* 窗台 */}
      <path d="M26 110h148" stroke="currentColor" strokeWidth="1.4" opacity="0.55" />
      <path d="M32 116h136" stroke="currentColor" strokeWidth="1" opacity="0.22" />

      {/* 热饮：杯身、杯把、碟 */}
      <path
        d="M70 88h26l-2.4 17.2a3 3 0 0 1-3 2.6H75.4a3 3 0 0 1-3-2.6Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
        opacity="0.8"
      />
      <path
        d="M95.4 92.2h2.4a4.2 4.2 0 0 1 0 8.4h-3.4"
        stroke="currentColor"
        strokeWidth="1.2"
        opacity="0.7"
      />
      <path
        d="M64 109.6h38"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity="0.6"
      />
      {/* 热气：两缕，轻轻明灭（theme.css 里的 yy-steam，reduced-motion 下静止） */}
      <g stroke="currentColor" strokeWidth="1" strokeLinecap="round" className="yy-steam">
        <path d="M78 83c-3-4 3-6 0-10s2-6 0-9" opacity="0.32" />
        <path d="M87 84c-2.6-3.4 2.6-5.2 0-8.6s1.8-5 0-7.6" opacity="0.22" />
      </g>

      <SillThing kind={kind} />
    </svg>
  );
}

/** 杯子旁的小东西：随页面换一件，全都是窗台上会有的物品 */
function SillThing({ kind }: { kind: EmptyIllustrationKind }) {
  const common = {
    stroke: 'currentColor',
    strokeWidth: 1.1,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (kind) {
    case 'characters':
    case 'personas':
      // 一张倚着窗的旧照片
      return (
        <g opacity="0.55">
          <path d="M116 108.8 121 88l15 3.6-5 20.2" {...common} />
          <path d="M120.4 92.6 132 95.4l-2.6 10.6" {...common} opacity="0.5" />
        </g>
      );
    case 'lorebooks':
    case 'presets':
      // 两本平放的书
      return (
        <g opacity="0.55">
          <rect x="112" y="102" width="34" height="7.6" rx="1" {...common} />
          <rect x="116" y="95" width="28" height="7" rx="1" {...common} opacity="0.7" />
        </g>
      );
    case 'connections':
    case 'regex':
      // 一台小收音机
      return (
        <g opacity="0.55">
          <rect x="114" y="94" width="30" height="15.6" rx="2.4" {...common} />
          <circle cx="122.4" cy="101.8" r="4" {...common} opacity="0.7" />
          <path d="M132 99h7M132 103h7M136 94l6-7" {...common} opacity="0.6" />
        </g>
      );
    case 'chat':
    case 'chats':
    default:
      // 摊开的一张信纸
      return (
        <g opacity="0.5">
          <path d="M112 109.4 118 101h26l-4 8.4" {...common} />
          <path d="M121 104.2h16" {...common} opacity="0.5" />
        </g>
      );
  }
}
