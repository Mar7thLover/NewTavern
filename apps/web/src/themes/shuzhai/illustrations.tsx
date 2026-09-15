import { cn } from '../../lib/utils';

/**
 * 空状态插画：一方砚台与一支笔（DESIGN §3.2）。
 * 全部是 currentColor 的细墨线；墨池是唯一的实心块。
 * 砚台正面微微俯视：砚面（外沿 + 砚堂内沿）、左上的墨池、右侧斜倚的一截墨锭；
 * 一支笔搁在砚沿上，笔锋探向墨池。
 */
export function InkstoneAndBrush({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 168 104"
      aria-hidden
      focusable="false"
      className={cn('h-auto w-40 text-ink-3', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.15}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* 砚面 */}
      <rect x="22" y="46" width="112" height="36" rx="3" />
      {/* 砚身厚度 */}
      <path d="M22 82v7.5c0 1.7 1.3 3 3 3h106c1.7 0 3-1.3 3-3V82" />
      <path d="M26 92.5v-6" opacity=".35" />
      {/* 砚堂内沿 */}
      <rect x="29.5" y="52" width="97" height="24" rx="1.6" opacity=".7" />
      {/* 墨池：一汪墨，唯一的实心 */}
      <path
        d="M36 60.5c0-3.3 5.6-5.5 12-5.5s12 2.2 12 5.5-5.6 5.5-12 5.5-12-2.2-12-5.5Z"
        fill="currentColor"
        fillOpacity=".78"
        stroke="none"
      />
      {/* 研墨留下的淡痕 */}
      <path d="M70 66c8-2.2 18-2.6 28-1.2" opacity=".32" />
      <path d="M74 70.5c6-1.4 13-1.6 20-.8" opacity=".22" />
      {/* 墨锭 */}
      <g transform="translate(100 63) rotate(-11)">
        <rect x="0" y="-4.5" width="24" height="9" rx=".8" />
        <path d="M5 -1.6h10" opacity=".5" />
      </g>
      {/* 笔：笔锋 → 笔箍 → 竹管 → 挂绳 */}
      <g transform="translate(47 45) rotate(-19)">
        <path
          d="M0 0c4.5-2.6 10.5-3.7 17-3.4v6.8C10.5 3.7 4.5 2.6 0 0Z"
          fill="currentColor"
          fillOpacity=".85"
        />
        <rect x="17" y="-3.6" width="6.5" height="7.2" rx=".6" />
        <path d="M23.5 -2.4H106M23.5 2.4H106M106 -2.4v4.8" />
        <path d="M44 -2.4v4.8M76 -2.4v4.8" opacity=".35" />
        <path d="M106 0c3.2 0 5.2 1.4 5.2 3.4s-2 3.4-4.6 3.4" opacity=".7" />
      </g>
      {/* 案面 */}
      <path d="M8 97.5h34M122 97.5h38" opacity=".35" />
    </svg>
  );
}
