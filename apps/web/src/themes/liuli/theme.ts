import * as signature from './signature';
import type { ThemeMeta } from '../registry';

/**
 * 琉璃 · Liuli —— 一间全由冰与琉璃砌成的亮室。
 * 世界设定见 docs/DESIGN.md §3.1；槽位与形态见同目录 theme.css，记忆物件见 signature.tsx。
 */
const liuli: ThemeMeta = {
  id: 'liuli',
  name: { zh: '琉璃', en: 'Liuli' },
  tagline: {
    zh: '一间冰与琉璃砌成的亮室。光从四面来，穿过层层透明的板，在边缘折出细细的虹。',
    en: 'A bright room of ice and glass. Light comes from every side and splits into a thin rainbow at the edges.',
  },
  modes: ['light', 'dark'],
  defaultMode: 'light',
  fonts: {
    story: '思源黑体 Light 300',
    ui: 'Inter Variable / 思源黑体',
    display: 'Inter Variable / 思源黑体',
  },
  preview: {
    canvas: 'oklch(0.985 0.006 220)',
    reading: 'oklch(0.99 0.004 220)',
    ink: 'oklch(0.28 0.02 240)',
    primary: 'oklch(0.7 0.1 205)',
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
      import('@fontsource-variable/inter/index.css'),
      import('@fontsource/noto-sans-sc/chinese-simplified-300.css'),
      import('@fontsource/noto-sans-sc/chinese-simplified-400.css'),
      import('@fontsource/noto-sans-sc/chinese-simplified-500.css'),
    ]).then(() => undefined),
};

export default liuli;
