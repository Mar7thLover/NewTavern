import type { EmptyIllustrationKind } from '../signature';

/**
 * 暖房 · Nuanfang 的自绘插画（DESIGN §3.6）。
 *
 * 全部是 2px 圆头单线（stroke-linecap / linejoin = round），
 * 线色是 currentColor 或主题色变量（--nf-*，定义在 theme.css 的作用域根上），
 * 填色只用奶油、杏子、薄荷、草莓牛奶这几块软色——没有黑、没有冷灰、没有锐角。
 */

const LINE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/* ------------------------------------------------------------------ */
/* 贴纸：角色便签角上的小手绘（viewBox 32，单线 currentColor）           */
/* ------------------------------------------------------------------ */

/** 胖胖的圆角五角星 */
function StarSticker() {
  return (
    <path
      {...LINE}
      d="M16 6.2 L18.9 11.9 L25.2 12.8 L20.6 17.2 L21.7 23.5 L16 20.5 L10.3 23.5 L11.4 17.2 L6.8 12.8 L13.1 11.9 Z"
    />
  );
}

/** 一片叶子 + 叶脉 */
function LeafSticker() {
  return (
    <>
      <path {...LINE} d="M8 24.5 C8 14 14 7.5 25 7.5 C25 18 18.5 24.5 8 24.5 Z" />
      <path {...LINE} d="M8 24.5 L18.5 14" />
    </>
  );
}

/** 冒热气的马克杯 */
function MugSticker() {
  return (
    <>
      <path {...LINE} d="M8 13 H21 V20 Q21 25.5 15.5 25.5 H13.5 Q8 25.5 8 20 Z" />
      <path {...LINE} d="M21 15 Q25.5 15 25.5 18 Q25.5 21.5 21 21.5" />
      <path {...LINE} d="M12.5 9.5 Q11 8 12.5 6.5" />
      <path {...LINE} d="M17 9.5 Q15.5 8 17 6.5" />
    </>
  );
}

/** 一颗草莓 */
function StrawberrySticker() {
  return (
    <>
      <path
        {...LINE}
        d="M16 26.5 C9.5 23.5 7.5 18 8.8 14.3 C10 11.6 13 11.4 16 12.4 C19 11.4 22 11.6 23.2 14.3 C24.5 18 22.5 23.5 16 26.5 Z"
      />
      <path {...LINE} d="M12 11.5 L16 8.8 L20 11.5" />
      <path {...LINE} d="M16 8.8 V5.5" />
      <path
        {...LINE}
        d="M13 16.5 h0.01 M19 16.5 h0.01 M16 19.5 h0.01 M13.5 21.5 h0.01 M18.5 21.5 h0.01"
      />
    </>
  );
}

/** 四瓣小花 + 茎叶（花瓣填底色，交叠处不会露线） */
function FlowerSticker() {
  const petal = { ...LINE, fill: 'var(--nf-sticker-bg)' };
  return (
    <>
      <path {...LINE} d="M16 18 V27" />
      <path {...LINE} d="M16 24 Q19.5 20.5 22.5 22.5 Q20 26 16 24" />
      <circle {...petal} cx="16" cy="6.8" r="3.6" />
      <circle {...petal} cx="21.2" cy="12" r="3.6" />
      <circle {...petal} cx="16" cy="17.2" r="3.6" />
      <circle {...petal} cx="10.8" cy="12" r="3.6" />
      <circle {...petal} cx="16" cy="12" r="2.4" />
    </>
  );
}

/** 小盆栽发芽 */
function SproutSticker() {
  return (
    <>
      <path {...LINE} d="M10.5 19.5 H21.5 L20.2 26.5 H11.8 Z" />
      <path {...LINE} d="M16 19.5 V13.5" />
      <path {...LINE} d="M16 15 C12.5 15 9.8 13 9.8 9 C13.5 9 16 11 16 15" />
      <path {...LINE} d="M16 13 C16 9 18.5 6.5 22.5 6.5 C22.5 10.5 20 13 16 13" />
    </>
  );
}

/** 猫爪印 */
function PawSticker() {
  return (
    <>
      <path
        {...LINE}
        d="M10 21.5 C10 17.8 12.8 15.8 16 15.8 C19.2 15.8 22 17.8 22 21.5 C22 24.6 19.2 25.6 16 24.8 C12.8 25.6 10 24.6 10 21.5 Z"
      />
      <circle {...LINE} cx="8.6" cy="14.2" r="2" />
      <circle {...LINE} cx="13" cy="9.8" r="2.1" />
      <circle {...LINE} cx="19" cy="9.8" r="2.1" />
      <circle {...LINE} cx="23.4" cy="14.2" r="2" />
    </>
  );
}

/** 一朵软云 */
function CloudSticker() {
  return (
    <path
      {...LINE}
      d="M9.5 22.5 C6.5 22.5 5 20.5 5 18.3 C5 16 6.8 14.3 9 14.4 C9.4 11 12 8.8 15.2 8.8 C18.3 8.8 20.6 10.8 21.3 13.5 C24.6 13.2 27 15.4 27 18.2 C27 20.6 25.2 22.5 22.5 22.5 Z"
    />
  );
}

const STICKERS = [
  StarSticker,
  LeafSticker,
  MugSticker,
  StrawberrySticker,
  FlowerSticker,
  SproutSticker,
  PawSticker,
  CloudSticker,
] as const;

export const STICKER_COUNT = STICKERS.length;

/** 贴纸：奶油色的「模切底」+ 单线手绘。`variant` 由调用方按消息 id 稳定地挑 */
export function Sticker({ variant }: { variant: number }) {
  const Drawing = STICKERS[variant % STICKERS.length] ?? StarSticker;
  return (
    <svg viewBox="0 0 32 32" className="block size-full" aria-hidden focusable="false">
      <circle cx="16" cy="16" r="15" style={{ fill: 'var(--nf-sticker-bg)' }} />
      <Drawing />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 空状态：马克杯里冒着热气的小猫                                        */
/* ------------------------------------------------------------------ */

const BROWN = { stroke: 'var(--nf-line)' } as const;

/** 每种空状态在杯子旁边摆一件不同的小物件（杯子与猫不变） */
function Companion({ kind }: { kind: EmptyIllustrationKind }) {
  const line = { ...LINE, ...BROWN };
  switch (kind) {
    case 'chat':
    case 'chats':
      // 对话气泡里三颗豆子
      return (
        <g>
          <path
            {...line}
            style={{ fill: 'var(--nf-mint-soft)' }}
            d="M126 30 H148 Q156 30 156 38 V46 Q156 54 148 54 H140 L133 60 L134 54 H126 Q118 54 118 46 V38 Q118 30 126 30 Z"
          />
          <circle cx="129" cy="42" r="2.2" style={{ fill: 'var(--nf-mint)' }} />
          <circle cx="137" cy="42" r="2.2" style={{ fill: 'var(--nf-mint)' }} />
          <circle cx="145" cy="42" r="2.2" style={{ fill: 'var(--nf-mint)' }} />
        </g>
      );
    case 'characters':
    case 'personas':
      // 一张小名片，角上别一颗草莓色的扣子
      return (
        <g>
          <rect
            {...line}
            style={{ fill: 'var(--nf-milk)' }}
            x="128"
            y="102"
            width="26"
            height="32"
            rx="6"
            transform="rotate(8 141 118)"
          />
          <circle
            {...line}
            style={{ fill: 'var(--nf-apricot)' }}
            cx="141"
            cy="113"
            r="5"
            transform="rotate(8 141 118)"
          />
          <path {...line} d="M135 126 Q141 122 147 127" transform="rotate(8 141 118)" />
          <circle cx="152" cy="104" r="3" style={{ fill: 'var(--nf-berry)' }} />
        </g>
      );
    case 'presets':
      // 一把小勺子（调好的配方）
      return (
        <g>
          <ellipse
            {...line}
            style={{ fill: 'var(--nf-apricot)' }}
            cx="146"
            cy="108"
            rx="7"
            ry="9"
            transform="rotate(-28 146 108)"
          />
          <path {...line} d="M141 116 L128 136" />
        </g>
      );
    case 'lorebooks':
      // 一本合起来的小书，丝带书签垂下来
      return (
        <g>
          <rect
            {...line}
            style={{ fill: 'var(--nf-mint-soft)' }}
            x="126"
            y="112"
            width="30"
            height="22"
            rx="5"
          />
          <path {...line} d="M126 118 H156" />
          <path
            d="M148 134 V141 L151 138.5 L154 141 V134"
            {...line}
            style={{ fill: 'var(--nf-berry)' }}
          />
        </g>
      );
    case 'connections':
      // 一团毛线，线头拖出来
      return (
        <g>
          <circle {...line} style={{ fill: 'var(--nf-berry-milk)' }} cx="144" cy="120" r="12" />
          <path {...line} d="M135 113 Q144 118 153 113" />
          <path {...line} d="M133 122 Q144 128 155 121" />
          <path {...line} d="M140 109 Q136 120 142 131" />
          <path {...line} d="M132 128 Q124 136 116 132" />
        </g>
      );
    case 'regex':
      // 一块压了花纹的小饼干
      return (
        <g>
          <circle {...line} style={{ fill: 'var(--nf-apricot)' }} cx="143" cy="122" r="12" />
          <path
            {...line}
            d="M137 118 h0.01 M147 116 h0.01 M142 124 h0.01 M149 126 h0.01 M137 128 h0.01"
          />
        </g>
      );
    default:
      return null;
  }
}

export function CatMugIllustration({
  kind,
  className,
}: {
  kind: EmptyIllustrationKind;
  className?: string;
}) {
  const line = { ...LINE, ...BROWN, strokeWidth: 2.2 };
  return (
    <svg
      viewBox="0 0 160 150"
      className={className}
      aria-hidden
      focusable="false"
      data-nf="empty-illustration"
    >
      {/* 热气：三缕薄荷色 */}
      <g {...LINE} style={{ stroke: 'var(--nf-mint)' }} data-nf="steam">
        <path d="M34 60 q-6 -7 0 -14 q6 -7 0 -14" />
        <path d="M122 58 q-6 -7 0 -14 q6 -7 0 -14" />
        <path d="M75 24 q-4 -5 0 -10 q4 -5 0 -10" />
      </g>

      {/* 碟子 */}
      <ellipse {...line} style={{ fill: 'var(--nf-cream-deep)' }} cx="76" cy="138" rx="56" ry="7" />

      {/* 小猫：先画，杯子盖住它的下半身 */}
      <path
        {...line}
        style={{ fill: 'var(--nf-milk)' }}
        d="M48 90 C48 76 50 68 53 64 L54 51 Q55 47 59 50 L67 58 Q75 55 83 58 L91 50 Q95 47 96 51 L97 64 C100 68 102 76 102 90 Z"
      />
      <path d="M56.5 55 L57 62 L62 59 Z" style={{ fill: 'var(--nf-berry-milk)' }} />
      <path d="M93.5 55 L93 62 L88 59 Z" style={{ fill: 'var(--nf-berry-milk)' }} />
      <path {...line} d="M62 76 Q65 79 68 76" />
      <path {...line} d="M82 76 Q85 79 88 76" />
      <ellipse cx="58.5" cy="82" rx="4.2" ry="2.6" style={{ fill: 'var(--nf-berry-milk)' }} />
      <ellipse cx="91.5" cy="82" rx="4.2" ry="2.6" style={{ fill: 'var(--nf-berry-milk)' }} />
      <path d="M72.6 80.5 H77.4 L75 83 Z" style={{ fill: 'var(--nf-berry)' }} />
      <path {...line} strokeWidth={1.8} d="M75 83 Q73.5 86 71 85 M75 83 Q76.5 86 79 85" />

      {/* 杯身 + 杯把 */}
      <path
        {...line}
        style={{ fill: 'var(--nf-apricot)' }}
        d="M41 88 H111 Q116 88 116 93 V112 Q116 134 94 134 H58 Q36 134 36 112 V93 Q36 88 41 88 Z"
      />
      <path {...line} d="M116 96 Q136 96 136 110 Q136 124 116 124" />
      {/* 杯上一圈草莓色的点点 */}
      <circle cx="56" cy="110" r="3" style={{ fill: 'var(--nf-berry)' }} />
      <circle cx="76" cy="116" r="3" style={{ fill: 'var(--nf-berry)' }} />
      <circle cx="96" cy="110" r="3" style={{ fill: 'var(--nf-berry)' }} />

      {/* 搭在杯沿上的两只小爪子 */}
      <path {...line} style={{ fill: 'var(--nf-milk)' }} d="M52 89 Q52 82 59 82 Q66 82 66 89 Z" />
      <path {...line} style={{ fill: 'var(--nf-milk)' }} d="M84 89 Q84 82 91 82 Q98 82 98 89 Z" />
      <path {...line} strokeWidth={1.6} d="M59 85 V88 M91 85 V88" />

      <Companion kind={kind} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 背景：窗台上的马克杯与小盆栽                                          */
/* ------------------------------------------------------------------ */

export function WindowsillScene({ className }: { className?: string }) {
  const line = { ...LINE, ...BROWN };
  return (
    <svg viewBox="0 0 176 118" className={className} aria-hidden focusable="false">
      {/* 窗台：一条圆滚滚的杏子色木板 */}
      <rect x="2" y="100" width="172" height="14" rx="7" style={{ fill: 'var(--nf-sill)' }} />

      {/* 盆栽：圆胖的叶子 */}
      <path
        {...line}
        style={{ fill: 'var(--nf-mint-soft)' }}
        d="M52 62 C38 62 30 50 32 36 C46 36 54 46 52 62 Z"
      />
      <path
        {...line}
        style={{ fill: 'var(--nf-mint-soft)' }}
        d="M56 60 C56 42 66 30 82 30 C84 46 74 60 56 60 Z"
      />
      <path
        {...line}
        style={{ fill: 'var(--nf-mint-soft)' }}
        d="M54 58 C48 44 50 26 60 16 C68 28 64 46 54 58 Z"
      />
      <path {...line} d="M54 74 V58" />
      <path
        {...line}
        style={{ fill: 'var(--nf-pot)' }}
        d="M32 72 H78 L73 96 Q72 100 68 100 H42 Q38 100 37 96 Z"
      />
      <path
        {...line}
        style={{ fill: 'var(--nf-pot)' }}
        d="M29 68 Q29 64 33 64 H77 Q81 64 81 68 V70 Q81 74 77 74 H33 Q29 74 29 70 Z"
      />

      {/* 马克杯 + 热气 */}
      <g {...LINE} style={{ stroke: 'var(--nf-mint)' }} data-nf="steam">
        <path d="M118 52 q-5 -6 0 -12 q5 -6 0 -12" />
        <path d="M132 50 q-5 -6 0 -12 q5 -6 0 -12" />
      </g>
      <path
        {...line}
        style={{ fill: 'var(--nf-berry-milk)' }}
        d="M108 62 H142 Q146 62 146 66 V86 Q146 100 132 100 H118 Q104 100 104 86 V66 Q104 62 108 62 Z"
      />
      <path {...line} d="M146 70 Q158 70 158 79 Q158 88 146 88" />
      <path {...line} d="M117 78 Q125 84 133 78" />
    </svg>
  );
}
