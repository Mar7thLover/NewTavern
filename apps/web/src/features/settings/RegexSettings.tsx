import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsSection } from './shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ImportButton } from '../../components/ImportButton';
import { Badge } from '../../components/ui/badge';
import { IconButton } from '../../components/ui/icon-button';
import { Switch } from '../../components/ui/switch';
import {
  apiUrls,
  queryKeys,
  useDeleteRegexScript,
  useRegexScripts,
  useReorderRegexScripts,
  useUpdateRegexScript,
  type RegexScript,
} from '../../lib/api';
import { cn } from '../../lib/utils';
import { EmptyState, QueryStatus, errorMessage } from '../library/shared';

/** promptOnly / markdownOnly 两个布尔位 → 方向徽标 */
function directionOf(script: RegexScript): 'prompt' | 'display' | 'both' {
  if (script.promptOnly) return 'prompt';
  if (script.markdownOnly) return 'display';
  return 'both';
}

/** 设置页「正则脚本」分区：导入 / 排序 / 启停 / 删除 / 查看 find→replace */
export function RegexSettings() {
  const { t } = useTranslation();
  const scripts = useRegexScripts();
  const reorder = useReorderRegexScripts();
  const update = useUpdateRegexScript();
  const remove = useDeleteRegexScript();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<RegexScript | null>(null);

  const list = scripts.data ?? [];

  /** 与相邻项交换后把全量顺序写回 `PUT /api/regex/order` */
  const move = (index: number, delta: number) => {
    const next = [...list];
    const target = index + delta;
    const current = next[index];
    const swap = next[target];
    if (!current || !swap) return;
    next[index] = swap;
    next[target] = current;
    reorder.mutate(next.map((script) => script.id));
  };

  return (
    <SettingsSection
      title={t('regex.title')}
      hint={t('regex.hint')}
      actions={
        <ImportButton
          endpoint={apiUrls.importRegex}
          accept=".json"
          invalidateKey={queryKeys.regexScripts}
          label={t('regex.import')}
        />
      }
    >
      <QueryStatus
        isPending={scripts.isPending}
        error={scripts.error}
        onRetry={() => void scripts.refetch()}
      />

      {scripts.data &&
        (list.length === 0 ? (
          <EmptyState title={t('regex.emptyTitle')} hint={t('regex.emptyHint')} />
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {t('regex.count', { total: list.length })}
            </p>
            <ul className="space-y-2">
              {list.map((script, index) => (
                <li
                  key={script.id}
                  className={cn(
                    'rounded-lg border border-border bg-card/60',
                    script.disabled && 'opacity-60',
                  )}
                >
                  <div className="flex items-center gap-2 px-3 py-2.5">
                    <div className="flex flex-col">
                      <IconButton
                        label={t('regex.moveUp')}
                        size="xs"
                        disabled={index === 0 || reorder.isPending}
                        onClick={() => move(index, -1)}
                      >
                        <ChevronUp aria-hidden />
                      </IconButton>
                      <IconButton
                        label={t('regex.moveDown')}
                        size="xs"
                        disabled={index === list.length - 1 || reorder.isPending}
                        onClick={() => move(index, 1)}
                      >
                        <ChevronDown aria-hidden />
                      </IconButton>
                    </div>

                    <button
                      type="button"
                      onClick={() => setExpanded(expanded === script.id ? null : script.id)}
                      aria-expanded={expanded === script.id}
                      className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      <div className="truncate text-sm font-medium">{script.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {script.placement.length === 0 ? (
                          <Badge variant="outline">{t('regex.noPlacement')}</Badge>
                        ) : (
                          script.placement.map((placement) => (
                            <Badge key={placement} variant="muted">
                              {t([`regex.placements.${placement}`, String(placement)])}
                            </Badge>
                          ))
                        )}
                        <Badge variant="outline">
                          {t(`regex.directions.${directionOf(script)}`)}
                        </Badge>
                        {(script.minDepth != null || script.maxDepth != null) && (
                          <Badge variant="outline">
                            {t('regex.depthRange', {
                              min: script.minDepth ?? 0,
                              max: script.maxDepth ?? '∞',
                            })}
                          </Badge>
                        )}
                      </div>
                    </button>

                    <Switch
                      checked={!script.disabled}
                      label={t('regex.toggle')}
                      disabled={update.isPending}
                      onChange={(checked) => update.mutate({ id: script.id, disabled: !checked })}
                    />
                    <IconButton
                      label={t('common.delete')}
                      size="sm"
                      variant="destructive"
                      onClick={() => {
                        remove.reset();
                        setPendingDelete(script);
                      }}
                    >
                      <Trash2 aria-hidden />
                    </IconButton>
                  </div>

                  {expanded === script.id && (
                    <dl className="space-y-2 border-t border-border px-3 py-2.5 text-xs">
                      <div>
                        <dt className="text-muted-foreground">{t('regex.find')}</dt>
                        <dd className="mt-0.5 font-mono break-all">{script.findRegex}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">{t('regex.replace')}</dt>
                        <dd className="mt-0.5 font-mono break-all whitespace-pre-wrap">
                          {script.replaceString || '—'}
                        </dd>
                      </div>
                      {script.trimStrings.length > 0 && (
                        <div>
                          <dt className="text-muted-foreground">{t('regex.trimStrings')}</dt>
                          <dd className="mt-0.5 font-mono break-all">
                            {script.trimStrings.join(' · ')}
                          </dd>
                        </div>
                      )}
                      {script.runOnEdit && <Badge variant="outline">{t('regex.runOnEdit')}</Badge>}
                    </dl>
                  )}
                </li>
              ))}
            </ul>
          </>
        ))}

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title={t('regex.deleteTitle')}
        description={t('regex.deleteMessage', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        pending={remove.isPending}
        error={errorMessage(remove.error)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) })
        }
      />
    </SettingsSection>
  );
}
