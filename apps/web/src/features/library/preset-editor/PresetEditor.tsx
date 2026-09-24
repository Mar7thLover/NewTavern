import { ArrowDown, ArrowUp, ChevronRight, GripVertical, Lock, LockOpen, Plus } from 'lucide-react';
import {
  memo,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Button } from '../../../components/ui/button';
import { FieldLabel, Input, Select, Textarea } from '../../../components/ui/field';
import { IconButton } from '../../../components/ui/icon-button';
import { Switch } from '../../../components/ui/switch';
import { cn } from '../../../lib/utils';
import { LibraryHeader, errorMessage } from '../shared';
import {
  DEFAULT_DEPTH,
  DEFAULT_ORDER,
  activeOrderIndex,
  addPrompt,
  deletePromptFromDraft,
  isPresetDraftDirty,
  isPresetDraftValid,
  lockedIdentifiers,
  moveOrderEntry,
  newIdentifier,
  patchPrompt,
  readOrder,
  readPrompts,
  setField,
  setLayoutMode,
  setOrderEnabled,
  setPromptLocked,
  type PresetDraft,
  type PresetLayoutMode,
  type PresetPrompt,
} from './model';
import { EditorSaveBar, useDraftUpdater } from './shared';

/*
 * 预设编辑器（受控）：`/presets/:id` 页面与工作台 / 写作页共用。
 *
 * 草稿由调用方持有（value / onChange / baseline），组件只管界面状态（展开、拖拽、确认框）。
 * 布局用容器查询（`@container`），放进 360px 的侧栏也不横向溢出。
 */

export interface PresetEditorProps {
  /** 当前草稿 */
  value: PresetDraft;
  onChange: (next: PresetDraft) => void;
  /** 上次保存的状态：据此判断「有未保存的修改」，「放弃修改」= onChange(baseline) */
  baseline: PresetDraft;
  onSave: () => void;
  saving: boolean;
  /** 嵌入工作台 / 写作页的窄栏：不渲染页面大标题，间距收紧 */
  embedded?: boolean;
  /** 上次保存的错误（有则保存条显示出错信息） */
  saveError?: unknown;
  /** 刚保存成功（保存条显示「已保存」） */
  saved?: boolean;
  /** 不渲染底部保存条（工作台用页头统一的保存 / 还原；页面与写作页不传） */
  hideSaveBar?: boolean;
  /** 标题下方的附注（如「内置」徽标）；embedded 时不显示 */
  badges?: ReactNode;
  /** 「基本」分区右上角的额外操作（如「恢复内置内容」） */
  basicActions?: ReactNode;
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

const LAYOUT_MODES = ['follow', 'strict', 'cache-aware'] as const;
type LayoutModeOption = (typeof LAYOUT_MODES)[number];
const LAYOUT_MODE_KEY: Record<LayoutModeOption, string> = {
  follow: 'follow',
  strict: 'strict',
  'cache-aware': 'cacheAware',
};

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

type DragMark = 'source' | 'before' | 'after' | null;
const DRAG_TYPE = 'application/x-newtavern-preset-prompt';

/* ------------------------------------------------------------------ */

export function PresetEditor({
  value,
  onChange,
  baseline,
  onSave,
  saving,
  embedded = false,
  saveError,
  saved = false,
  hideSaveBar = false,
  badges,
  basicActions,
}: PresetEditorProps) {
  const { t } = useTranslation();
  const update = useDraftUpdater(value, onChange);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const dragFromRef = useRef<number | null>(null);

  const draft = value.data;
  const dirty = useMemo(() => isPresetDraftDirty(baseline, value), [baseline, value]);
  const nameValid = isPresetDraftValid(value);

  const orderIndex = activeOrderIndex(draft);
  const order = readOrder(draft, orderIndex);
  const prompts = readPrompts(draft);
  const promptById = useMemo(() => {
    const map = new Map<string, PresetPrompt>();
    for (const prompt of prompts) {
      if (typeof prompt.identifier === 'string') map.set(prompt.identifier, prompt);
    }
    return map;
  }, [prompts]);
  const locked = useMemo(() => lockedIdentifiers(value.layoutPolicy), [value.layoutPolicy]);
  const layoutMode: LayoutModeOption = value.layoutPolicy?.mode ?? 'follow';

  /* ---------- 草稿修改（全部经 update(fn)，回调引用稳定） ---------- */

  const updateData = useCallback(
    (fn: (data: PresetDraft['data']) => PresetDraft['data']) =>
      update((current) => {
        const data = fn(current.data);
        return data === current.data ? current : { ...current, data };
      }),
    [update],
  );

  const onSamplingChange = useCallback(
    (key: string, next: unknown) => updateData((data) => setField(data, key, next)),
    [updateData],
  );

  const toggleEntry = useCallback(
    (position: number, enabled: boolean) =>
      updateData((data) => setOrderEnabled(data, position, enabled)),
    [updateData],
  );

  const moveEntry = useCallback(
    (from: number, to: number) => updateData((data) => moveOrderEntry(data, from, to)),
    [updateData],
  );

  const onPatch = useCallback(
    (identifier: string, patch: PresetPrompt) =>
      updateData((data) => patchPrompt(data, identifier, patch)),
    [updateData],
  );

  const toggleLock = useCallback(
    (identifier: string, next: boolean) =>
      update((current) => ({
        ...current,
        layoutPolicy: setPromptLocked(current.layoutPolicy, identifier, next),
      })),
    [update],
  );

  const toggleOpen = useCallback((identifier: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(identifier)) next.delete(identifier);
      else next.add(identifier);
      return next;
    });
  }, []);

  const onAddPrompt = () => {
    const identifier = newIdentifier(new Set(promptById.keys()));
    updateData((data) => addPrompt(data, identifier, t('presets.newPromptName')));
    setExpanded((current) => new Set(current).add(identifier));
    setJustAdded(identifier);
  };

  const discard = () => {
    onChange(baseline);
    setJustAdded(null);
  };

  /* ---------- 拖拽排序：与脚本库同一方案（原生 HTML5 拖放 + 把手） ---------- */

  const endDrag = useCallback(() => {
    dragFromRef.current = null;
    setDragFrom(null);
    setDragOver(null);
  }, []);

  const onDragStart = useCallback(
    (position: number, identifier: string, event: DragEvent<HTMLElement>) => {
      dragFromRef.current = position;
      setDragFrom(position);
      event.dataTransfer.effectAllowed = 'move';
      // 自定义类型：拖到别处的输入框里不会被当成文字插进去
      event.dataTransfer.setData(DRAG_TYPE, identifier);
      // 把手很小：拖影用整行
      const row = event.currentTarget.closest('li');
      if (row) event.dataTransfer.setDragImage(row, 16, 16);
    },
    [],
  );

  const onDragOverItem = useCallback((position: number, event: DragEvent<HTMLElement>) => {
    if (dragFromRef.current === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOver(position);
  }, []);

  const onDropItem = useCallback(
    (position: number, event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const from = dragFromRef.current;
      if (from !== null && from !== position) moveEntry(from, position);
      endDrag();
    },
    [moveEntry, endDrag],
  );

  const dragMark = (position: number): DragMark => {
    if (dragFrom === null) return null;
    if (position === dragFrom) return 'source';
    if (position !== dragOver) return null;
    return dragFrom < position ? 'after' : 'before';
  };

  const nameId = useId();
  const layoutId = useId();
  const samplingKeys = SAMPLING_KEYS.filter((key) => draft[key] !== undefined);
  const deleteTarget = pendingDelete ? promptById.get(pendingDelete) : undefined;
  const lockedCount = order.filter(
    (entry) => typeof entry.identifier === 'string' && locked.has(entry.identifier),
  ).length;

  return (
    <div data-part="preset-editor" data-embedded={embedded} className="@container min-w-0">
      {!embedded && (
        <LibraryHeader
          title={value.name.trim() || baseline.name}
          subtitle={
            <span className="inline-flex flex-wrap items-center gap-2">
              {t('presets.promptCount', { total: order.length })}
              {badges}
            </span>
          }
        />
      )}

      <div className={embedded ? 'space-y-8' : 'space-y-10'}>
        <PresetSection section="basic" title={t('presets.sections.basic')} actions={basicActions}>
          <div className="max-w-md">
            <FieldLabel htmlFor={nameId}>{t('presets.name')}</FieldLabel>
            <Input
              id={nameId}
              value={value.name}
              aria-invalid={!nameValid}
              onChange={(event) => {
                const name = event.target.value;
                update((current) => ({ ...current, name }));
              }}
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
            <div className="grid gap-x-4 gap-y-3 @md:grid-cols-2 @3xl:grid-cols-3">
              {samplingKeys.map((key) => (
                <SamplingField
                  key={key}
                  name={key}
                  value={draft[key]}
                  onChange={onSamplingChange}
                />
              ))}
            </div>
          )}
        </PresetSection>

        <PresetSection
          section="layout"
          title={t('presets.sections.layout')}
          hint={t('presets.layout.hint')}
        >
          <div className="grid gap-x-4 gap-y-2 @lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] @lg:items-start">
            <div className="min-w-0">
              <FieldLabel htmlFor={layoutId}>{t('presets.layout.mode')}</FieldLabel>
              <Select
                id={layoutId}
                value={layoutMode}
                onChange={(event) => {
                  const mode = event.target.value as LayoutModeOption;
                  update((current) => ({
                    ...current,
                    layoutPolicy: setLayoutMode(
                      current.layoutPolicy,
                      mode === 'follow' ? null : (mode as PresetLayoutMode),
                    ),
                  }));
                }}
              >
                {LAYOUT_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`presets.layout.modes.${LAYOUT_MODE_KEY[mode]}`)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="min-w-0 space-y-1 text-xs leading-relaxed text-ink-2 @lg:pt-6">
              <p>{t(`presets.layout.modeHints.${LAYOUT_MODE_KEY[layoutMode]}`)}</p>
              <p className="text-ink-3">
                <Lock aria-hidden className="me-1 inline size-3 align-[-1px]" />
                {lockedCount > 0
                  ? t('presets.layout.lockedCount', { count: lockedCount })
                  : t('presets.layout.lockedNone')}
                {layoutMode === 'strict' && ` · ${t('presets.layout.strictLockNote')}`}
              </p>
            </div>
          </div>
        </PresetSection>

        <PresetSection
          section="prompts"
          title={t('presets.sections.prompts')}
          hint={orderIndex >= 0 ? t('presets.promptsHint') : t('presets.noOrder')}
          actions={
            <Button variant="outline" size="sm" onClick={onAddPrompt} disabled={orderIndex < 0}>
              <Plus aria-hidden className="size-3.5" />
              {t('presets.addPrompt')}
            </Button>
          }
        >
          {order.length > 0 && (
            <ol data-part="preset-prompt-list" className="edge-rule divide-y divide-edge border-y">
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
                    locked={identifier !== '' && locked.has(identifier)}
                    prompt={promptById.get(identifier)}
                    open={expanded.has(identifier)}
                    autoFocus={justAdded === identifier}
                    drag={dragMark(position)}
                    onToggle={toggleEntry}
                    onMove={moveEntry}
                    onLock={toggleLock}
                    onOpen={toggleOpen}
                    onPatch={onPatch}
                    onDelete={setPendingDelete}
                    onDragStart={onDragStart}
                    onDragOver={onDragOverItem}
                    onDrop={onDropItem}
                    onDragEnd={endDrag}
                  />
                );
              })}
            </ol>
          )}
        </PresetSection>
      </div>

      {!hideSaveBar && (
        <EditorSaveBar
          part="preset-save-bar"
          dirty={dirty}
          saving={saving}
          canSave={nameValid}
          embedded={embedded}
          error={Boolean(saveError)}
          status={
            saveError
              ? t('presets.saveFailed', { message: errorMessage(saveError) })
              : dirty
                ? t('presets.dirty')
                : saved
                  ? t('presets.saved')
                  : t('presets.clean')
          }
          discardLabel={t('presets.discard')}
          saveLabel={saving ? t('presets.saving') : t('common.save')}
          onDiscard={discard}
          onSave={onSave}
        />
      )}

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
          const identifier = pendingDelete;
          if (identifier) update((current) => deletePromptFromDraft(current, identifier));
          setPendingDelete(null);
        }}
      />
    </div>
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
  section: 'basic' | 'sampling' | 'layout' | 'prompts';
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section data-part="preset-section" data-section={section} className="min-w-0 space-y-3">
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

/**
 * 数值输入：本地保留原始文本，能解析成有限数时才写回草稿。
 * 外部改了值（放弃修改、AI 协作接受改动、恢复版本）时文本跟着同步。
 */
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
  const [synced, setSynced] = useState(value);
  if (!Object.is(value, synced)) {
    setSynced(value);
    const current = text.trim() === '' ? Number.NaN : Number(text);
    if (!Object.is(current, value)) setText(String(value));
  }
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
        if (Number.isFinite(number) && (!integer || Number.isInteger(number))) {
          setSynced(number);
          onChange(number);
        }
      }}
    />
  );
}

const SamplingField = memo(function SamplingField({
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
    control = (
      <p className="py-2 font-mono text-xs break-all text-ink-3">{JSON.stringify(value)}</p>
    );
  }
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-sm">{t(`presets.sampling.${name}`)}</span>
        <span className="truncate font-mono text-[11px] text-ink-3">{name}</span>
      </label>
      {control}
    </div>
  );
});

interface PromptItemProps {
  identifier: string;
  position: number;
  isFirst: boolean;
  isLast: boolean;
  enabled: boolean;
  locked: boolean;
  prompt: PresetPrompt | undefined;
  open: boolean;
  autoFocus: boolean;
  drag: DragMark;
  onToggle: (position: number, enabled: boolean) => void;
  onMove: (from: number, to: number) => void;
  onLock: (identifier: string, locked: boolean) => void;
  onOpen: (identifier: string) => void;
  onPatch: (identifier: string, patch: PresetPrompt) => void;
  onDelete: (identifier: string) => void;
  onDragStart: (position: number, identifier: string, event: DragEvent<HTMLElement>) => void;
  onDragOver: (position: number, event: DragEvent<HTMLElement>) => void;
  onDrop: (position: number, event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

const PromptItem = memo(function PromptItem({
  identifier,
  position,
  isFirst,
  isLast,
  enabled,
  locked,
  prompt,
  open,
  autoFocus,
  drag,
  onToggle,
  onMove,
  onLock,
  onOpen,
  onPatch,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
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
          if (!blocked) onMove(position, position + delta);
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
          enabled ? (marker ? 'text-ink-2' : 'text-ink') : 'text-ink-3',
        )}
      >
        {name}
      </span>
      <span className="mt-0.5 block truncate text-xs text-ink-3">{meta}</span>
    </>
  );

  const lockLabel = locked
    ? t('presets.prompt.unlock', { name })
    : t('presets.prompt.lock', { name });

  return (
    <li
      data-part="preset-prompt-item"
      data-marker={marker}
      data-enabled={enabled}
      data-open={isOpen}
      data-locked={locked}
      data-drag={drag ?? undefined}
      onDragOver={(event) => onDragOver(position, event)}
      onDrop={(event) => onDrop(position, event)}
      className={cn('relative py-2', drag === 'source' && 'opacity-40')}
    >
      {(drag === 'before' || drag === 'after') && (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 h-0.5 bg-accent',
            drag === 'before' ? '-top-px' : '-bottom-px',
          )}
        />
      )}
      <div className="flex items-center gap-1.5 px-1">
        {/* 把手只给指针用；键盘与触屏走右侧的上移 / 下移 */}
        <span
          draggable
          title={t('presets.prompt.dragHandle')}
          aria-hidden
          data-part="preset-prompt-handle"
          onDragStart={(event) => onDragStart(position, identifier, event)}
          onDragEnd={onDragEnd}
          className="-ms-1 flex h-7 w-4 shrink-0 cursor-grab items-center justify-center text-ink-3 hover:text-ink active:cursor-grabbing pointer-coarse:hidden"
        >
          <GripVertical className="size-3.5" />
        </span>
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
            className="focus-ring rounded-control ms-0.5 flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-0.5 text-left"
          >
            <ChevronRight
              aria-hidden
              className={cn('motion-transform size-3.5 shrink-0 text-ink-3', isOpen && 'rotate-90')}
            />
            <span className="min-w-0 flex-1">{heading}</span>
          </button>
        ) : (
          <div className="ms-0.5 flex min-w-0 flex-1 items-center gap-1.5 py-0.5">
            <span aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">{heading}</span>
          </div>
        )}
        <div className="flex shrink-0 items-center">
          {identifier !== '' && (
            <IconButton
              label={lockLabel}
              aria-pressed={locked}
              className={cn(locked ? 'text-accent' : 'text-ink-3')}
              onClick={() => onLock(identifier, !locked)}
            >
              {locked ? <Lock aria-hidden /> : <LockOpen aria-hidden />}
            </IconButton>
          )}
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
  prompt: PresetPrompt;
  role: (typeof ROLES)[number];
  inChat: boolean;
  depth: number;
  order: number;
  autoFocus: boolean;
  onPatch: (identifier: string, patch: PresetPrompt) => void;
  onDelete: (identifier: string) => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const patch = (value: PresetPrompt) => onPatch(identifier, value);

  return (
    <div id={id} className="mt-3 mb-2 space-y-3 ps-1 pe-1 @xl:ps-12">
      <div className="grid gap-3 @md:grid-cols-2">
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
