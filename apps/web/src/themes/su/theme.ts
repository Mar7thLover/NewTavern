import * as signature from './signature';
import type { ThemeMeta } from '../registry';

/**
 * 素 · Su —— 一张白纸上的排版。
 * 世界设定与铁律见 docs/DESIGN.md §3.3；槽位赋值见同目录 theme.css。
 */
const su: ThemeMeta = {
  id: 'su',
  name: { zh: '素', en: 'Su' },
  tagline: {
    zh: '一张白纸上的排版。没有材质，没有光影，只有黑、白、一根线和一个色。',
    en: 'Type on white paper. No texture, no light — only black, white, one rule and one colour.',
  },
  modes: ['light', 'dark'],
  defaultMode: 'light',
  fonts: {
    story: 'Inter Variable / 思源黑体',
    ui: 'Inter Variable / 思源黑体',
    display: 'Inter Variable 300',
  },
  preview: {
    canvas: 'oklch(0.99 0 0)',
    reading: 'oklch(0.99 0 0)',
    ink: 'oklch(0.15 0 0)',
    primary: 'oklch(0.68 0.2 40)',
  },
  signature: {
    SendButton: signature.SendButton,
    SwipeIndicator: signature.SwipeIndicator,
    AvatarFrame: signature.AvatarFrame,
    MessageDivider: signature.MessageDivider,
    EmptyIllustration: signature.EmptyIllustration,
    StreamingCursor: signature.StreamingCursor,
  },
  loadFonts: () => import('@fontsource-variable/inter/index.css').then(() => undefined),
};

export default su;
