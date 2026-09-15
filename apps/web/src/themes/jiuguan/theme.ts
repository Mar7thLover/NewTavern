import * as signature from './signature';
import type { ThemeMeta } from '../registry';

/**
 * 酒馆 · Jiuguan —— 一间真的酒馆。
 * 世界设定见 docs/DESIGN.md §3.4；槽位、材质与光影见同目录 theme.css。
 */
const jiuguan: ThemeMeta = {
  id: 'jiuguan',
  name: { zh: '酒馆', en: 'Jiuguan' },
  tagline: {
    zh: '一间真的酒馆：橡木桌、皮面账本、黄铜灯与铆钉，今晚的故事写在羊皮纸条上。',
    en: 'A real tavern: oak table, leather ledger, brass lamp and rivets — tonight’s story on parchment slips.',
  },
  modes: ['light', 'dark'],
  defaultMode: 'dark',
  fonts: {
    story: '霞鹜文楷 屏幕版',
    ui: '思源宋体',
    display: '霞鹜文楷 屏幕版',
  },
  preview: {
    canvas: 'oklch(0.3 0.04 55)',
    reading: 'oklch(0.885 0.042 80)',
    ink: 'oklch(0.25 0.04 50)',
    primary: 'oklch(0.8 0.115 83)',
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
  // 思源宋体只取 400 与 700（每个字重约 1.5 MB，500/600 由浏览器就近匹配）
  loadFonts: () =>
    Promise.all([
      import('lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css'),
      import('@fontsource/noto-serif-sc/chinese-simplified-400.css'),
      import('@fontsource/noto-serif-sc/chinese-simplified-700.css'),
    ]).then(() => undefined),
};

export default jiuguan;
