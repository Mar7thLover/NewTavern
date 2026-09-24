import { countWords } from '@newtavern/core';
import type { Editor } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { AutosaveScheduler, type AutosaveStatus } from './autosave';
import { AiDecisionBar } from './AiDecisionBar';
import { docText, textToDocJson } from './editor/pending';
import { WritingEditor } from './editor/WritingEditor';
import type { DocSession, WritingAiController } from './useWritingAi';
import {
  createWritingVersion,
  saveWritingDocument,
  type WritingDocumentDetail,
} from '../../lib/api-writing';
import { cn } from '../../lib/utils';

export interface DocumentPaneProps {
  doc: WritingDocumentDetail;
  /** 章节序号（从 1 起；笔记为 null） */
  chapterNumber: number | null;
  lang: string;
  ai: WritingAiController;
  /** 顶栏两端的按钮（窄屏的目录 / 工具抽屉） */
  leading?: ReactNode;
  trailing?: ReactNode;
  onSession: (session: DocSession | null) => void;
  /** 有没有保存中 / 未保存的改动（离开拦截用） */
  onDirtyChange: (dirty: boolean) => void;
  onSelectionChange: (hasSelection: boolean) => void;
}

/**
 * 一个文档的编辑区（M7 §5.2）：顶部章节标题（可改）、字数、保存状态；下面是纸面上的编辑器。
 * 自动保存：停手 1.5 秒存一次、10 分钟有改动存一版；卸载（切章节）时把最后的改动存掉。
 */
export function DocumentPane({
  doc,
  chapterNumber,
  lang,
  ai,
  leading,
  trailing,
  onSession,
  onDirtyChange,
  onSelectionChange,
}: DocumentPaneProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AutosaveStatus>('saved');
  const [words, setWords] = useState(doc.wordCount);
  const [title, setTitle] = useState(doc.title);
  const titleSaved = useRef(doc.title);

  /** 编辑器最新的文档（ProseMirror 文档不可变，存引用就是快照） */
  const latestDoc = useRef<PmNode | null>(null);
  const docId = doc.id;

  const callbacks = useRef({ onSession, onDirtyChange, onSelectionChange });
  useEffect(() => {
    callbacks.current = { onSession, onDirtyChange, onSelectionChange };
  });

  const schedulerRef = useRef<AutosaveScheduler | null>(null);
  // 每个文档一个调度器；建在 effect 里（StrictMode 的模拟卸载会 dispose 掉旧的，再建一个新的）
  useEffect(() => {
    const scheduler = new AutosaveScheduler({
      save: async () => {
        const snapshot = latestDoc.current;
        if (!snapshot) return;
        await saveWritingDocument(queryClient, docId, {
          content: snapshot.toJSON() as Record<string, unknown>,
          text: docText(snapshot),
        });
      },
      snapshot: () => createWritingVersion(queryClient, docId, { author: 'user', label: 'auto' }),
      onStatus: (next) => {
        setStatus(next);
        callbacks.current.onDirtyChange(next !== 'saved');
      },
    });
    schedulerRef.current = scheduler;
    // 卸载（切文档 / 离开页面）：把没存的改动存掉
    return () => {
      void scheduler.flush().catch(() => undefined);
      scheduler.dispose();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
      callbacks.current.onDirtyChange(false);
    };
  }, [docId, queryClient]);

  // 字数：按服务端同一规则（中文按字、英文按词），停手后再数
  const countTimer = useRef<number | null>(null);
  const recount = () => {
    if (countTimer.current !== null) window.clearTimeout(countTimer.current);
    countTimer.current = window.setTimeout(() => {
      countTimer.current = null;
      if (latestDoc.current) setWords(countWords(docText(latestDoc.current)));
    }, 400);
  };
  useEffect(
    () => () => {
      if (countTimer.current !== null) window.clearTimeout(countTimer.current);
    },
    [],
  );

  const handleReady = (editor: Editor | null) => {
    if (!editor) {
      callbacks.current.onSession(null);
      return;
    }
    latestDoc.current = editor.state.doc;
    callbacks.current.onSession({
      docId,
      editor,
      flush: () => schedulerRef.current?.flush() ?? Promise.resolve(),
      noteVersioned: () => schedulerRef.current?.noteVersioned(),
      load: (content, text) => {
        // 恢复版本：服务端已经是这份稿了，换内容但不触发保存
        editor.commands.setContent(content ?? textToDocJson(text), { emitUpdate: false });
        latestDoc.current = editor.state.doc;
        setWords(countWords(docText(editor.state.doc)));
      },
    });
  };

  const handleChange = (editor: Editor) => {
    latestDoc.current = editor.state.doc;
    schedulerRef.current?.markDirty();
    recount();
  };

  const saveTitle = () => {
    const next = title.trim();
    if (next === titleSaved.current) return;
    titleSaved.current = next;
    void saveWritingDocument(queryClient, docId, { title: next }).catch(() => {
      titleSaved.current = '';
    });
  };

  const isNote = doc.kind === 'note';
  const fallbackTitle = isNote
    ? t('writing.tree.untitledNote')
    : t('writing.tree.chapterN', { n: chapterNumber ?? 1 });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        data-part="writing-header"
        className="edge-rule flex min-w-0 items-center gap-2 border-b px-3 py-2 sm:px-5"
      >
        {leading}
        <div className="min-w-0 flex-1">
          {!isNote && chapterNumber !== null && (
            <div className="text-[11px] text-ink-3 tabular-nums">
              {t('writing.tree.chapterN', { n: chapterNumber })}
            </div>
          )}
          <input
            data-part="writing-title"
            value={title}
            placeholder={fallbackTitle}
            aria-label={t('writing.editor.titleLabel')}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={saveTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                saveTitle();
                event.currentTarget.blur();
              }
            }}
            className="font-display focus-ring w-full min-w-0 truncate bg-transparent text-lg leading-tight text-ink outline-none placeholder:text-ink-3"
          />
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-ink-3">
          <span className="tabular-nums">{t('writing.editor.words', { count: words })}</span>
          <span
            data-part="writing-save-status"
            data-status={status}
            role="status"
            aria-live="polite"
            className={cn('hidden sm:inline', status === 'error' && 'text-danger')}
          >
            {t(`writing.editor.status.${status}`)}
          </span>
        </div>
        {trailing}
      </header>

      <div
        data-part="writing-scroll"
        className="relative min-h-0 flex-1 overflow-y-auto sm:px-6 sm:py-8"
      >
        <div data-part="writing-page" data-kind={doc.kind} className="surface-reading">
          <WritingEditor
            content={doc.content}
            text={doc.text}
            lang={lang}
            label={title || fallbackTitle}
            placeholder={
              isNote ? t('writing.editor.notePlaceholder') : t('writing.editor.placeholder')
            }
            onReady={handleReady}
            onChange={handleChange}
            onSelectionChange={(editor) =>
              callbacks.current.onSelectionChange(!editor.state.selection.empty)
            }
          />
        </div>
      </div>

      <AiDecisionBar ai={ai} />
    </div>
  );
}
