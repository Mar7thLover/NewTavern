import { ArrowLeft } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useBeforeUnload, useBlocker, useParams } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useLorebook, useUpdateLorebook, type LorebookDetail } from '../../lib/api';
import {
  LorebookEditor,
  isLorebookDraftDirty,
  lorebookDraftToRequest,
  lorebookToDraft,
  type LorebookDraft,
} from './lorebook-editor';
import { QueryStatus } from './shared';

/*
 * 世界书编辑页（`/lorebooks/:id`）：薄壳。
 * 编辑器本体是受控的 `LorebookEditor`（`./lorebook-editor`，工作台与写作页也用它）；
 * 这里只管取数、草稿与基线、保存、离开拦截。
 */

export function LorebookEditorPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const lorebook = useLorebook(id);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        to="/lorebooks"
        className="focus-ring rounded-control mb-3 inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        {t('library.lorebooks.back')}
      </Link>
      <QueryStatus
        isPending={lorebook.isPending}
        error={lorebook.error}
        onRetry={() => void lorebook.refetch()}
      />
      {/* key：换了世界书就整体重建草稿 */}
      {lorebook.data && <LorebookEditorShell key={lorebook.data.id} book={lorebook.data} />}
    </div>
  );
}

function LorebookEditorShell({ book }: { book: LorebookDetail }) {
  const { t } = useTranslation();
  const update = useUpdateLorebook(book.id);

  const [baseline, setBaseline] = useState<LorebookDraft>(() => lorebookToDraft(book));
  const [draft, setDraft] = useState<LorebookDraft>(baseline);
  const dirty = useMemo(() => isLorebookDraftDirty(baseline, draft), [baseline, draft]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (dirty) event.preventDefault();
      },
      [dirty],
    ),
  );

  const onChange = (next: LorebookDraft) => {
    setDraft(next);
    // 放弃修改（回到基线）时一并清掉上次的保存结果
    if (next === baseline) update.reset();
  };

  const onSave = () => {
    const submitted = draft;
    update.mutate(lorebookDraftToRequest(submitted, baseline), {
      onSuccess: (row) => {
        // 返回的条目与提交的顺序一致：新条目沿用本地 key，展开状态不丢
        const next = lorebookToDraft(row, submitted);
        setBaseline(next);
        setDraft(next);
      },
    });
  };

  return (
    <>
      <LorebookEditor
        bookId={book.id}
        value={draft}
        onChange={onChange}
        baseline={baseline}
        onSave={onSave}
        saving={update.isPending}
        saveError={update.error}
        saved={update.isSuccess}
      />

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        destructive
        title={t('library.lorebooks.editor.leaveTitle')}
        description={t('library.lorebooks.editor.leaveMessage')}
        confirmLabel={t('library.lorebooks.editor.leave')}
        onCancel={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
      />
    </>
  );
}
