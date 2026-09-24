import * as signature from './signature';
import type { ThemeMeta } from '../registry';

/**
 * 雨夜 · Yuye —— 深夜的窗前，雨在玻璃上流，远处有一点暖黄的灯。
 * 世界设定见 docs/DESIGN.md §3.5；槽位与形态见同目录 theme.css。
 */
const yuye: ThemeMeta = {
  id: 'yuye',
  name: { zh: '雨夜', en: 'Yuye' },
  tagline: {
    zh: '深夜的窗前，雨在玻璃上流，远处有一点暖黄的灯。',
    en: 'A window late at night. Rain runs down the glass; far off, one warm lamp.',
  },
  modes: ['dark'],
  defaultMode: 'dark',
  fonts: {
    story: '霞鹜文楷 屏幕版',
    ui: '思源黑体',
    display: '霞鹜文楷 屏幕版',
  },
  preview: {
    canvas: 'oklch(0.19 0.045 258)',
    reading: 'oklch(0.25 0.035 255)',
    ink: 'oklch(0.88 0.02 245)',
    primary: 'oklch(0.82 0.1 75)',
  },
  signature: {
    SendButton: signature.SendButton,
    SwipeIndicator: signature.SwipeIndicator,
    AvatarFrame: signature.AvatarFrame,
    MessageDivider: signature.MessageDivider,
    EmptyIllustration: signature.EmptyIllustration,
    StreamingCursor: signature.StreamingCursor,
    SpriteFrame: signature.SpriteFrame,
    MessageOrnament: signature.MessageOrnament,
    Backdrop: signature.Backdrop,
  },
  options: [{ key: 'rain', label: { zh: '雨', en: 'Rain' }, default: 'on' }],
  loadFonts: () =>
    Promise.all([
      import('lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css'),
      import('@fontsource/noto-sans-sc/chinese-simplified-300.css'),
      import('@fontsource/noto-sans-sc/chinese-simplified-400.css'),
      import('@fontsource/noto-sans-sc/chinese-simplified-500.css'),
    ]).then(() => undefined),
};

export default yuye;
