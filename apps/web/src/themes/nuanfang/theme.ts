import * as signature from './signature';
import type { ThemeMeta } from '../registry';

/**
 * 暖房 · Nuanfang —— 一间午后的温室。
 * 世界设定见 docs/DESIGN.md §3.6；槽位赋值与形态覆盖见同目录 theme.css。
 */
const nuanfang: ThemeMeta = {
  id: 'nuanfang',
  name: { zh: '暖房', en: 'Nuanfang' },
  tagline: {
    zh: '午后的温室：奶油色的墙，圆滚滚的软垫，桌上一只冒热气的马克杯，窗台上一小盆绿。',
    en: 'A greenhouse in the afternoon: cream walls, round cushions, a steaming mug and a little pot on the sill.',
  },
  modes: ['light'],
  defaultMode: 'light',
  fonts: {
    story: '霞鹜文楷 屏幕版',
    ui: '圆体（Yuanti SC / 幼圆）/ 思源黑体',
    display: '霞鹜文楷 屏幕版（楷意，带字距）',
  },
  preview: {
    canvas: 'oklch(0.97 0.02 85)',
    reading: 'oklch(0.99 0.01 90)',
    ink: 'oklch(0.35 0.04 50)',
    primary: 'oklch(0.72 0.14 15)',
  },
  signature: {
    SendButton: signature.SendButton,
    SwipeIndicator: signature.SwipeIndicator,
    AvatarFrame: signature.AvatarFrame,
    MessageDivider: signature.MessageDivider,
    EmptyIllustration: signature.EmptyIllustration,
    StreamingCursor: signature.StreamingCursor,
    MessageOrnament: signature.MessageOrnament,
    Backdrop: signature.Backdrop,
  },
  loadFonts: () =>
    Promise.all([
      import('lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css'),
      import('@fontsource/noto-sans-sc/chinese-simplified-400.css'),
      import('@fontsource/noto-sans-sc/chinese-simplified-500.css'),
    ]).then(() => undefined),
};

export default nuanfang;
