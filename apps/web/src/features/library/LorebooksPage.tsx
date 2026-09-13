import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ImportButton } from '../../components/ImportButton';
import { Modal } from '../../components/Modal';
import { Badge } from '../../components/ui/badge';
import { Button, buttonVariants } from '../../components/ui/button';
import {
  apiUrls,
  queryKeys,
  useDeleteLorebook,
  useLorebook,
  useLorebooks,
  type LorebookEntry,
  type LorebookSummary,
} from '../../lib/api';
import { cn } from '../../lib/utils';
import { EmptyState, LibraryHeader, QueryStatus, errorMessage, formatDate } from './shared';

const LOREBOOK_ACCEPT = '.json';

const CONTENT_PREVIEW_LENGTH = 140;

/** ST world_info_position：0..7 */
const KNOWN_POSITIONS = 8;
/** 仅 position = 4（@D）时 depth 生效 */
const AT_DEPTH_POSITION = 4;

type EntryStatus = 'constant' | 'active' | 'disabled';

const STATUS_DOT: Record<EntryStatus, string> = {
  constant: 'bg-primary',
  active: 'bg-green-500',
  disabled: 'bg-muted-foreground/40',
};

function entryStatus(entry: LorebookEntry): EntryStatus {
  if (entry.disabled) return 'disabled';
  return entry.constant ? 'constant' : 'active';
}

function preview(content: string): string {
  const text = content.replace(/\s+/g, ' ').trim();
  return text.length > CONTENT_PREVIEW_LENGTH ? `${text.slice(0, CONTENT_PREVIEW_LENGTH)}…` : text;
}

export function LorebooksPage() {
  const { t } = useTranslation();
  const lorebooks = useLorebooks();
  const deleteLorebook = useDeleteLorebook();
  const [selected, setSelected] = useState<LorebookSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LorebookSummary | null>(null);

  const list = lorebooks.data ?? [];

  const importButton = (size: 'sm' | 'lg', align: 'end' | 'center') => (
    <ImportButton
      endpoint={apiUrls.importLorebook}
      accept={LOREBOOK_ACCEPT}
      invalidateKey={queryKeys.lorebooks}
      label={t('library.lorebooks.import')}
      size={size}
      align={align}
    />
  );

  return (
    <div className="mx-auto max-w-4xl">
      <LibraryHeader
        title={t('nav.lorebooks')}
        subtitle={lorebooks.data ? t('library.lorebooks.count', { total: list.length }) : null}
        actions={list.length > 0 ? importButton('sm', 'end') : null}
      />

      <QueryStatus
        isPending={lorebooks.isPending}
        error={lorebooks.error}
        onRetry={() => void lorebooks.refetch()}
      />

      {lorebooks.data &&
        (list.length === 0 ? (
          <EmptyState
            title={t('library.lorebooks.emptyTitle')}
            hint={t('library.lorebooks.emptyHint')}
            action={importButton('lg', 'center')}
          />
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {list.map((book) => (
              <li key={book.id} className="flex flex-col sm:flex-row sm:items-center">
                <button
                  type="button"
                  onClick={() => setSelected(book)}
                  className="min-w-0 flex-1 cursor-pointer px-4 pt-3 text-left transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none sm:py-3"
                >
                  <div className="truncate font-medium">{book.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge>{t(`library.lorebooks.scopes.${book.scope}`)}</Badge>
                    <span>{t('library.lorebooks.entryCount', { total: book.entryCount })}</span>
                    <span>
                      {t('common.updated')}: {formatDate(book.updatedAt)}
                    </span>
                  </div>
                </button>
                <div className="flex shrink-0 gap-2 px-4 py-3 sm:pl-0">
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
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
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

      {selected && <LorebookDetailModal book={selected} onClose={() => setSelected(null)} />}

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

function LorebookDetailModal({ book, onClose }: { book: LorebookSummary; onClose: () => void }) {
  const { t } = useTranslation();
  const detail = useLorebook(book.id);
  const entries = detail.data?.entries ?? [];

  const positionLabel = (position: number) =>
    Number.isInteger(position) && position >= 0 && position < KNOWN_POSITIONS
      ? t(`library.lorebooks.positions.${position}`)
      : t('library.lorebooks.unknownPosition', { value: position });

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate">{detail.data?.name ?? book.name}</span>
          <Badge>{t(`library.lorebooks.scopes.${detail.data?.scope ?? book.scope}`)}</Badge>
          <span className="text-xs font-normal text-muted-foreground">
            {t('library.lorebooks.entryCount', {
              total: detail.data?.entries.length ?? book.entryCount,
            })}
          </span>
        </span>
      }
    >
      <QueryStatus
        isPending={detail.isPending}
        error={detail.error}
        onRetry={() => void detail.refetch()}
      />

      {detail.data &&
        (entries.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('library.lorebooks.noEntries')}
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted-foreground">
              {(Object.keys(STATUS_DOT) as EntryStatus[]).map((status) => (
                <span key={status} className="inline-flex items-center gap-1.5">
                  <span className={cn('size-2 rounded-full', STATUS_DOT[status])} />
                  {t(`library.lorebooks.status.${status}`)}
                </span>
              ))}
            </div>
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="w-10 px-3 py-2 font-medium">
                      <span className="sr-only">{t('library.lorebooks.columns.status')}</span>
                    </th>
                    <th className="w-1/4 px-3 py-2 font-medium">
                      {t('library.lorebooks.columns.title')}
                    </th>
                    <th className="px-3 py-2 font-medium">
                      {t('library.lorebooks.columns.content')}
                    </th>
                    <th className="px-3 py-2 font-medium whitespace-nowrap">
                      {t('library.lorebooks.columns.position')}
                    </th>
                    <th className="px-3 py-2 text-right font-medium whitespace-nowrap">
                      {t('library.lorebooks.columns.depth')}
                    </th>
                    <th className="px-3 py-2 text-right font-medium whitespace-nowrap">
                      {t('library.lorebooks.columns.probability')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {entries.map((entry) => {
                    const status = entryStatus(entry);
                    const keys = entry.keys.join(', ');
                    const title = entry.comment?.trim() || keys;
                    return (
                      <tr
                        key={entry.id}
                        className={cn('align-top', entry.disabled && 'text-muted-foreground')}
                      >
                        <td className="px-3 py-2.5">
                          <span
                            title={t(`library.lorebooks.status.${status}`)}
                            className={cn('mt-1.5 block size-2 rounded-full', STATUS_DOT[status])}
                          />
                          <span className="sr-only">{t(`library.lorebooks.status.${status}`)}</span>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="font-medium break-words">
                            {title || (
                              <span className="text-muted-foreground italic">
                                {t('library.lorebooks.untitled')}
                              </span>
                            )}
                          </div>
                          {entry.comment?.trim() && keys && (
                            <div className="mt-0.5 text-xs break-words text-muted-foreground">
                              {keys}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">
                          <span className="line-clamp-3 break-words">{preview(entry.content)}</span>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {positionLabel(entry.position)}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2.5 text-right tabular-nums',
                            entry.position !== AT_DEPTH_POSITION && 'text-muted-foreground/60',
                          )}
                        >
                          {entry.depth ?? '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {entry.probability === null ? '—' : `${entry.probability}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        ))}
    </Modal>
  );
}
