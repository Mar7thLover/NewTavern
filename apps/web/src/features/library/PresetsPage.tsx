import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ImportButton } from '../../components/ImportButton';
import { Badge } from '../../components/ui/badge';
import { Button, buttonVariants } from '../../components/ui/button';
import { apiUrls, queryKeys, useDeletePreset, usePresets, type PresetSummary } from '../../lib/api';
import { EmptyState, LibraryHeader, QueryStatus, errorMessage, formatDate } from './shared';

const PRESET_ACCEPT = '.json';

export function PresetsPage() {
  const { t } = useTranslation();
  const presets = usePresets();
  const deletePreset = useDeletePreset();
  const [pendingDelete, setPendingDelete] = useState<PresetSummary | null>(null);

  const list = presets.data ?? [];

  const importButton = (size: 'sm' | 'lg', align: 'end' | 'center') => (
    <ImportButton
      endpoint={apiUrls.importPreset}
      accept={PRESET_ACCEPT}
      invalidateKey={queryKeys.presets}
      label={t('library.presets.import')}
      size={size}
      align={align}
    />
  );

  return (
    <div className="mx-auto max-w-4xl">
      <LibraryHeader
        title={t('nav.presets')}
        subtitle={presets.data ? t('library.presets.count', { total: list.length }) : null}
        actions={list.length > 0 ? importButton('sm', 'end') : null}
      />

      <QueryStatus
        isPending={presets.isPending}
        error={presets.error}
        onRetry={() => void presets.refetch()}
      />

      {presets.data &&
        (list.length === 0 ? (
          <EmptyState
            kind="presets"
            title={t('library.presets.emptyTitle')}
            hint={t('library.presets.emptyHint')}
            action={importButton('lg', 'center')}
          />
        ) : (
          <ul className="edge-rule divide-y divide-edge border-y">
            {list.map((preset) => (
              <li
                key={preset.id}
                data-part="library-item"
                data-kind="preset"
                className="flex flex-col gap-2 px-1 py-3 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    to={`/presets/${encodeURIComponent(preset.id)}`}
                    className="focus-ring rounded-control block truncate font-medium hover:text-accent"
                  >
                    {preset.name}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                    <Badge>{t(`library.presets.formats.${preset.format}`)}</Badge>
                    <span>
                      {t('library.presets.apiFamily')}:{' '}
                      {preset.apiFamily ?? t('library.presets.anyApi')}
                    </span>
                    <span>
                      {t('common.updated')}: {formatDate(preset.updatedAt)}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Link
                    to={`/presets/${encodeURIComponent(preset.id)}`}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    {t('common.edit')}
                  </Link>
                  <a
                    href={apiUrls.exportPreset(preset.id)}
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
                      deletePreset.reset();
                      setPendingDelete(preset);
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
        title={t('library.presets.deleteTitle')}
        description={t('library.presets.deleteMessage', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        pending={deletePreset.isPending}
        error={errorMessage(deletePreset.error)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          deletePreset.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
        }}
      />
    </div>
  );
}
