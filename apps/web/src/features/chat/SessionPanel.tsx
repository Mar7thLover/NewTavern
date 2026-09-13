import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { formatTokens, isUsageEmpty, renderMacros, sumUsage, totalInput } from './shared';
import { Badge } from '../../components/ui/badge';
import { FieldLabel, Input, Select } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import {
  useCharacter,
  useConnectionModels,
  useConnections,
  useGenerationDefault,
  usePatchChat,
  usePersonas,
  usePresets,
  useRefreshConnectionModels,
  type ChatDetail,
  type ChatOverrides,
  type LayoutMode,
  type MessageNode,
  type Usage,
} from '../../lib/api';
import { cn } from '../../lib/utils';
import { Avatar } from '../library/shared';

const LAYOUT_MODES: LayoutMode[] = ['strict', 'cache-aware'];

const USAGE_ROWS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;

export interface SessionPanelProps {
  chat: ChatDetail;
  /** root→head 路径，用于统计本会话用量 */
  path: MessageNode[];
}

export function SessionPanel({ chat, path }: SessionPanelProps) {
  const { t, i18n } = useTranslation();
  const patchChat = usePatchChat();
  const connections = useConnections();
  const personas = usePersonas();
  const presets = usePresets();
  const generationDefault = useGenerationDefault();
  const character = useCharacter(chat.character?.id ?? null);

  const overrides = chat.overrides ?? {};
  const effectiveConnectionId =
    overrides.connectionId ?? generationDefault.data?.connectionId ?? '';
  const effectiveModel = overrides.model ?? generationDefault.data?.model ?? '';
  const layoutMode: LayoutMode = overrides.layoutMode ?? 'cache-aware';

  const patchOverrides = (partial: Partial<ChatOverrides>) =>
    patchChat.mutate({ id: chat.id, overrides: { ...overrides, ...partial } });

  const lastUsageNode = [...path].reverse().find((node) => node.usage !== null);
  const sessionUsage = useMemo(() => sumUsage(path), [path]);

  const userName = personas.data?.find((item) => item.id === chat.personaId)?.name ?? null;
  const description = useMemo(() => {
    const raw = character.data?.data.description;
    if (typeof raw !== 'string') return '';
    return renderMacros(
      raw.replace(/\s+/g, ' ').trim(),
      chat.character?.name,
      userName ?? t('chat.defaultUserName'),
    );
  }, [character.data, chat.character?.name, userName, t]);

  return (
    <div className="flex flex-col gap-5 p-4">
      {/* 角色 */}
      {chat.character ? (
        <section className="flex gap-3">
          <Avatar
            name={chat.character.name}
            assetId={chat.character.avatarAssetId}
            className="size-12 rounded-lg"
            textClassName="text-lg"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{chat.character.name}</div>
            <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
              {description || t('chat.panel.noDescription')}
            </p>
          </div>
        </section>
      ) : (
        <section className="text-sm text-muted-foreground">{t('chat.panel.noCharacter')}</section>
      )}

      {/* 连接与模型 */}
      <section>
        <FieldLabel>{t('chat.panel.connection')}</FieldLabel>
        {connections.data && connections.data.length === 0 ? (
          <Link
            to="/connections"
            className="inline-block text-sm text-primary underline underline-offset-2"
          >
            {t('chat.panel.addConnection')}
          </Link>
        ) : (
          <Select
            size="sm"
            value={effectiveConnectionId}
            onChange={(event) =>
              patchOverrides({ connectionId: event.target.value || null, model: null })
            }
          >
            <option value="">{t('chat.panel.connectionUnset')}</option>
            {(connections.data ?? []).map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label}
              </option>
            ))}
          </Select>
        )}

        <div className="mt-3">
          <FieldLabel>{t('chat.panel.model')}</FieldLabel>
          <ModelPicker
            connectionId={effectiveConnectionId || null}
            value={effectiveModel}
            onChange={(model) => patchOverrides({ model: model || null })}
          />
        </div>
      </section>

      {/* Persona 与预设 */}
      <section className="space-y-3">
        <div>
          <FieldLabel>{t('chat.panel.persona')}</FieldLabel>
          <Select
            size="sm"
            value={chat.personaId ?? ''}
            onChange={(event) =>
              patchChat.mutate({ id: chat.id, personaId: event.target.value || null })
            }
          >
            <option value="">{t('chat.panel.none')}</option>
            {(personas.data ?? []).map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel>{t('chat.panel.preset')}</FieldLabel>
          <Select
            size="sm"
            value={chat.presetId ?? ''}
            onChange={(event) =>
              patchChat.mutate({ id: chat.id, presetId: event.target.value || null })
            }
          >
            <option value="">{t('chat.panel.builtinPreset')}</option>
            {(presets.data ?? []).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </Select>
        </div>
      </section>

      {/* 布局模式 */}
      <section>
        <FieldLabel>{t('chat.panel.layoutMode')}</FieldLabel>
        <div className="flex gap-1 rounded-md bg-muted/60 p-0.5">
          {LAYOUT_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => patchOverrides({ layoutMode: mode })}
              className={cn(
                'flex-1 cursor-pointer rounded px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                layoutMode === mode
                  ? 'bg-card font-medium text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`chat.panel.layout.${mode === 'cache-aware' ? 'cacheAware' : 'strict'}`)}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {t(
            layoutMode === 'strict'
              ? 'chat.panel.layout.strictHint'
              : 'chat.panel.layout.cacheAwareHint',
          )}
        </p>
      </section>

      {/* 用量 */}
      <section className="space-y-2">
        <FieldLabel>{t('chat.panel.usage')}</FieldLabel>
        <UsageCard
          title={t('chat.panel.lastTurn')}
          usage={lastUsageNode?.usage ?? null}
          language={i18n.language}
          note={lastUsageNode?.model ?? null}
        />
        <UsageCard
          title={t('chat.panel.sessionTotal')}
          usage={isUsageEmpty(sessionUsage) ? null : sessionUsage}
          language={i18n.language}
          note={t('chat.panel.messages', { total: path.length })}
        />
      </section>
    </div>
  );
}

/** 模型选择：可搜索的候选列表 + 手动输入（中转站常有目录里没有的模型） */
function ModelPicker({
  connectionId,
  value,
  onChange,
}: {
  connectionId: string | null;
  value: string;
  onChange: (model: string) => void;
}) {
  const { t } = useTranslation();
  const models = useConnectionModels(connectionId);
  const refresh = useRefreshConnectionModels();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => setQuery(value), [value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  const options = useMemo(() => {
    const list = models.data?.models ?? [];
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? list.filter((model) => model.id.toLowerCase().includes(needle))
      : list;
    return filtered.slice(0, 60);
  }, [models.data, query]);

  const commit = (model: string) => {
    setOpen(false);
    const trimmed = model.trim();
    if (trimmed !== value) onChange(trimmed);
    setQuery(trimmed);
  };

  return (
    <div ref={boxRef} className="relative">
      <div className="flex gap-1">
        <Input
          size="sm"
          value={query}
          disabled={connectionId === null}
          placeholder={t('chat.panel.modelPlaceholder')}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => commit(query)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(query);
            } else if (event.key === 'Escape') {
              setOpen(false);
              setQuery(value);
            }
          }}
        />
        <IconButton
          label={t('connections.refreshModels')}
          variant="outline"
          disabled={connectionId === null || refresh.isPending}
          onClick={() => connectionId && refresh.mutate(connectionId)}
          className="size-8"
        >
          <RefreshCw aria-hidden className={cn(refresh.isPending && 'animate-spin')} />
        </IconButton>
      </div>
      {open && options.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-card py-1 shadow-lg">
          {options.map((model) => (
            <li key={model.id}>
              <button
                type="button"
                // onBlur 会先触发，用 mousedown 抢在它之前
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(model.id);
                }}
                className={cn(
                  'block w-full cursor-pointer truncate px-2.5 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground',
                  model.id === value && 'font-medium text-primary',
                )}
              >
                {model.id}
              </button>
            </li>
          ))}
        </ul>
      )}
      {models.error && (
        <p className="mt-1 text-[11px] text-destructive">{t('connections.modelsFailed')}</p>
      )}
    </div>
  );
}

/** 用量卡片：五项 token 数 + 缓存命中占总输入的比例条 */
function UsageCard({
  title,
  usage,
  language,
  note,
}: {
  title: string;
  usage: Usage | null;
  language: string;
  note: string | null;
}) {
  const { t } = useTranslation();
  const total = usage ? totalInput(usage) : 0;
  const ratio = usage && total > 0 ? usage.cacheRead / total : 0;

  return (
    <div className="rounded-lg border border-border bg-card/60 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{title}</span>
        {note && <span className="truncate text-[11px] text-muted-foreground">{note}</span>}
      </div>
      {usage === null ? (
        <p className="mt-1.5 text-[11px] text-muted-foreground">{t('chat.panel.noUsage')}</p>
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {USAGE_ROWS.map((key) => (
              <div key={key} className="flex items-baseline justify-between gap-1">
                <dt className="truncate text-muted-foreground">{t(`chat.panel.tokens.${key}`)}</dt>
                <dd className="tabular-nums">{formatTokens(usage[key], language)}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2.5">
            <div className="flex items-baseline justify-between text-[11px] text-muted-foreground">
              <span>{t('chat.panel.cacheHit')}</span>
              <span className="tabular-nums">{Math.round(ratio * 100)}%</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** 顶栏用的模型徽标 */
export function ModelBadge({ chat }: { chat: ChatDetail }) {
  const { t } = useTranslation();
  const generationDefault = useGenerationDefault();
  const model = chat.overrides?.model ?? generationDefault.data?.model ?? null;
  return (
    <Badge variant={model ? 'muted' : 'outline'} className="max-w-40 truncate">
      {model ?? t('chat.panel.connectionUnset')}
    </Badge>
  );
}
