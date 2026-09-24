import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ImportButton } from '../../components/ImportButton';
import { Badge } from '../../components/ui/badge';
import { Button, buttonVariants } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import {
  apiUrls,
  queryKeys,
  useCreateLorebook,
  useDeleteLorebook,
  useGlobalBookIds,
  useLorebooks,
  useSetGlobalBookIds,
  type LorebookSummary,
} from '../../lib/api';
import { studioPath } from '../../lib/api-studio';
import { EmptyState, LibraryHeader, QueryStatus, errorMessage, formatDate } from './shared';

const LOREBOOK_ACCEPT = '.json';

const editorPath = (id: string) => `/lorebooks/${encodeURIComponent(id)}`;

export function LorebooksPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const lorebooks = useLorebooks();
  const createLorebook = useCreateLorebook();
  const deleteLorebook = useDeleteLorebook();
  const [pendingDelete, setPendingDelete] = useState<LorebookSummary | null>(null);
  // 「全局」是设置项 worldInfo.globalBookIds，表里的 scope 列不代表它生效；开关直接在这里给
  const globalBooks = useGlobalBookIds();
  const setGlobalBooks = useSetGlobalBookIds();
  const globalIds = globalBooks.data ?? [];
  const toggleGlobal = (bookId: string, on: boolean) => {
    const rest = globalIds.filter((id) => id !== bookId);
    setGlobalBooks.mutate(on ? [...rest, bookId] : rest);
  };

  const list = lorebooks.data ?? [];

  const headerActions = (size: 'sm' | 'lg', align: 'end' | 'center') => (
    <>
      <Button
        size={size}
        disabled={createLorebook.isPending}
        onClick={() =>
          createLorebook.mutate({}, { onSuccess: (row) => void navigate(editorPath(row.id)) })
        }
      >
        {t('library.lorebooks.create')}
      </Button>
      <ImportButton
        endpoint={apiUrls.importLorebook}
        accept={LOREBOOK_ACCEPT}
        invalidateKey={queryKeys.lorebooks}
        label={t('library.lorebooks.import')}
        size={size}
        align={align}
      />
    </>
  );

  return (
    <div className="mx-auto max-w-4xl">
      <LibraryHeader
        title={t('nav.lorebooks')}
        subtitle={
          lorebooks.data
            ? [
                t('library.lorebooks.count', { total: list.length }),
                t('library.lorebooks.loadHint'),
              ].join(' - ')
            : null
        }
        actions={list.length > 0 ? headerActions('sm', 'end') : null}
      />

      <QueryStatus
        isPending={lorebooks.isPending}
        error={lorebooks.error}
        onRetry={() => void lorebooks.refetch()}
      />

      {createLorebook.error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {errorMessage(createLorebook.error)}
        </p>
      )}

      {lorebooks.data &&
        (list.length === 0 ? (
          <EmptyState
            kind="lorebooks"
            title={t('library.lorebooks.emptyTitle')}
            hint={t('library.lorebooks.emptyHint')}
            action={<div className="flex items-start gap-2">{headerActions('lg', 'center')}</div>}
          />
        ) : (
          <ul className="edge-rule divide-y divide-edge border-y">
            {list.map((book) => (
              <li
                key={book.id}
                data-part="library-item"
                data-kind="lorebook"
                className="flex flex-col gap-2 px-1 py-3 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    to={editorPath(book.id)}
                    className="focus-ring rounded-control block truncate font-medium hover:text-accent"
                  >
                    {book.name}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                    {book.scope === 'char' && <Badge>{t('library.lorebooks.scopes.char')}</Badge>}
                    {globalIds.includes(book.id) && (
                      <Badge>{t('library.lorebooks.globalOn')}</Badge>
                    )}
                    <span>{t('library.lorebooks.entryCount', { total: book.entryCount })}</span>
                    <span>
                      {t('common.updated')}: {formatDate(book.updatedAt)}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="me-1 inline-flex items-center gap-1.5 text-xs text-ink-2">
                    <Switch
                      checked={globalIds.includes(book.id)}
                      disabled={globalBooks.data === undefined || setGlobalBooks.isPending}
                      label={t('library.lorebooks.globalToggle', { name: book.name })}
                      onChange={(on) => toggleGlobal(book.id, on)}
                    />
                    {t('library.lorebooks.globalToggleShort')}
                  </span>
                  <Link
                    to={editorPath(book.id)}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    {t('common.edit')}
                  </Link>
                  <Link
                    to={studioPath('lorebook', book.id)}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    {t('studio.openInStudio')}
                  </Link>
                  <a
                    href={apiUrls.exportLorebook(book.id)}
                    download
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    {t('common.export')}
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-danger hover:bg-danger-soft hover:text-danger"
                    onClick={() => {
                      deleteLorebook.reset();
                      setPendingDelete(book);
                    }}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        ))}

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title={t('library.lorebooks.deleteTitle')}
        description={t('library.lorebooks.deleteMessage', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        pending={deleteLorebook.isPending}
        error={errorMessage(deleteLorebook.error)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          deleteLorebook.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
        }}
      />
    </div>
  );
}
