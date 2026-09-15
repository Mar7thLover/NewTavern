import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, Plus } from 'lucide-react';
import {
  memo,
  useCallback,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useBeforeUnload, useBlocker, useParams } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Button } from '../../components/ui/button';
import { FieldLabel, Input, Select, Textarea } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import { Switch } from '../../components/ui/switch';
import { Badge } from '../../components/ui/badge';
import {
  useBuiltinPresetId,
  usePreset,
  useResetBuiltinPreset,
  useUpdatePreset,
  type PresetDetail,
} from '../../lib/api';
import { cn } from '../../lib/utils';
import { LibraryHeader, QueryStatus, errorMessage } from './shared';

/*
 * 预设基础编辑器（`/presets/:id`）。
 *
 * 编辑的是 ST 预设 JSON 原文（`PresetDetail.data`）的一份草稿：所有改动都是「浅拷贝改一处」，
 * 没碰到的字段（包括未知字段）原样带回服务端，导出因此无损。
 * 条目列表与组装器读的是同一份 `prompt_order`（见 packages/core `readPromptOrder`）。
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 与 `@newtavern/compat` 的 `ST_SAMPLING_KEYS` 保持一致（web 不依赖 compat） */
const SAMPLING_KEYS = [
  'temperature',
  'top_p',
  'top_k',
  'top_a',
  'min_p',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'openai_max_tokens',
  'openai_max_context',
  'seed',
  'n',
  'reasoning_effort',
] as const;

const INTEGER_KEYS = new Set<string>([
  'top_k',
  'openai_max_tokens',
  'openai_max_context',
  'seed',
  'n',
]);

/** ST `reasoning_effort` 的取值 */
const REASONING_EFFORTS = ['auto', 'min', 'low', 'medium', 'high', 'max'];

/** 组装器挑 `prompt_order` 的顺序：100001 → 100000 → 第一份（core `PROMPT_ORDER_DUMMY_IDS`） */
const PROMPT_ORDER_DUMMY_IDS = ['100001', '100000'];

const KNOWN_MARKERS = new Set([
  'chatHistory',
  'worldInfoBefore',
  'worldInfoAfter',
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
  'dialogueExamples',
]);

const ROLES = ['system', 'user', 'assistant'] as const;
/** ST `INJECTION_POSITION`：0 相对、1 聊天内（按深度注入） */
const POSITION_IN_CHAT = 1;
const DEFAULT_DEPTH = 4;
const DEFAULT_ORDER = 100;

/** 组装实际使用的那份 prompt_order 在数组里的下标；没有返回 -1 */
function activeOrderIndex(data: Json): number {
  const lists = data.prompt_order;
  if (!Array.isArray(lists)) return -1;
  for (const dummyId of PROMPT_ORDER_DUMMY_IDS) {
    const index = lists.findIndex(
      (list) => isRecord(list) && String(list.character_id) === dummyId,
    );
    if (index >= 0) return isRecord(lists[index]) && Array.isArray(lists[index].order) ? index : -1;
  }
  const first = lists.findIndex(isRecord);
  return first >= 0 && Array.isArray((lists[first] as Json).order) ? first : -1;
}

function readOrder(data: Json, index: number): Json[] {
  if (index < 0) return [];
  const list = (data.prompt_order as Json[])[index];
  return ((list?.order as unknown[] | undefined) ?? []).filter(isRecord);
}

function readPrompts(data: Json): Json[] {
  return Array.isArray(data.prompts) ? data.prompts.filter(isRecord) : [];
}

function replaceOrder(data: Json, index: number, fn: (order: Json[]) => Json[]): Json {
  if (index < 0) return data;
  const lists = [...(data.prompt_order as unknown[])];
  const list = lists[index] as Json;
  lists[index] = { ...list, order: fn([...(list.order as Json[])]) };
  return { ...data, prompt_order: lists };
}

function newIdentifier(existing: Set<string>): string {
  for (;;) {
    const id = crypto.randomUUID();
    if (!existing.has(id)) return id;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/* ------------------------------------------------------------------ */

export function PresetEditorPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const preset = usePreset(id);

  return (
    <div data-part="preset-editor" className="mx-auto max-w-4xl">
      <Link
        to="/presets"
        className="focus-ring rounded-control mb-3 inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        {t('presets.back')}
      </Link>
      <QueryStatus
        isPending={preset.isPending}
        error={preset.error}
        onRetry={() => void preset.refetch()}
      />
      {/* key：换了预设就整体重建草稿 */}
      {preset.data && <PresetEditor key={preset.data.id} preset={preset.data} />}
    </div>
  );
}

function PresetEditor({ preset }: { preset: PresetDetail }) {
  const { t } = useTranslation();
  const update = useUpdatePreset(preset.id);
  const builtinPresetId = useBuiltinPresetId();
  const resetBuiltin = useResetBuiltinPreset(preset.id);
  const isBuiltin = builtinPresetId.data === preset.id;
  const [confirmReset, setConfirmReset] = useState(false);

  const [baseline, setBaseline] = useState(() => ({
    name: preset.name,
    json: JSON.stringify(preset.data),
    data: preset.data,
  }));
  const [name, setName] = useState(preset.name);
  const [draft, setDraft] = useState<Json>(preset.data);
  /** 放弃修改时递增，让数值输入框这类带本地文本状态的控件重建 */
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const dataDirty = useMemo(
    () => draft !== baseline.data && JSON.stringify(draft) !== baseline.json,
    [draft, baseline],
  );
  const nameValid = name.trim() !== '';
  const dirty = dataDirty || name.trim() !== baseline.name;

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (dirty) event.preventDefault();
      },
      [dirty],
    ),
  );

  const orderIndex = activeOrderIndex(draft);
  const order = readOrder(draft, orderIndex);
  const prompts = readPrompts(draft);
  const promptById = useMemo(() => {
    const map = new Map<string, Json>();
    for (const prompt of prompts) {
      if (typeof prompt.identifier === 'string') map.set(prompt.identifier, prompt);
    }
    return map;
  }, [prompts]);

  /* ---------- 草稿修改（全部是函数式 setState，回调引用稳定） ---------- */

  const setField = useCallback((key: string, value: unknown) => {
    setDraft((data) => ({ ...data, [key]: value }));
  }, []);

  const toggleEntry = useCallback((position: number, enabled: boolean) => {
    setDraft((data) =>
      replaceOrder(data, activeOrderIndex(data), (entries) => {
        const entry = entries[position];
        if (entry) entries[position] = { ...entry, enabled };
        return entries;
      }),
    );
  }, []);

  const moveEntry = useCallback((position: number, delta: -1 | 1) => {
    setDraft((data) =>
      replaceOrder(data, activeOrderIndex(data), (entries) => {
        const target = position + delta;
        if (target < 0 || target >= entries.length) return entries;
        const [entry] = entries.splice(position, 1);
        if (entry) entries.splice(target, 0, entry);
        return entries;
      }),
    );
  }, []);

  const patchPrompt = useCallback((identifier: string, patch: Json) => {
    setDraft((data) => ({
      ...data,
      prompts: (data.prompts as unknown[]).map((prompt) =>
        isRecord(prompt) && prompt.identifier === identifier ? { ...prompt, ...patch } : prompt,
      ),
    }));
  }, []);

  const toggleOpen = useCallback((identifier: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(identifier)) next.delete(identifier);
      else next.add(identifier);
      return next;
    });
  }, []);

  const addPrompt = () => {
    const identifier = newIdentifier(new Set(promptById.keys()));
    setDraft((data) => {
      const withPrompt: Json = {
        ...data,
        prompts: [
          ...(Array.isArray(data.prompts) ? data.prompts : []),
          {
            identifier,
            name: t('presets.newPromptName'),
            system_prompt: false,
            role: 'system',
            content: '',
            injection_position: 0,
            injection_depth: DEFAULT_DEPTH,
            injection_order: DEFAULT_ORDER,
            forbid_overrides: false,
          },
        ],
      };
      return replaceOrder(withPrompt, activeOrderIndex(withPrompt), (entries) => [
        ...entries,
        { identifier, enabled: true },
      ]);
    });
    setExpanded((current) => new Set(current).add(identifier));
    setJustAdded(identifier);
  };

  const deletePrompt = (identifier: string) => {
    setDraft((data) => ({
      ...data,
      prompts: (Array.isArray(data.prompts) ? data.prompts : []).filter(
        (prompt) => !(isRecord(prompt) && prompt.identifier === identifier),
      ),
      // 所有 prompt_order 里都去掉，免得留下悬空引用
      ...(Array.isArray(data.prompt_order)
        ? {
            prompt_order: data.prompt_order.map((list) =>
              isRecord(list) && Array.isArray(list.order)
                ? {
                    ...list,
                    order: list.order.filter(
                      (entry) => !(isRecord(entry) && entry.identifier === identifier),
                    ),
                  }
                : list,
            ),
          }
        : {}),
    }));
  };

  const discard = () => {
    setDraft(baseline.data);
    setName(baseline.name);
    setRevision((value) => value + 1);
    update.reset();
  };

  const save = () => {
    update.mutate(
      { name: name.trim(), data: draft },
      {
        onSuccess: (row) => {
          setBaseline({ name: row.name, json: JSON.stringify(row.data), data: row.data });
          setDraft(row.data);
          setName(row.name);
        },
      },
    );
  };

  /** 恢复内置内容：服务端返回的新行直接作为基线，本地草稿（含未保存的名称）一并丢弃 */
  const restoreBuiltin = () => {
    resetBuiltin.mutate(undefined, {
      onSuccess: (row) => {
        setBaseline({ name: row.name, json: JSON.stringify(row.data), data: row.data });
        setDraft(row.data);
        setName(row.name);
        setRevision((value) => value + 1);
        setExpanded(new Set());
        update.reset();
        setConfirmReset(false);
      },
    });
  };

  const nameId = useId();
  const samplingKeys = SAMPLING_KEYS.filter((key) => draft[key] !== undefined);
  const deleteTarget = pendingDelete ? promptById.get(pendingDelete) : undefined;

  return (
    <>
      <LibraryHeader
        title={name.trim() || baseline.name}
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {t('presets.promptCount', { total: order.length })}
            {isBuiltin && <Badge variant="muted">{t('presets.builtinBadge')}</Badge>}
          </span>
        }
      />

      <div className="space-y-10">
        <PresetSection
          section="basic"
          title={t('presets.sections.basic')}
          actions={
            isBuiltin ? (
              <Button
                variant="outline"
                size="sm"
                disabled={resetBuiltin.isPending}
                onClick={() => {
                  resetBuiltin.reset();
                  setConfirmReset(true);
                }}
              >
                {t('presets.resetBuiltin')}
              </Button>
            ) : undefined
          }
        >
          <div className="max-w-md">
            <FieldLabel htmlFor={nameId}>{t('presets.name')}</FieldLabel>
            <Input
              id={nameId}
              value={name}
              aria-invalid={!nameValid}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </PresetSection>

        <PresetSection
          section="sampling"
          title={t('presets.sections.sampling')}
          hint={t('presets.samplingHint')}
        >
          {samplingKeys.length === 0 ? (
            <p className="text-sm text-ink-3">{t('presets.samplingEmpty')}</p>
          ) : (
            <div key={revision} className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {samplingKeys.map((key) => (
                <SamplingField key={key} name={key} value={draft[key]} onChange={setField} />
              ))}
            </div>
          )}
        </PresetSection>

        <PresetSection
          section="prompts"
          title={t('presets.sections.prompts')}
          hint={orderIndex >= 0 ? t('presets.promptsHint') : t('presets.noOrder')}
          actions={
            <Button variant="outline" size="sm" onClick={addPrompt} disabled={orderIndex < 0}>
              <Plus aria-hidden className="size-3.5" />
              {t('presets.addPrompt')}
            </Button>
          }
        >
          {order.length > 0 && (
            <ol
              key={revision}
              data-part="preset-prompt-list"
              className="edge-rule divide-y divide-edge border-y"
            >
              {order.map((entry, position) => {
                const identifier = typeof entry.identifier === 'string' ? entry.identifier : '';
                return (
                  <PromptItem
                    // 按 identifier 作 key：移动后 DOM 节点复用，键盘焦点跟着按钮走
                    key={identifier || `#${position}`}
                    identifier={identifier}
                    position={position}
                    isFirst={position === 0}
                    isLast={position === order.length - 1}
                    enabled={entry.enabled === true}
                    prompt={promptById.get(identifier)}
                    open={expanded.has(identifier)}
                    autoFocus={justAdded === identifier}
                    onToggle={toggleEntry}
                    onMove={moveEntry}
                    onOpen={toggleOpen}
                    onPatch={patchPrompt}
                    onDelete={setPendingDelete}
                  />
                );
              })}
            </ol>
          )}
        </PresetSection>
      </div>

      <div
        data-part="preset-save-bar"
        data-dirty={dirty}
        className="surface-raised edge-rule rounded-card sticky bottom-3 z-10 border mt-10 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 px-4 py-3 md:bottom-5"
      >
        <p
          role={update.error ? 'alert' : 'status'}
          className={cn('me-auto min-w-0 text-xs', update.error ? 'text-danger' : 'text-ink-2')}
        >
          {update.error
            ? t('presets.saveFailed', { message: errorMessage(update.error) })
            : dirty
              ? t('presets.dirty')
              : update.isSuccess
                ? t('presets.saved')
                : t('presets.clean')}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={discard}
            disabled={!dirty || update.isPending}
          >
            {t('presets.discard')}
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || !nameValid || update.isPending}>
            {update.isPending ? t('presets.saving') : t('common.save')}
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title={t('presets.prompt.deleteTitle')}
        description={t('presets.prompt.deleteMessage', {
          name:
            (typeof deleteTarget?.name === 'string' && deleteTarget.name) || pendingDelete || '',
        })}
        confirmLabel={t('common.delete')}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deletePrompt(pendingDelete);
          setPendingDelete(null);
        }}
      />

      <ConfirmDialog
        open={confirmReset}
        destructive
        title={t('presets.resetBuiltinTitle')}
        description={t('presets.resetBuiltinMessage')}
        confirmLabel={t('presets.resetBuiltinConfirm')}
        pending={resetBuiltin.isPending}
        error={errorMessage(resetBuiltin.error)}
        onCancel={() => setConfirmReset(false)}
        onConfirm={restoreBuiltin}
      />

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        destructive
        title={t('presets.leaveTitle')}
        description={t('presets.leaveMessage')}
        confirmLabel={t('presets.leave')}
        onCancel={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */

function PresetSection({
  section,
  title,
  hint,
  actions,
  children,
}: {
  section: 'basic' | 'sampling' | 'prompts';
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-part="preset-section" data-section={section} className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {hint && <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{hint}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** 数值输入：本地保留原始文本，能解析成有限数时才写回草稿 */
function NumberInput({
  id,
  value,
  integer = false,
  size,
  onChange,
}: {
  id?: string;
  value: number;
  integer?: boolean;
  size?: 'sm' | 'md';
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const parsed = text.trim() === '' ? Number.NaN : Number(text);
  const valid = Number.isFinite(parsed) && (!integer || Number.isInteger(parsed));
  return (
    <Input
      id={id}
      type="number"
      inputMode={integer ? 'numeric' : 'decimal'}
      step={integer ? 1 : 0.01}
      size={size}
      value={text}
      aria-invalid={!valid}
      className="tabular-nums"
      onChange={(event: ChangeEvent<HTMLInputElement>) => {
        const next = event.target.value;
        setText(next);
        const number = next.trim() === '' ? Number.NaN : Number(next);
        if (Number.isFinite(number) && (!integer || Number.isInteger(number))) onChange(number);
      }}
    />
  );
}

function SamplingField({
  name,
  value,
  onChange,
}: {
  name: (typeof SAMPLING_KEYS)[number];
  value: unknown;
  onChange: (key: string, value: unknown) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  let control: ReactNode;
  if (typeof value === 'number') {
    control = (
      <NumberInput
        id={id}
        value={value}
        integer={INTEGER_KEYS.has(name)}
        onChange={(next) => onChange(name, next)}
      />
    );
  } else if (typeof value === 'string' && name === 'reasoning_effort') {
    const options = REASONING_EFFORTS.includes(value)
      ? REASONING_EFFORTS
      : [value, ...REASONING_EFFORTS];
    control = (
      <Select id={id} value={value} onChange={(event) => onChange(name, event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </Select>
    );
  } else if (typeof value === 'string') {
    control = (
      <Input id={id} value={value} onChange={(event) => onChange(name, event.target.value)} />
    );
  } else {
    // 非数值 / 字符串的怪值不编辑，只展示
    control = <p className="py-2 font-mono text-xs text-ink-3">{JSON.stringify(value)}</p>;
  }
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm">{t(`presets.sampling.${name}`)}</span>
        <span className="truncate font-mono text-[11px] text-ink-3">{name}</span>
      </label>
      {control}
    </div>
  );
}

interface PromptItemProps {
  identifier: string;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  enabled: boolean;
  prompt: Json | undefined;
  open: boolean;
  autoFocus: boolean;
  onToggle: (position: number, enabled: boolean) => void;
  onMove: (position: number, delta: -1 | 1) => void;
  onOpen: (identifier: string) => void;
  onPatch: (identifier: string, patch: Json) => void;
  onDelete: (identifier: string) => void;
}

const PromptItem = memo(function PromptItem({
  identifier,
  position,
  isFirst,
  isLast,
  enabled,
  prompt,
  open,
  autoFocus,
  onToggle,
  onMove,
  onOpen,
  onPatch,
  onDelete,
}: PromptItemProps) {
  const { t } = useTranslation();
  const bodyId = useId();
  const marker = prompt?.marker === true;
  const editable = prompt !== undefined && !marker;
  const isOpen = editable && open;
  const name = (typeof prompt?.name === 'string' && prompt.name) || identifier;

  const role = prompt?.role === 'user' || prompt?.role === 'assistant' ? prompt.role : 'system';
  const inChat = prompt?.injection_position === POSITION_IN_CHAT;
  const depth = numberOr(prompt?.injection_depth, DEFAULT_DEPTH);
  const orderValue = numberOr(prompt?.injection_order, DEFAULT_ORDER);

  let meta: string;
  if (prompt === undefined) {
    meta = t('presets.prompt.missing');
  } else if (marker) {
    const what = KNOWN_MARKERS.has(identifier)
      ? t(`presets.markers.${identifier}`)
      : t('presets.markers.other');
    meta = t('presets.prompt.markerMeta', { what });
  } else {
    meta = [
      t(`presets.roles.${role}`),
      inChat
        ? t('presets.prompt.inChatMeta', { depth, order: orderValue })
        : t('presets.positions.relative'),
    ].join(' · ');
  }

  const moveButton = (delta: -1 | 1) => {
    const blocked = delta === -1 ? isFirst : isLast;
    return (
      <IconButton
        label={delta === -1 ? t('presets.prompt.moveUp') : t('presets.prompt.moveDown')}
        aria-disabled={blocked}
        className={cn(blocked && 'opacity-40')}
        onClick={() => {
          if (!blocked) onMove(position, delta);
        }}
      >
        {delta === -1 ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
      </IconButton>
    );
  };

  const heading = (
    <>
      <span
        className={cn(
          'block truncate text-sm',
          enabled ? 'text-ink' : 'text-ink-3',
          marker && 'italic',
        )}
      >
        {name}
      </span>
      <span className="mt-0.5 block truncate text-xs text-ink-3">{meta}</span>
    </>
  );

  return (
    <li
      data-part="preset-prompt-item"
      data-marker={marker}
      data-enabled={enabled}
      data-open={isOpen}
      className="py-2"
    >
      <div className="flex items-center gap-2 px-1">
        <Switch
          checked={enabled}
          onChange={(checked) => onToggle(position, checked)}
          label={t('presets.prompt.toggle', { name })}
        />
        {editable ? (
          <button
            type="button"
            aria-expanded={isOpen}
            aria-controls={bodyId}
            onClick={() => onOpen(identifier)}
            className="focus-ring rounded-control flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-0.5 text-left"
          >
            <ChevronRight
              aria-hidden
              className={cn('motion-transform size-3.5 shrink-0 text-ink-3', isOpen && 'rotate-90')}
            />
            <span className="min-w-0 flex-1">{heading}</span>
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5">
            <span aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{heading}</span>
          </div>
        )}
        <div className="flex shrink-0 items-center">
          {moveButton(-1)}
          {moveButton(1)}
        </div>
      </div>

      {isOpen && (
        <PromptBody
          id={bodyId}
          identifier={identifier}
          prompt={prompt}
          role={role}
          inChat={inChat}
          depth={depth}
          order={orderValue}
          autoFocus={autoFocus}
          onPatch={onPatch}
          onDelete={onDelete}
        />
      )}
    </li>
  );
});

function PromptBody({
  id,
  identifier,
  prompt,
  role,
  inChat,
  depth,
  order,
  autoFocus,
  onPatch,
  onDelete,
}: {
  id: string;
  identifier: string;
  prompt: Json;
  role: (typeof ROLES)[number];
  inChat: boolean;
  depth: number;
  order: number;
  autoFocus: boolean;
  onPatch: (identifier: string, patch: Json) => void;
  onDelete: (identifier: string) => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const patch = (value: Json) => onPatch(identifier, value);

  return (
    <div id={id} className="mt-3 mb-2 space-y-3 ps-12 pe-1 max-sm:ps-1">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <FieldLabel htmlFor={`${ids}-name`}>{t('presets.name')}</FieldLabel>
          <Input
            id={`${ids}-name`}
            size="sm"
            autoFocus={autoFocus}
            value={typeof prompt.name === 'string' ? prompt.name : ''}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </div>
        <div className="min-w-0">
          <FieldLabel htmlFor={`${ids}-role`}>{t('presets.prompt.role')}</FieldLabel>
          <Select
            id={`${ids}-role`}
            size="sm"
            value={role}
            onChange={(event) => patch({ role: event.target.value })}
          >
            {ROLES.map((value) => (
              <option key={value} value={value}>
                {t(`presets.roles.${value}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0">
          <FieldLabel htmlFor={`${ids}-position`}>{t('presets.prompt.position')}</FieldLabel>
          <Select
            id={`${ids}-position`}
            size="sm"
            value={inChat ? 'inChat' : 'relative'}
            onChange={(event) =>
              patch({ injection_position: event.target.value === 'inChat' ? POSITION_IN_CHAT : 0 })
            }
          >
            <option value="relative">{t('presets.positions.relative')}</option>
            <option value="inChat">{t('presets.positions.inChat')}</option>
          </Select>
        </div>
        {inChat && (
          <div className="grid min-w-0 grid-cols-2 gap-3">
            <div className="min-w-0">
              <FieldLabel htmlFor={`${ids}-depth`}>{t('presets.prompt.depth')}</FieldLabel>
              <NumberInput
                id={`${ids}-depth`}
                size="sm"
                integer
                value={depth}
                onChange={(value) => patch({ injection_depth: value })}
              />
            </div>
            <div className="min-w-0">
              <FieldLabel htmlFor={`${ids}-order`}>{t('presets.prompt.order')}</FieldLabel>
              <NumberInput
                id={`${ids}-order`}
                size="sm"
                integer
                value={order}
                onChange={(value) => patch({ injection_order: value })}
              />
            </div>
          </div>
        )}
      </div>

      <div>
        <FieldLabel htmlFor={`${ids}-content`}>{t('presets.prompt.content')}</FieldLabel>
        <Textarea
          id={`${ids}-content`}
          rows={8}
          spellCheck={false}
          value={typeof prompt.content === 'string' ? prompt.content : ''}
          onChange={(event) => patch({ content: event.target.value })}
          className="font-mono text-xs"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-3">{identifier}</span>
        <Button
          variant="ghost"
          size="sm"
          className="text-danger hover:bg-danger-soft hover:text-danger"
          onClick={() => onDelete(identifier)}
        >
          {t('presets.prompt.delete')}
        </Button>
      </div>
    </div>
  );
}
