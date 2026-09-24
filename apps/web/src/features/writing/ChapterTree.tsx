import { Check, ChevronDown, ChevronUp, GripVertical, MoreHorizontal, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../components/ui/icon-button';
import type { WritingDocumentSummary, WritingProjectDetail } from '../../lib/api-writing';
import { cn } from '../../lib/utils';

export const OUTLINE_DOC = 'outline';

export interface ChapterTreeProps {
  project: WritingProjectDetail;
  /** 当前打开的文档 id，或 `OUTLINE_DOC` */
  current: string | null;
  summarizing: string | null;
  busy?: boolean;
  onSelect: (id: string) => void;
  onCreate: (kind: 'chapter' | 'note') => void;
  onReorder: (ids: string[]) => void;
  onToggleDone: (doc: WritingDocumentSummary) => void;
  onSummarize: (doc: WritingDocumentSummary) => void;
  onDelete: (doc: WritingDocumentSummary) => void;
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/**
 * 左栏（`data-part="writing-tree"`）：章节（拖拽排序、完成标记、摘要过期小标、字数）、笔记分组、大纲入口。
 * 拖放沿用脚本库的原生 HTML5 拖放；触屏（没有拖放）用上移 / 下移。
 */
export function ChapterTree({
  project,
  current,
  summarizing,
  busy = false,
  onSelect,
  onCreate,
  onReorder,
  onToggleDone,
  onSummarize,
  onDelete,
}: ChapterTreeProps) {
  const { t } = useTranslation();
  const chapters = project.documents.filter((doc) => doc.kind === 'chapter');
  const notes = project.documents.filter((doc) => doc.kind === 'note');

  return (
    <nav
      data-part="writing-tree"
      aria-label={t('writing.tree.title')}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <button
          type="button"
          data-part="writing-tree-item"
          data-kind="outline"
          data-active={current === OUTLINE_DOC}
          onClick={() => onSelect(OUTLINE_DOC)}
          className={cn(
            'rounded-control focus-ring relative mb-3 flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left text-sm',
            current === OUTLINE_DOC ? 'font-medium text-accent' : 'text-ink-story hover:text-ink',
          )}
        >
          {t('writing.tree.outline')}
          {project.outline.trim() === '' && (
            <span className="text-[11px] text-ink-3">{t('writing.tree.outlineEmpty')}</span>
          )}
        </button>

        <TreeSection
          title={t('writing.tree.chapters')}
          addLabel={t('writing.tree.newChapter')}
          disabled={busy}
          onAdd={() => onCreate('chapter')}
        >
          {chapters.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-ink-3">{t('writing.tree.emptyChapters')}</p>
          ) : (
            <DocList
              docs={chapters}
              numbered
              current={current}
              summarizing={summarizing}
              onSelect={onSelect}
              onReorder={onReorder}
              onToggleDone={onToggleDone}
              onSummarize={onSummarize}
              onDelete={onDelete}
            />
          )}
        </TreeSection>

        <TreeSection
          title={t('writing.tree.notes')}
          addLabel={t('writing.tree.newNote')}
          disabled={busy}
          onAdd={() => onCreate('note')}
        >
          {notes.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-ink-3">{t('writing.tree.emptyNotes')}</p>
          ) : (
            <DocList
              docs={notes}
              numbered={false}
              current={current}
              summarizing={summarizing}
              onSelect={onSelect}
              onReorder={onReorder}
              onToggleDone={onToggleDone}
              onSummarize={onSummarize}
              onDelete={onDelete}
            />
          )}
        </TreeSection>
      </div>
      <div className="edge-rule shrink-0 border-t px-4 py-2.5 text-[11px] text-ink-3 tabular-nums">
        {t('writing.tree.total', { chapters: project.chapterCount, words: project.wordCount })}
      </div>
    </nav>
  );
}

function TreeSection({
  title,
  addLabel,
  disabled,
  onAdd,
  children,
}: {
  title: string;
  addLabel: string;
  disabled: boolean;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <section className="mb-4">
      <div className="flex items-center justify-between px-2.5 pb-1">
        <h2 className="text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">{title}</h2>
        <IconButton label={addLabel} size="xs" disabled={disabled} onClick={onAdd}>
          <Plus aria-hidden />
        </IconButton>
      </div>
      {children}
    </section>
  );
}

function DocList({
  docs,
  numbered,
  current,
  summarizing,
  onSelect,
  onReorder,
  onToggleDone,
  onSummarize,
  onDelete,
}: {
  docs: WritingDocumentSummary[];
  numbered: boolean;
  current: string | null;
  summarizing: string | null;
  onSelect: (id: string) => void;
  onReorder: (ids: string[]) => void;
  onToggleDone: (doc: WritingDocumentSummary) => void;
  onSummarize: (doc: WritingDocumentSummary) => void;
  onDelete: (doc: WritingDocumentSummary) => void;
}) {
  const { t } = useTranslation();
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const commit = (next: WritingDocumentSummary[]) => onReorder(next.map((doc) => doc.id));

  return (
    <ol className="flex flex-col gap-px">
      {docs.map((doc, index) => {
        const active = doc.id === current;
        const pending = doc.summaryPending || summarizing === doc.id;
        const title =
          doc.title.trim() ||
          (numbered
            ? t('writing.tree.chapterN', { n: index + 1 })
            : t('writing.tree.untitledNote'));
        const hint = numbered
          ? doc.summary
            ? `${t('writing.tree.summary')}：${doc.summary}`
            : t('writing.tree.noSummary')
          : undefined;
        return (
          <li
            key={doc.id}
            data-part="writing-tree-item"
            data-kind={doc.kind}
            data-active={active}
            data-done={doc.done}
            draggable
            onDragStart={(event) => {
              setDragFrom(index);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', doc.id);
            }}
            onDragOver={(event) => {
              if (dragFrom === null) return;
              event.preventDefault();
              setDragOver(index);
            }}
            onDragLeave={() => setDragOver((value) => (value === index ? null : value))}
            onDrop={(event) => {
              event.preventDefault();
              if (dragFrom !== null && dragFrom !== index) commit(move(docs, dragFrom, index));
              setDragFrom(null);
              setDragOver(null);
            }}
            onDragEnd={() => {
              setDragFrom(null);
              setDragOver(null);
            }}
            className={cn(
              'group rounded-control relative flex items-center gap-1 pe-1',
              dragFrom === index && 'opacity-40',
              dragOver === index && dragFrom !== index && 'edge-rule-strong border-t',
            )}
          >
            {active && (
              <span
                aria-hidden
                data-part="writing-tree-marker"
                className="absolute start-0 top-1/2 h-5 w-0.5 -translate-y-1/2 bg-accent"
              />
            )}
            <GripVertical
              aria-hidden
              className="hidden size-3.5 shrink-0 cursor-grab text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 md:block"
            />
            <button
              type="button"
              title={hint}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(doc.id)}
              className="focus-ring-inset min-w-0 flex-1 cursor-pointer py-1.5 ps-1.5 text-left md:ps-0"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                {numbered && (
                  <span className="shrink-0 text-[11px] text-ink-3 tabular-nums">{index + 1}</span>
                )}
                <span
                  className={cn(
                    'min-w-0 truncate text-sm',
                    active ? 'font-medium text-accent' : 'text-ink-story',
                  )}
                >
                  {title}
                </span>
              </span>
              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 text-[11px] text-ink-3 tabular-nums">
                <span>{t('writing.tree.words', { count: doc.wordCount })}</span>
                {numbered && pending && (
                  <span className="pulse-live">{t('writing.tree.summaryPending')}</span>
                )}
                {numbered && !pending && doc.summaryStale && (
                  <span
                    data-part="writing-tree-stale"
                    className="chip-outline px-1 py-px text-[10px] leading-none"
                  >
                    {t('writing.tree.stale')}
                  </span>
                )}
              </span>
            </button>

            {numbered && (
              <button
                type="button"
                data-part="writing-tree-done"
                data-done={doc.done}
                aria-pressed={doc.done}
                aria-label={doc.done ? t('writing.tree.markUndone') : t('writing.tree.markDone')}
                title={doc.done ? t('writing.tree.markUndone') : t('writing.tree.markDone')}
                onClick={() => onToggleDone(doc)}
                className={cn(
                  'rounded-control focus-ring flex size-6 shrink-0 cursor-pointer items-center justify-center border',
                  doc.done
                    ? 'border-accent text-accent'
                    : 'edge-rule text-transparent hover:text-ink-3',
                )}
              >
                <Check aria-hidden className="size-3.5" />
              </button>
            )}

            <div className="flex flex-col md:hidden">
              <IconButton
                label={t('writing.tree.moveUp')}
                size="xs"
                disabled={index === 0}
                onClick={() => commit(move(docs, index, index - 1))}
              >
                <ChevronUp aria-hidden />
              </IconButton>
              <IconButton
                label={t('writing.tree.moveDown')}
                size="xs"
                disabled={index === docs.length - 1}
                onClick={() => commit(move(docs, index, index + 1))}
              >
                <ChevronDown aria-hidden />
              </IconButton>
            </div>

            <DocMenu
              open={menuFor === doc.id}
              onOpenChange={(open) => setMenuFor(open ? doc.id : null)}
              canSummarize={numbered && !pending}
              onSummarize={() => onSummarize(doc)}
              onDelete={() => onDelete(doc)}
            />
          </li>
        );
      })}
    </ol>
  );
}

function DocMenu({
  open,
  onOpenChange,
  canSummarize,
  onSummarize,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canSummarize: boolean;
  onSummarize: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) onOpenChange(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onOpenChange]);

  return (
    <div ref={boxRef} className="relative shrink-0">
      <IconButton
        label={t('writing.tree.menu')}
        size="xs"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <MoreHorizontal aria-hidden />
      </IconButton>
      {open && (
        <div
          role="menu"
          data-part="writing-tree-menu"
          className="surface-raised edge-rule rounded-card absolute end-0 top-full z-20 mt-1 flex w-36 flex-col border py-1"
        >
          {canSummarize && (
            <button
              type="button"
              role="menuitem"
              className="focus-ring-inset cursor-pointer px-3 py-1.5 text-left text-xs text-ink-story hover:bg-accent-soft hover:text-ink"
              onClick={() => {
                onOpenChange(false);
                onSummarize();
              }}
            >
              {t('writing.tree.summarize')}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="focus-ring-inset cursor-pointer px-3 py-1.5 text-left text-xs text-danger hover:bg-danger-soft"
            onClick={() => {
              onOpenChange(false);
              onDelete();
            }}
          >
            {t('common.delete')}
          </button>
        </div>
      )}
    </div>
  );
}
