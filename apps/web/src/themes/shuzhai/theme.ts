import * as signature from './signature';
import type { ThemeMeta } from '../registry';

/**
 * 书斋 · Shuzhai —— 一间旧书房。
 * 世界设定见 docs/DESIGN.md §3.2；槽位赋值、版框、印泥与竹签的形态见同目录 theme.css。
 */
const shuzhai: ThemeMeta = {
  id: 'shuzhai',
  name: { zh: '书斋', en: 'Shuzhai' },
  tagline: {
    zh: '一间旧书房。宣纸、墨、一枚朱砂印，字是主角。',
    en: 'An old study: rice paper, ink and a single cinnabar seal. The words come first.',
  },
  modes: ['light', 'dark'],
  defaultMode: 'light',
  fonts: {
    story: '思源宋体 Noto Serif SC',
    ui: '思源宋体 Noto Serif SC',
    display: '霞鹜文楷 LXGW WenKai Screen',
  },
  preview: {
    canvas: 'oklch(0.965 0.012 85)',
    reading: 'oklch(0.971 0.01 86)',
    ink: 'oklch(0.25 0.02 60)',
    primary: 'oklch(0.55 0.17 30)',
  },
  signature: {
    SendButton: signature.SendButton,
    SwipeIndicator: signature.SwipeIndicator,
    AvatarFrame: signature.AvatarFrame,
    MessageDivider: signature.MessageDivider,
    EmptyIllustration: signature.EmptyIllustration,
    StreamingCursor: signature.StreamingCursor,
    SpriteFrame: signature.SpriteFrame,
  },
  // 宋体两个字重（400 正文、500 名字与标题；不合成粗体），楷体只有常规
  loadFonts: () =>
    Promise.all([
      import('@fontsource/noto-serif-sc/chinese-simplified-400.css'),
      import('@fontsource/noto-serif-sc/chinese-simplified-500.css'),
      import('lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css'),
    ]).then(() => undefined),
  // 用户背景默认不显示；外观里打开「在素 / 书斋里也显示背景」后只盖淡化遮罩（M4（二）§A）
  backdrop: 'veil',
};

export default shuzhai;
