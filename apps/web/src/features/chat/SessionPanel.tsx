import { RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import {
  AuthorsNoteSection,
  ChatLorebooksSection,
  ChatSystemPromptSection,
} from './SessionSettings';
import { formatTokens, isUsageEmpty, renderMacros, sumUsage, totalInput } from './shared';
import { Badge } from '../../components/ui/badge';
import { FieldLabel, Input, Select } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import { Segmented } from '../../components/ui/segmented';
import {
  useCharacter,
  useConnectionModels,
  useConnections,
  useGenerationDefault,
  useModelCapabilities,
  usePatchChat,
  usePersonas,
  usePreset,
  usePresets,
  useRefreshConnectionModels,
  type ChatDetail,
  type ChatOverrides,
  type LayoutMode,
  type MessageNode,
  type ModelCapabilities,
  type ThinkingOverride,
  type Usage,
} from '../../lib/api';
import { cn } from '../../lib/utils';
import { Avatar } from '../library/shared';

const LAYOUT_MODES: LayoutMode[] = ['strict', 'cache-aware'];

const USAGE_ROWS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const;

/**
 * budget 型模型（Claude Haiku 4.5、Gemini 2.5、Anthropic 兼容的 GLM 等）的三档预算（token）。
 * 实际值再夹到 maxOutput − 1024（给正文留余量，且不低于 API 下限 1024）。
 */
const BUDGET_LEVELS = [
  { level: 'low', tokens: 2048 },
  { level: 'medium', tokens: 8192 },
  { level: 'high', tokens: 24576 },
] as const;
const MIN_BUDGET = 1024;

/** 能力没写 effortLevels 时的兜底档位 */
const FALLBACK_LEVELS: Partial<Record<NonNullable<ModelCapabilities['thinking']>, string[]>> = {
  adaptive: ['low', 'medium', 'high'],
  effort: ['low', 'medium', 'high'],
  level: ['low', 'high'],
};

interface ThinkingChoice {
  /** `off` / `effort:<档位>` / `budget:<档位>` */
  key: string;
  thinking: ThinkingOverride;
  level?: string;
  tokens?: number;
}

/** 按模型能力列出可选的推理档位（不含「跟随预设」） */
function thinkingChoices(caps: ModelCapabilities): ThinkingChoice[] {
  const choices: ThinkingChoice[] = [];
  if (caps.canDisableThinking) choices.push({ key: 'off', thinking: { enabled: false } });
  if (caps.thinking === 'budget') {
    const limit = Math.max(MIN_BUDGET, (caps.maxOutput ?? 32768) - 1024);
    const seen = new Set<number>();
    for (const { level, tokens } of BUDGET_LEVELS) {
      const budget = Math.min(tokens, limit);
      if (seen.has(budget)) continue;
      seen.add(budget);
      choices.push({
        key: `budget:${level}`,
        thinking: { budgetTokens: budget },
        level,
        tokens: budget,
      });
    }
    return choices;
  }
  const levels = caps.effortLevels ?? FALLBACK_LEVELS[caps.thinking ?? 'none'] ?? [];
  for (const level of levels) {
    // 能关闭时 `none` 与「关闭」是同一回事，不重复列出
    if (level === 'none' && caps.canDisableThinking) continue;
    choices.push({ key: `effort:${level}`, thinking: { effort: level }, level });
  }
  return choices;
}

function sameThinking(a: ThinkingOverride, b: ThinkingOverride): boolean {
  if (a.enabled === false || b.enabled === false) return a.enabled === b.enabled;
  return a.effort === b.effort && a.budgetTokens === b.budgetTokens;
}

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
  /** null = 跟随预设：从 overrides 里删掉 thinking 键 */
  const setThinking = (thinking: ThinkingOverride | null) => {
    const next: ChatOverrides = { ...overrides };
    delete next.thinking;
    if (thinking) next.thinking = thinking;
    patchChat.mutate({ id: chat.id, overrides: next });
  };

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
    <div data-part="session-panel" className="flex flex-col gap-5 p-4">
      {/* 角色 */}
      {chat.character ? (
        <section className="flex gap-3">
          <Avatar
            name={chat.character.name}
            assetId={chat.character.avatarAssetId}
            className="size-12"
            textClassName="text-lg"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{chat.character.name}</div>
            <p className="mt-0.5 line-clamp-3 text-xs leading-relaxed text-ink-2">
              {description || t('chat.panel.noDescription')}
            </p>
          </div>
        </section>
      ) : (
        <section className="text-sm text-ink-2">{t('chat.panel.noCharacter')}</section>
      )}

      {/* 连接与模型 */}
      <section>
        <FieldLabel>{t('chat.panel.connection')}</FieldLabel>
        {connections.data && connections.data.length === 0 ? (
          <Link
            to="/connections"
            className="inline-block text-sm text-accent underline underline-offset-2"
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

        <ThinkingSelect
          chat={chat}
          connectionId={effectiveConnectionId || null}
          model={effectiveModel || null}
          onChange={setThinking}
        />
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
            {/* 「无」= presetId null：不用任何预设，没有主提示词 */}
            <option value="">{t('chat.panel.noPreset')}</option>
            {(presets.data ?? []).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </Select>
        </div>
      </section>

      {/* 作者注释 / 聊天世界书 / 全局系统提示词覆盖（M3 契约 §7.2） */}
      <div className="edge-rule border-t">
        <AuthorsNoteSection chat={chat} />
        <ChatLorebooksSection chat={chat} />
        <ChatSystemPromptSection chat={chat} />
      </div>

      {/* 布局模式 */}
      <section>
        <FieldLabel>{t('chat.panel.layoutMode')}</FieldLabel>
        <Segmented
          stretch
          value={layoutMode}
          onChange={(mode) => patchOverrides({ layoutMode: mode })}
          items={LAYOUT_MODES.map((mode) => ({
            value: mode,
            label: t(`chat.panel.layout.${mode === 'cache-aware' ? 'cacheAware' : 'strict'}`),
          }))}
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-2">
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

/**
 * 推理强度：只在当前模型支持推理时出现。
 * 「跟随预设」= 不设覆盖，由预设的 `reasoning_effort` 决定；选项按模型能力给出（可关闭时有「关闭」）。
 * 换模型后若已存的覆盖不在新模型的选项里，自动清掉（回到跟随预设）。
 */
function ThinkingSelect({
  chat,
  connectionId,
  model,
  onChange,
}: {
  chat: ChatDetail;
  connectionId: string | null;
  model: string | null;
  onChange: (thinking: ThinkingOverride | null) => void;
}) {
  const { t } = useTranslation();
  const caps = useModelCapabilities(connectionId, model);
  const preset = usePreset(chat.presetId);
  const current = chat.overrides?.thinking;

  const choices = useMemo(() => (caps.data ? thinkingChoices(caps.data) : []), [caps.data]);
  const selected = current
    ? choices.find((choice) => sameThinking(choice.thinking, current))
    : null;
  const stale = current !== undefined && caps.data !== undefined && selected === undefined;

  // 覆盖不再适用（换了模型 / 模型不支持推理）：清掉一次，避免重复 PATCH
  const clearedFor = useRef<string | null>(null);
  const staleKey = `${connectionId ?? ''}|${model ?? ''}|${JSON.stringify(current ?? null)}`;
  useEffect(() => {
    if (!stale || clearedFor.current === staleKey) return;
    clearedFor.current = staleKey;
    onChange(null);
  }, [stale, staleKey, onChange]);

  if (!caps.data || !caps.data.thinking || caps.data.thinking === 'none') return null;

  const presetSampling = preset.data?.sampling?.reasoning_effort;
  const presetEffort =
    chat.presetId === null
      ? 'auto'
      : typeof presetSampling === 'string'
        ? presetSampling
        : typeof preset.data?.data.reasoning_effort === 'string'
          ? preset.data.data.reasoning_effort
          : 'auto';
  const levelLabel = (level: string) =>
    t(`chat.panel.thinkingLevels.${level}`, { defaultValue: level });
  const labelOf = (choice: ThinkingChoice) => {
    if (choice.key === 'off') return t('chat.panel.thinkingOff');
    if (choice.tokens !== undefined && choice.level) {
      return t('chat.panel.thinkingBudget', {
        level: levelLabel(choice.level),
        tokens: choice.tokens.toLocaleString(),
      });
    }
    return levelLabel(choice.level ?? '');
  };

  return (
    <div data-part="thinking-select" data-value={selected?.key ?? 'follow'} className="mt-3">
      <FieldLabel>{t('chat.panel.thinking')}</FieldLabel>
      <Select
        size="sm"
        value={selected?.key ?? ''}
        onChange={(event) => {
          const choice = choices.find((item) => item.key === event.target.value);
          onChange(choice ? choice.thinking : null);
        }}
      >
        <option value="">
          {t('chat.panel.thinkingFollow', {
            value: t(`chat.panel.thinkingPreset.${presetEffort}`, { defaultValue: presetEffort }),
          })}
        </option>
        {choices.map((choice) => (
          <option key={choice.key} value={choice.key}>
            {labelOf(choice)}
          </option>
        ))}
      </Select>
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
          <RefreshCw aria-hidden className={cn(refresh.isPending && 'opacity-40')} />
        </IconButton>
      </div>
      {open && options.length > 0 && (
        <ul className="surface-raised rounded-control edge-rule absolute z-20 mt-1 max-h-56 w-full overflow-y-auto border py-1">
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
                  'block w-full cursor-pointer truncate px-2.5 py-1.5 text-left text-xs hover:text-accent',
                  model.id === value && 'font-medium text-accent',
                )}
              >
                {model.id}
              </button>
            </li>
          ))}
        </ul>
      )}
      {models.error && (
        <p className="mt-1 text-[11px] text-danger">{t('connections.modelsFailed')}</p>
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
    <div data-part="usage-card" className="edge-rule border-t pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium">{title}</span>
        {note && <span className="truncate text-[11px] text-ink-2">{note}</span>}
      </div>
      {usage === null ? (
        <p className="mt-1.5 text-[11px] text-ink-2">{t('chat.panel.noUsage')}</p>
      ) : (
        <>
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {USAGE_ROWS.map((key) => (
              <div key={key} className="flex items-baseline justify-between gap-1">
                <dt className="truncate text-ink-2">{t(`chat.panel.tokens.${key}`)}</dt>
                <dd className="tabular-nums">{formatTokens(usage[key], language)}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2.5">
            <div className="flex items-baseline justify-between text-[11px] text-ink-2">
              <span>{t('chat.panel.cacheHit')}</span>
              <span className="tabular-nums">{Math.round(ratio * 100)}%</span>
            </div>
            {/* 比例条也只是线：底线 1px 发丝，命中部分叠一段 1px 橙线 */}
            <div data-part="usage-bar" className="edge-rule relative mt-1.5 border-t">
              <div
                data-part="usage-bar-fill"
                className="absolute start-0 -top-px border-t border-accent"
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
