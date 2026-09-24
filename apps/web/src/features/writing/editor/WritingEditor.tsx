import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import { useEffect, useRef } from 'react';

import { writingExtensions } from './extensions';
import { textToDocJson } from './pending';
import type { WritingContent } from '../../../lib/api-writing';

import '../writing.css';

export interface WritingEditorProps {
  content: WritingContent | null;
  /** content 为空时用纯文本起稿 */
  text: string;
  placeholder: string;
  /** 文档语言（中文的 em 用着重号而不是合成斜体） */
  lang: string;
  label: string;
  onReady: (editor: Editor | null) => void;
  onChange: (editor: Editor) => void;
  onSelectionChange?: (editor: Editor) => void;
}

/**
 * 写作纸面上的 TipTap 编辑器（M7 §5.2）。只负责编辑本身：保存、AI 在外面通过 `onReady` 拿到的
 * 编辑器实例上操作。每个文档一个实例（父组件以 docId 作 key）。
 */
export function WritingEditor({
  content,
  text,
  placeholder,
  lang,
  label,
  onReady,
  onChange,
  onSelectionChange,
}: WritingEditorProps) {
  const callbacks = useRef({ onReady, onChange, onSelectionChange });
  useEffect(() => {
    callbacks.current = { onReady, onChange, onSelectionChange };
  });

  const editor = useEditor({
    extensions: writingExtensions(placeholder),
    content: content ?? textToDocJson(text),
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: 'writing-prose',
        'data-part': 'writing-prose',
        lang,
        'aria-label': label,
        spellcheck: 'false',
      },
    },
    onUpdate: ({ editor: instance }) => callbacks.current.onChange(instance),
    onSelectionUpdate: ({ editor: instance }) => callbacks.current.onSelectionChange?.(instance),
  });

  useEffect(() => {
    callbacks.current.onReady(editor);
    return () => callbacks.current.onReady(null);
  }, [editor]);

  return <EditorContent editor={editor} className="writing-editor" />;
}
