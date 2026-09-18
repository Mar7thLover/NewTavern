import { RefreshCw, Rewind } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Segmented } from '../../components/ui/segmented';
import type { ChatDetail } from '../../lib/api';
import {
  useChatVariables,
  useMvuReplay,
  useMvuRun,
  type MvuErrorInfo,
} from '../../lib/api-cards';
import { cn } from '../../lib/utils';
import { QueryStatus } from '../library/shared';

/**
 * 检查器的「变量」页签：看当前这条消息的变量表、本轮变化与解析报错。
 * 见 docs/M5-CONTRACT.md §6.2。
 *
 * 为什么放在检查器里：变量和提示词是一回事——`{{get_message_variable::stat_data}}`
 * 就写在预设里，看变量表就是在看「模型这一轮会读到什么」。
 */

type Scope = 'message' | 'global' | 'character';

const SCOPES: Scope[] = ['message', 'global', 'character'];

/** `[值, "说明"]` 是社区 MVU 卡最常见的写法：值一列、说明当提示 */
function isValueWithDescription(value: unknown): value is [unknown, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[1] === 'string';
}

interface Row {
  path: string;
  value: unknown;
  description?: string;
}

/** 摊平成「路径 → 值」的行；`$` 开头的簿记键（`$meta` / `$internal`）不列 */
function flatten(value: unknown, prefix = '', out: Row[] = []): Row[] {
  if (isValueWithDescription(value)) {
    out.push({ path: prefix, value: value[0], description: value[1] });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out));
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('$')) continue;
      flatten(item, prefix === '' ? key : `${prefix}.${key}`, out);
    }
    return out;
  }
  if (prefix !== '') out.push({ path: prefix, value });
  return out;
}

function display(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (value === undefined) return '—';
  return JSON.stringify(value) ?? String(value);
}

export interface VariablesViewProps {
  chat: ChatDetail;
  isGenerating: boolean;
}

export function VariablesView({ chat, isGenerating }: VariablesViewProps) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<Scope>('message');
  const nodeId = chat.headNodeId;
  const variables = useChatVariables(chat.id, nodeId);
  const run = useMvuRun(chat.id);
  const replay = useMvuReplay(chat.id);

  const table = variables.data;
  const source =
    scope === 'message' ? table?.message : scope === 'global' ? table?.global : table?.character;
  const statData =
    scope === 'message' && source && typeof source === 'object' && 'stat_data' in source
      ? (source as { stat_data?: unknown }).stat_data
      : source;
  const rows = flatten(statData ?? {});
  const delta =
    scope === 'message' && source && typeof source === 'object'
      ? flatten((source as { delta_data?: unknown }).delta_data ?? {})
      : [];
  // 报错来自「重新解析」与「重算」的返回：平时不显示，手动跑过才有
  const errors: MvuErrorInfo[] = [
    ...(run.data?.errors ?? []),
    ...(replay.data?.results.flatMap((result) => result.errors) ?? []),
  ];

  return (
    <div data-part="inspector-variables" className="space-y-3 p-3">
      <Segmented
        label={t('cards.variables.title')}
        value={scope}
        onChange={setScope}
        items={SCOPES.map((item) => ({ value: item, label: t(`cards.variables.scope.${item}`) }))}
      />

      {scope === 'message' && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={isGenerating || run.isPending || !nodeId}
            onClick={() => run.mutate(nodeId)}
          >
            <RefreshCw aria-hidden className={cn('size-3.5', run.isPending && 'opacity-40')} />
            {t('cards.variables.rerun')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={isGenerating || replay.isPending || !nodeId}
            onClick={() => replay.mutate(null)}
          >
            <Rewind aria-hidden className="size-3.5" />
            {t('cards.variables.replay')}
          </Button>
          {replay.data && (
            <span role="status" className="text-xs text-ink-2">
              {t('cards.variables.replayDone', { count: replay.data.results.length })}
            </span>
          )}
        </div>
      )}

      <QueryStatus isPending={variables.isPending} error={variables.error} />

      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-2">
          {t('cards.variables.empty')}
          <br />
          <span className="text-xs">{t('cards.variables.initHint')}</span>
        </p>
      ) : (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-ink-2">{t('cards.variables.statData')}</h3>
          <div className="rounded-card edge-rule divide-y divide-edge border">
            {rows.map((row) => (
              <div key={row.path} className="flex items-baseline gap-3 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2" title={row.path}>
                  {row.path}
                </span>
                <span className="max-w-[55%] text-right text-[13px] break-words tabular-nums">
                  {display(row.value)}
                </span>
                {row.description && (
                  <span className="hidden max-w-[30%] truncate text-[11px] text-ink-3 sm:inline" title={row.description}>
                    {row.description}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {scope === 'message' && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-ink-2">{t('cards.variables.delta')}</h3>
          {delta.length === 0 ? (
            <p className="text-xs text-ink-3">{t('cards.variables.noDelta')}</p>
          ) : (
            <div className="rounded-card edge-rule divide-y divide-edge border">
              {delta.map((row) => (
                <div key={row.path} className="flex items-baseline gap-3 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">
                    {row.path}
                  </span>
                  <span className="text-right text-[13px]">{display(row.value)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {errors.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-danger">{t('cards.variables.errors')}</h3>
          {errors.map((error, index) => (
            <p key={index} className="font-mono text-[11px] break-all text-ink-2">
              <Badge variant="muted">{error.command}</Badge> {error.message}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}
