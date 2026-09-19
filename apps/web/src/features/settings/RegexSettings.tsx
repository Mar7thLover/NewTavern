import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
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
  useAllRegexScripts,
  useDeleteRegexScript,
  useReorderRegexScripts,
  useSetRegexOwnerEnabled,
  useUpdateRegexScript,
  type OwnedRegexScript,
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

/** 一组脚本：全局是一组，卡 / 预设 / 世界书各自带的按来源各成一组 */
interface ScriptGroup {
  key: string;
  scope: OwnedRegexScript['scope'];
  ownerId: string | null;
  /** 组标题：全局用「我的脚本」，其余用来源名 */
  title: string;
  scripts: OwnedRegexScript[];
}

/**
 * 设置页「正则脚本」分区：导入 / 排序 / 启停 / 删除 / 查看 find→replace。
 *
 * 分两类展示（M3 契约 §3.2 修正）：
 * - **我的脚本**（scope=global）：可排序、可删；
 * - **自带的脚本**：角色卡 / 预设 / 世界书导入时抽进来的，按来源分组，
 *   一组一个总开关（第一次启用按原件状态恢复；之后关闭、打开会记住逐条状态），
 *   也可以单条开关。顺序跟着原件，不提供排序。
 */
export function RegexSettings() {
  const { t } = useTranslation();
  const scripts = useAllRegexScripts();
  const reorder = useReorderRegexScripts();
  const update = useUpdateRegexScript();
  const remove = useDeleteRegexScript();
  const setOwnerEnabled = useSetRegexOwnerEnabled();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [pendingDelete, setPendingDelete] = useState<RegexScript | null>(null);

  const all = useMemo(() => scripts.data ?? [], [scripts.data]);
  const globals = useMemo(() => all.filter((script) => script.scope === 'global'), [all]);

  const groups = useMemo<ScriptGroup[]>(() => {
    const byOwner = new Map<string, ScriptGroup>();
    for (const script of all) {
      if (script.scope === 'global' || !script.ownerId) continue;
      const key = `${script.scope}:${script.ownerId}`;
      const group = byOwner.get(key);
      if (group) group.scripts.push(script);
      else {
        byOwner.set(key, {
          key,
          scope: script.scope,
          ownerId: script.ownerId,
          title: script.ownerName ?? t('regex.embedded.unknownOwner'),
          scripts: [script],
        });
      }
    }
    return [...byOwner.values()];
  }, [all, t]);

  /** 与相邻项交换后把全量顺序写回 `PUT /api/regex/order`（只对「我的脚本」开放） */
  const move = (index: number, delta: number) => {
    const next = [...globals];
    const target = index + delta;
    const current = next[index];
    const swap = next[target];
    if (!current || !swap) return;
    next[index] = swap;
    next[target] = current;
    reorder.mutate(next.map((script) => script.id));
  };

  const renderRow = (
    script: OwnedRegexScript,
    options: { index?: number; total?: number } = {},
  ) => (
    <li key={script.id} className={cn('edge-rule border-b', script.disabled && 'opacity-60')}>
      <div className="flex items-center gap-2 py-2.5">
        {options.index !== undefined && options.total !== undefined && (
          <div className="flex flex-col">
            <IconButton
              label={t('regex.moveUp')}
              size="xs"
              disabled={options.index === 0 || reorder.isPending}
              onClick={() => move(options.index as number, -1)}
            >
              <ChevronUp aria-hidden />
            </IconButton>
            <IconButton
              label={t('regex.moveDown')}
              size="xs"
              disabled={options.index === (options.total as number) - 1 || reorder.isPending}
              onClick={() => move(options.index as number, 1)}
            >
              <ChevronDown aria-hidden />
            </IconButton>
          </div>
        )}

        <button
          type="button"
          onClick={() => setExpanded(expanded === script.id ? null : script.id)}
          aria-expanded={expanded === script.id}
          className="min-w-0 flex-1 cursor-pointer text-left focus-ring-inset"
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
            <Badge variant="outline">{t(`regex.directions.${directionOf(script)}`)}</Badge>
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
        <dl className="space-y-2 pb-2.5 ps-8 text-xs">
          <div>
            <dt className="text-ink-2">{t('regex.find')}</dt>
            <dd className="mt-0.5 font-mono break-all">{script.findRegex}</dd>
          </div>
          <div>
            <dt className="text-ink-2">{t('regex.replace')}</dt>
            <dd className="mt-0.5 font-mono break-all whitespace-pre-wrap">
              {script.replaceString || '—'}
            </dd>
          </div>
          {script.trimStrings.length > 0 && (
            <div>
              <dt className="text-ink-2">{t('regex.trimStrings')}</dt>
              <dd className="mt-0.5 font-mono break-all">{script.trimStrings.join(' · ')}</dd>
            </div>
          )}
          {script.runOnEdit && <Badge variant="outline">{t('regex.runOnEdit')}</Badge>}
        </dl>
      )}
    </li>
  );

  return (
    <div className="space-y-8">
      <SettingsSection
        title={t('regex.title')}
        hint={t('regex.hint')}
        actions={
          <ImportButton
            endpoint={apiUrls.importRegex}
            accept=".json"
            invalidateKey={queryKeys.allRegexScripts}
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
          (globals.length === 0 ? (
            <EmptyState kind="regex" title={t('regex.emptyTitle')} hint={t('regex.emptyHint')} />
          ) : (
            <>
              <p className="text-xs text-ink-2">{t('regex.count', { total: globals.length })}</p>
              <ul className="edge-rule border-t">
                {globals.map((script, index) =>
                  renderRow(script, { index, total: globals.length }),
                )}
              </ul>
            </>
          ))}
      </SettingsSection>

      {groups.length > 0 && (
        <SettingsSection title={t('regex.embedded.title')} hint={t('regex.embedded.hint')}>
          <div className="space-y-4">
            {groups.map((group) => {
              const anyEnabled = group.scripts.some((script) => !script.disabled);
              const collapsed = collapsedGroups.has(group.key);
              const contentId = `regex-group-${group.key}`;
              return (
                <div key={group.key}>
                  <div className="flex items-center justify-between gap-2 py-1">
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      aria-controls={contentId}
                      aria-label={t(
                        collapsed ? 'regex.embedded.expand' : 'regex.embedded.collapse',
                        { name: group.title },
                      )}
                      onClick={() =>
                        setCollapsedGroups((current) => {
                          const next = new Set(current);
                          if (next.has(group.key)) next.delete(group.key);
                          else next.add(group.key);
                          return next;
                        })
                      }
                      className="focus-ring-inset flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                    >
                      <ChevronDown
                        aria-hidden
                        className={cn(
                          'size-4 shrink-0 text-ink-2 motion-transform',
                          collapsed && '-rotate-90',
                        )}
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="muted">{t(`regex.embedded.scopes.${group.scope}`)}</Badge>
                          <span className="truncate text-sm font-medium">{group.title}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-ink-2">
                          {t('regex.embedded.groupCount', { total: group.scripts.length })}
                        </p>
                      </div>
                    </button>
                    <Switch
                      checked={anyEnabled}
                      label={t('regex.embedded.toggleAll')}
                      disabled={setOwnerEnabled.isPending}
                      onChange={(checked) =>
                        group.ownerId &&
                        setOwnerEnabled.mutate({
                          scope: group.scope as 'character' | 'preset' | 'book',
                          ownerId: group.ownerId,
                          enabled: checked,
                        })
                      }
                    />
                  </div>
                  {!collapsed && (
                    <ul id={contentId} className="edge-rule border-t">
                      {group.scripts.map((script) => renderRow(script))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </SettingsSection>
      )}

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
    </div>
  );
}
