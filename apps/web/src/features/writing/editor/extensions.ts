import { Extension, type AnyExtension } from '@tiptap/core';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';

import { aiPendingPlugin } from './pending';

/** AI 待定区 / 目标区（装饰，不进内容） */
export const AiPending = Extension.create({
  name: 'writingAiPending',
  addProseMirrorPlugins() {
    return [aiPendingPlugin()];
  },
});

/**
 * 写作编辑器的扩展集。小说正文用不上标题、列表、代码与链接：关掉，
 * 免得粘贴进来的网页格式把纸面弄乱（粘贴时这些结构会退成段落）。
 */
export function writingExtensions(placeholder = ''): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: false,
      code: false,
      codeBlock: false,
      link: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
    }),
    Placeholder.configure({ placeholder }),
    CharacterCount,
    AiPending,
  ];
}
