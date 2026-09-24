import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import {
  restoreVersion,
  studioKeys,
  useVersion,
  useVersions,
  type VersionSummary,
} from '../../../lib/api-studio';
import { cn } from '../../../lib/utils';
import { QueryStatus, errorMessage, formatDate } from '../../library/shared';
import { compareWithVersion } from '../draft/adapters';
import type { StudioDraftApi } from '../draft/useStudioDraft';
import { ChangeList } from '../diff/ChangeList';

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * 版本页签（M6 §4.4）：列表（版本号、作者、时间）；选中看「恢复会带来的改动」（当前草稿 → 该版）；
 * 恢复 = 服务端用该版 data 走一次保存（产生新版本、不删历史），随后重建基线与草稿。
 */
export function VersionsTab({ draftApi }: { draftApi: StudioDraftApi }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { kind, id, state } = draftApi;
  const versions = useVersions(kind, id);
  const [selected, setSelected] = useState<number | null>(null);
  const detail = useVersion(kind, id, selected);
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const list = versions.data ?? [];
  const latest = list[0]?.version ?? null;
  const rows = useMemo(
    () => (state && detail.data ? compareWithVersion(state.pair, detail.data.data) : []),
    [state, detail.data],
  );

  const restore = async () => {
    if (selected === null) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      await restoreVersion(kind, id, selected);
      await draftApi.reload();
      await queryClient.invalidateQueries({ queryKey: studioKeys.versions(kind, id), exact: true });
      void queryClient.invalidateQueries({ queryKey: ['versions', 'recent'] });
      setConfirming(false);
      setSelected(null);
    } catch (error) {
      setRestoreError(errorMessage(error));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {draftApi.dirty && (
        <div className="edge-rule flex shrink-0 items-center gap-2 border-b px-3 py-2">
          <p className="min-w-0 flex-1 text-xs text-ink-2">{t('studio.versions.unsaved')}</p>
          <Button variant="outline" size="sm" onClick={draftApi.revert}>
            {t('studio.revert')}
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <QueryStatus
          isPending={versions.isPending}
          error={versions.error}
          onRetry={() => void versions.refetch()}
        />
        {versions.data && list.length === 0 && (
          <p className="p-4 text-sm text-ink-3">{t('studio.versions.empty')}</p>
        )}
        <ol className="divide-y divide-edge">
          {list.map((item) => (
            <VersionRow
              key={item.version}
              item={item}
              latest={item.version === latest}
              active={item.version === selected}
              onSelect={() => setSelected(item.version === selected ? null : item.version)}
            >
              {item.version === selected && (
                <div className="px-3 pb-3">
                  <QueryStatus
                    isPending={detail.isPending}
                    error={detail.error}
                    onRetry={() => void detail.refetch()}
                  />
                  {detail.data &&
                    (rows.length === 0 ? (
                      <p className="py-2 text-xs text-ink-3">{t('studio.versions.same')}</p>
                    ) : (
                      <>
                        <p className="pb-1 text-[11px] text-ink-3">
                          {t('studio.versions.compareHint', { n: rows.length })}
                        </p>
                        <ChangeList kind={kind} rows={rows} draft={state?.pair.draft} />
                      </>
                    ))}
                  {detail.data && (rows.length > 0 || draftApi.dirty) && (
                    <Button
                      className="mt-2"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setRestoreError(null);
                        setConfirming(true);
                      }}
                    >
                      {t('studio.versions.restore')}
                    </Button>
                  )}
                </div>
              )}
            </VersionRow>
          ))}
        </ol>
      </div>

      <ConfirmDialog
        open={confirming}
        title={t('studio.versions.restoreTitle', { version: selected ?? '' })}
        description={
          draftApi.dirty ? t('studio.versions.restoreDirty') : t('studio.versions.restoreMessage')
        }
        confirmLabel={t('studio.versions.restore')}
        destructive={draftApi.dirty}
        pending={restoring}
        error={restoreError}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void restore()}
      />
    </div>
  );
}

function VersionRow({
  item,
  latest,
  active,
  onSelect,
  children,
}: {
  item: VersionSummary;
  latest: boolean;
  active: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <li data-active={active}>
      <button
        type="button"
        aria-expanded={active}
        onClick={onSelect}
        className={cn(
          'focus-ring-inset flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs',
          active ? 'text-ink' : 'text-ink-2 hover:text-ink',
        )}
      >
        <span className={cn('w-10 shrink-0 tabular-nums', active && 'font-medium text-accent')}>
          v{item.version}
        </span>
        <Badge variant={item.author === 'ai' ? 'default' : 'muted'}>
          {t(`studio.versions.author.${item.author}`)}
        </Badge>
        {latest && <span className="text-[11px] text-ink-3">{t('studio.versions.current')}</span>}
        <span className="ms-auto shrink-0 text-[11px] text-ink-3 tabular-nums">
          {formatDate(item.createdAt)} · {formatSize(item.size)}
        </span>
      </button>
      {children}
    </li>
  );
}
