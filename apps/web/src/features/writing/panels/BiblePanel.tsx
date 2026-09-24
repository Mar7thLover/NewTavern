import { ArrowLeft, ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { FieldLabel } from '../../../components/ui/field';
import {
  useLorebook,
  useLorebooks,
  useUpdateLorebook,
  type LorebookDetail,
} from '../../../lib/api';
import type { WritingProjectDetail } from '../../../lib/api-writing';
import {
  LorebookEditor,
  isLorebookDraftDirty,
  lorebookDraftToRequest,
  lorebookToDraft,
  type LorebookDraft,
} from '../../library/lorebook-editor';
import { LorebookPicker } from '../../library/LorebookPicker';
import { QueryStatus } from '../../library/shared';

/**
 * 右栏「圣经」页签（M7 §5.2）：设定圣经就是世界书。上面选绑定哪几本；
 * 点一本进嵌入的世界书编辑器（M6 拆出的受控 `LorebookEditor`），也可以去世界书页编辑。
 */
export function BiblePanel({
  project,
  saving,
  onChange,
}: {
  project: WritingProjectDetail;
  saving: boolean;
  onChange: (lorebookIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const books = useLorebooks();
  const [editing, setEditing] = useState<string | null>(null);
  const bound = project.lorebookIds
    .map((id) => books.data?.find((book) => book.id === id) ?? null)
    .filter((book) => book !== null);

  if (editing) {
    return <EmbeddedLorebook bookId={editing} onBack={() => setEditing(null)} />;
  }

  return (
    <div data-part="writing-bible-panel" className="flex flex-col gap-5 p-4">
      <p className="text-xs leading-relaxed text-ink-2">{t('writing.bible.hint')}</p>
      <section>
        <FieldLabel>{t('writing.bible.bind')}</FieldLabel>
        <LorebookPicker selected={project.lorebookIds} disabled={saving} onChange={onChange} />
      </section>

      <section>
        <FieldLabel>{t('writing.bible.edit')}</FieldLabel>
        {bound.length === 0 ? (
          <p className="text-xs text-ink-3">{t('writing.bible.empty')}</p>
        ) : (
          <ul className="edge-rule rounded-card divide-y divide-edge border">
            {bound.map((book) => (
              <li key={book.id} className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setEditing(book.id)}
                  className="focus-ring-inset flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 px-3 py-2 text-left hover:text-accent"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{book.name}</span>
                  <span className="shrink-0 text-[11px] text-ink-3 tabular-nums">
                    {t('writing.bible.entries', { count: book.entryCount })}
                  </span>
                </button>
                <Link
                  to={`/lorebooks/${encodeURIComponent(book.id)}`}
                  aria-label={`${t('writing.bible.open')} · ${book.name}`}
                  title={t('writing.bible.open')}
                  className="action-ghost focus-ring rounded-control me-1 inline-flex size-7 shrink-0 items-center justify-center"
                >
                  <ExternalLink aria-hidden className="size-3.5" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function EmbeddedLorebook({ bookId, onBack }: { bookId: string; onBack: () => void }) {
  const { t } = useTranslation();
  const lorebook = useLorebook(bookId);
  return (
    <div data-part="writing-bible-editor" className="flex flex-col gap-3 p-3">
      <button
        type="button"
        onClick={onBack}
        className="focus-ring rounded-control inline-flex w-fit cursor-pointer items-center gap-1 text-xs text-ink-2 hover:text-ink"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        {t('writing.bible.back')}
      </button>
      <QueryStatus
        isPending={lorebook.isPending}
        error={lorebook.error}
        onRetry={() => void lorebook.refetch()}
      />
      {lorebook.data && <EmbeddedShell key={lorebook.data.id} book={lorebook.data} />}
    </div>
  );
}

/**
 * 草稿与基线（同 `/lorebooks/:id` 的外壳）。右栏会随页签 / 抽屉卸载：
 * 卸载时还有没保存的改动就顺手存掉，和写作正文的「离开即保存」一致。
 */
function EmbeddedShell({ book }: { book: LorebookDetail }) {
  const update = useUpdateLorebook(book.id);
  const [baseline, setBaseline] = useState<LorebookDraft>(() => lorebookToDraft(book));
  const [draft, setDraft] = useState<LorebookDraft>(baseline);
  const dirty = useMemo(() => isLorebookDraftDirty(baseline, draft), [baseline, draft]);

  const latest = useRef({ draft, baseline, dirty, update });
  useEffect(() => {
    latest.current = { draft, baseline, dirty, update };
  });
  useEffect(
    () => () => {
      const { draft: pending, baseline: base, dirty: unsaved, update: mutation } = latest.current;
      if (unsaved) mutation.mutate(lorebookDraftToRequest(pending, base));
    },
    [],
  );

  const onChange = (next: LorebookDraft) => {
    setDraft(next);
    if (next === baseline) update.reset();
  };

  const onSave = () => {
    const submitted = draft;
    update.mutate(lorebookDraftToRequest(submitted, baseline), {
      onSuccess: (row) => {
        const next = lorebookToDraft(row, submitted);
        setBaseline(next);
        setDraft(next);
      },
    });
  };

  return (
    <LorebookEditor
      bookId={book.id}
      value={draft}
      onChange={onChange}
      baseline={baseline}
      onSave={onSave}
      saving={update.isPending}
      saveError={update.error}
      saved={update.isSuccess}
      embedded
    />
  );
}
