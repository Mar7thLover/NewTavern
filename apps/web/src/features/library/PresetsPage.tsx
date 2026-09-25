import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ImportButton } from '../../components/ImportButton';
import { Badge } from '../../components/ui/badge';
import { Button, buttonVariants } from '../../components/ui/button';
import {
  apiUrls,
  queryKeys,
  useCreatePreset,
  useDefaultPresetId,
  useDeletePreset,
  useDuplicatePreset,
  usePresets,
  useSetDefaultPresetId,
  type PresetSummary,
} from '../../lib/api';
import { studioPath } from '../../lib/api-studio';
import {
  EmptyState,
  LibraryHeader,
  QueryStatus,
  errorMessage,
  formatDate,
  studioBadgeKey,
} from './shared';

const PRESET_ACCEPT = '.json';

const editorPath = (id: string) => `/presets/${encodeURIComponent(id)}`;

export function PresetsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const presets = usePresets();
  const defaultPresetId = useDefaultPresetId();
  const setDefaultPresetId = useSetDefaultPresetId();
  const createPreset = useCreatePreset();
  const duplicatePreset = useDuplicatePreset();
  const deletePreset = useDeletePreset();
  const [pendingDelete, setPendingDelete] = useState<PresetSummary | null>(null);

  const list = presets.data ?? [];
  const defaultId = defaultPresetId.data ?? null;
  const actionError = setDefaultPresetId.error ?? createPreset.error ?? duplicatePreset.error;

  const headerActions = (size: 'sm' | 'lg', align: 'end' | 'center') => (
    <>
      <Button
        size={size}
        disabled={createPreset.isPending}
        onClick={() =>
          createPreset.mutate({}, { onSuccess: (row) => void navigate(editorPath(row.id)) })
        }
      >
        {t('presets.create')}
      </Button>
      <ImportButton
        endpoint={apiUrls.importPreset}
        accept={PRESET_ACCEPT}
        invalidateKey={queryKeys.presets}
        label={t('library.presets.import')}
        size={size}
        align={align}
      />
    </>
  );

  return (
    <div className="mx-auto max-w-4xl">
      <LibraryHeader
        title={t('nav.presets')}
        subtitle={presets.data ? t('library.presets.count', { total: list.length }) : null}
        actions={list.length > 0 ? headerActions('sm', 'end') : null}
      />

      <QueryStatus
        isPending={presets.isPending}
        error={presets.error}
        onRetry={() => void presets.refetch()}
      />

      {actionError && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {errorMessage(actionError)}
        </p>
      )}

      {presets.data &&
        (list.length === 0 ? (
          <EmptyState
            kind="presets"
            title={t('library.presets.emptyTitle')}
            hint={t('library.presets.emptyHint')}
            action={<div className="flex items-start gap-2">{headerActions('lg', 'center')}</div>}
          />
        ) : (
          <ul className="edge-rule divide-y divide-edge border-y">
            {list.map((preset) => {
              const isDefault = preset.id === defaultId;
              return (
                <li
                  key={preset.id}
                  data-part="library-item"
                  data-kind="preset"
                  data-default={isDefault ? 'true' : 'false'}
                  className="flex flex-col gap-2 px-1 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <Link
                        to={editorPath(preset.id)}
                        className="focus-ring rounded-control block truncate font-medium hover:text-accent"
                      >
                        {preset.name}
                      </Link>
                      {isDefault && (
                        <Badge data-part="preset-default-badge" title={t('presets.defaultHint')}>
                          {t('presets.defaultBadge')}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-2">
                      {preset.studio && (
                        <Badge variant="muted" data-part="studio-copy-badge">
                          {t(studioBadgeKey(preset.studio))}
                        </Badge>
                      )}
                      <Badge variant="muted">{t(`library.presets.formats.${preset.format}`)}</Badge>
                      <span>
                        {t('library.presets.apiFamily')}:{' '}
                        {preset.apiFamily ?? t('library.presets.anyApi')}
                      </span>
                      <span>
                        {t('common.updated')}: {formatDate(preset.updatedAt)}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={setDefaultPresetId.isPending || defaultPresetId.isPending}
                      onClick={() => setDefaultPresetId.mutate(isDefault ? null : preset.id)}
                    >
                      {isDefault ? t('presets.unsetDefault') : t('presets.setDefault')}
                    </Button>
                    <Link
                      to={editorPath(preset.id)}
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    >
                      {t('common.edit')}
                    </Link>
                    <Link
                      to={studioPath('preset', preset.id)}
                      className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    >
                      {preset.studio ? t('studio.openCopyInStudio') : t('studio.openInStudio')}
                    </Link>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={duplicatePreset.isPending}
                      onClick={() => duplicatePreset.mutate(preset.id)}
                    >
                      {t('presets.duplicate')}
                    </Button>
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
              );
            })}
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
