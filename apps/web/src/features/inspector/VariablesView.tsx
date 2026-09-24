import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Rewind } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { VariableEditor } from './VariableEditor';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/field';
import { Segmented } from '../../components/ui/segmented';
import { useCharacter, type ChatDetail } from '../../lib/api';
import {
  fetchVariableTable,
  putVariableTable,
  useChatVariables,
  useMvuReplay,
  useMvuRun,
  useReplaceVariables,
  type MvuErrorInfo,
} from '../../lib/api-cards';
import { cn } from '../../lib/utils';
import { readCharacterScripts } from '../cards/ScriptRunner';
import { QueryStatus } from '../library/shared';
import { useScripts } from '../scripts/api';

/**
 * 检查器的「变量」页签（M5 §6、M5（三）§1 变量管理器）：
 * 五个作用域——本条消息（= chat，当前节点快照，MVU 在这）/ 全局 / 角色卡 / 预设 / 脚本——
 * 都是可编辑的树，保存 = 整表 PUT。本条消息另有「重新解析这条」「从这条重算」与本轮变化。
 *
 * 为什么放在检查器里：变量和提示词是一回事——`{{get_message_variable::stat_data}}`
 * 就写在预设里，看变量表就是在看「模型这一轮会读到什么」。
 */

type Scope = 'message' | 'global' | 'character' | 'preset' | 'script';

const SCOPES: Scope[] = ['message', 'global', 'character', 'preset', 'script'];

/** MVU 派生出来的两份表：能改，但默认折叠（下一轮会被重新算出来） */
const DERIVED_KEYS = ['display_data', 'delta_data'] as const;

function isValueWithDescription(value: unknown): value is [unknown, string] {
  return Array.isArray(value) && value.length === 2 && typeof value[1] === 'string';
}

interface Row {
  path: string;
  value: unknown;
}

/** 本轮变化摊平成「路径 → 值」的行；`$` 开头的簿记键不列 */
function flatten(value: unknown, prefix = '', out: Row[] = []): Row[] {
  if (isValueWithDescription(value)) {
    out.push({ path: prefix, value: value[0] });
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
  const replace = useReplaceVariables(chat.id);
  const run = useMvuRun(chat.id);
  const replay = useMvuReplay(chat.id);

  const table = variables.data;
  const characterId = chat.characterIds[0] ?? null;
  const presetId = table?.presetId ?? chat.presetId ?? null;
  const source =
    scope === 'message'
      ? table?.message
      : scope === 'global'
        ? table?.global
        : scope === 'character'
          ? table?.character
          : scope === 'preset'
            ? table?.preset
            : undefined;
  const delta =
    scope === 'message' && source && typeof source === 'object'
      ? flatten((source as { delta_data?: unknown }).delta_data ?? {})
      : [];
  // 报错来自「重新解析」与「重算」的返回：平时不显示，手动跑过才有
  const errors: MvuErrorInfo[] = [
    ...(run.data?.errors ?? []),
    ...(replay.data?.results.flatMap((result) => result.errors) ?? []),
  ];
  const schema =
    scope === 'script' ? undefined : table?.schemas?.[scope === 'message' ? 'message' : scope];

  const unavailable =
    (scope === 'character' && !characterId) || (scope === 'preset' && !presetId)
      ? t(scope === 'character' ? 'variableEditor.noCharacter' : 'variableEditor.noPreset')
      : null;

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

      {unavailable ? (
        <p className="py-6 text-center text-sm text-ink-2">{unavailable}</p>
      ) : scope === 'script' ? (
        <ScriptVariables chat={chat} disabled={isGenerating} />
      ) : (
        table && (
          <VariableEditor
            // 换作用域 / 换节点就是换一张表：重建编辑器，草稿不串
            key={`${scope}:${scope === 'message' ? (table.nodeId ?? '') : ''}`}
            table={(source ?? {}) as Record<string, unknown>}
            schema={schema}
            saving={replace.isPending}
            disabled={scope === 'message' && (isGenerating || !nodeId)}
            collapsedKeys={scope === 'message' ? DERIVED_KEYS : []}
            note={
              scope === 'message'
                ? t('variableEditor.messageNote')
                : scope === 'preset'
                  ? t('variableEditor.presetNote')
                  : undefined
            }
            onSave={(next) =>
              replace.mutateAsync({
                scope,
                ...(scope === 'message' ? { nodeId: table.nodeId ?? nodeId } : {}),
                ...(scope === 'preset' && presetId ? { ownerId: presetId } : {}),
                variables: next,
              })
            }
          />
        )
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

/**
 * 脚本作用域：先选脚本（全局 → 当前预设 → 当前角色卡，与 ScriptRunner 的运行顺序一致），
 * 再编辑它自己的变量表（`variables` 表 scope='script'、ownerId=脚本 id）。
 */
function ScriptVariables({ chat, disabled }: { chat: ChatDetail; disabled: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const globalRows = useScripts('global', null);
  const presetRows = useScripts('preset', chat.presetId ?? null);
  const character = useCharacter(chat.characterIds[0] ?? null);
  const options = useMemo(
    () => [
      ...(globalRows.data ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        group: 'global' as const,
      })),
      ...(chat.presetId ? (presetRows.data ?? []) : []).map((row) => ({
        id: row.id,
        name: row.name,
        group: 'preset' as const,
      })),
      ...readCharacterScripts(character.data).map((script) => ({
        id: script.id,
        name: script.name,
        group: 'character' as const,
      })),
    ],
    [globalRows.data, presetRows.data, character.data, chat.presetId],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const scriptId = picked ?? options[0]?.id ?? null;
  const tableQuery = useQuery({
    queryKey: ['variables', 'script', scriptId ?? ''],
    queryFn: () => fetchVariableTable('script', scriptId as string),
    enabled: scriptId !== null,
  });
  const [saving, setSaving] = useState(false);

  if (options.length === 0) {
    return <p className="py-6 text-center text-sm text-ink-2">{t('variableEditor.noScripts')}</p>;
  }
  return (
    <div className="space-y-2">
      <Select
        size="sm"
        aria-label={t('variableEditor.pickScript')}
        value={scriptId ?? ''}
        onChange={(event) => setPicked(event.target.value)}
      >
        {options.map((option) => (
          <option key={`${option.group}:${option.id}`} value={option.id}>
            {t(`variableEditor.scriptGroups.${option.group}`)} · {option.name || option.id}
          </option>
        ))}
      </Select>
      <QueryStatus isPending={tableQuery.isPending} error={tableQuery.error} />
      {tableQuery.data && scriptId && (
        <VariableEditor
          key={scriptId}
          table={tableQuery.data.variables}
          saving={saving}
          disabled={disabled}
          onSave={async (next) => {
            setSaving(true);
            try {
              const result = await putVariableTable('script', scriptId, next);
              queryClient.setQueryData(['variables', 'script', scriptId], result);
            } finally {
              setSaving(false);
            }
          }}
        />
      )}
    </div>
  );
}
