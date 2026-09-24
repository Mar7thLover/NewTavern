import { ArrowDown, ArrowUp, ChevronRight, FlaskConical, Plus, Search } from 'lucide-react';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { FieldLabel, Input, Select, Textarea } from '../../../components/ui/field';
import { IconButton } from '../../../components/ui/icon-button';
import { Switch, SwitchRow } from '../../../components/ui/switch';
import { cn } from '../../../lib/utils';
import { EditorSaveBar, useDraftUpdater } from '../preset-editor/shared';
import { LibraryHeader, errorMessage } from '../shared';
import {
  DEFAULT_DEPTH,
  FormField,
  KeywordInput,
  NumberField,
  POSITION_OPTIONS,
  TriSelect,
  positionShort,
} from './fields';
import {
  addLorebookEntry,
  deleteLorebookEntry,
  entryMatches,
  entryTitle,
  isLorebookDraftDirty,
  isLorebookDraftValid,
  moveLorebookEntry,
  newLorebookEntry,
  patchLorebookEntry,
  type LorebookDraft,
  type LorebookEntryDraft,
  type LorebookEntryPatch,
  type LorebookEntryRole,
} from './model';
import { SimulateDrawer } from './SimulateDrawer';

/*
 * 世界书编辑器（受控）：`/lorebooks/:id` 页面与工作台 / 写作页共用。
 *
 * 草稿由调用方持有（value / onChange / baseline），组件只管界面状态（展开、搜索、分批、确认框、模拟抽屉）。
 * 条目多时：折叠行轻量渲染（memo），只有展开的条目挂编辑表单；列表按批渲染。
 * 布局用容器查询（`@container`），放进 360px 的侧栏也不横向溢出。
 */

export interface LorebookEditorProps {
  /** 这本书的 id（触发模拟要用） */
  bookId: string;
  /** 当前草稿 */
  value: LorebookDraft;
  onChange: (next: LorebookDraft) => void;
  /** 上次保存的状态：dirty 判断、增量保存（`lorebookDraftToRequest`）与「放弃修改」都以它为准 */
  baseline: LorebookDraft;
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
}

const AT_DEPTH = 4;
const OUTLET = 7;
/** ST world_info_logic 在下拉里的顺序：AND ANY、AND ALL、NOT ALL、NOT ANY */
const LOGIC_OPTIONS = [0, 3, 1, 2];
const ROLES: LorebookEntryRole[] = ['system', 'user', 'assistant'];
/** 一批渲染的条目数 */
const BATCH = 80;
const MAX = 999_999;

/* ------------------------------------------------------------------ */

export function LorebookEditor({
  bookId,
  value,
  onChange,
  baseline,
  onSave,
  saving,
  embedded = false,
  saveError,
  saved = false,
  hideSaveBar = false,
}: LorebookEditorProps) {
  const { t } = useTranslation();
  const update = useDraftUpdater(value, onChange);
  const baselineRef = useRef(baseline);
  useEffect(() => {
    baselineRef.current = baseline;
  });

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(BATCH);
  const [simulateOpen, setSimulateOpen] = useState(false);
  /** 抽屉第一次打开后才挂载，之后常驻（关掉再开，输入与结果还在） */
  const [simulateMounted, setSimulateMounted] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);

  const drafts = value.entries;
  const nameValid = isLorebookDraftValid(value);
  const dirty = useMemo(() => isLorebookDraftDirty(baseline, value), [baseline, value]);

  /* ---------- 草稿修改（经 update(fn)，回调引用稳定） ---------- */

  const patchEntry = useCallback(
    (key: string, patch: LorebookEntryPatch) =>
      update((current) => patchLorebookEntry(current, baselineRef.current, key, patch)),
    [update],
  );

  const moveEntry = useCallback(
    (key: string, delta: -1 | 1) => update((current) => moveLorebookEntry(current, key, delta)),
    [update],
  );

  const toggleOpen = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const addEntry = () => {
    const entry = newLorebookEntry();
    update((current) => addLorebookEntry(current, entry));
    setExpanded((current) => new Set(current).add(entry.key));
    setFocusKey(entry.key);
    setQuery('');
  };

  const deleteEntry = (key: string) => {
    update((current) => deleteLorebookEntry(current, key));
    setExpanded((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  const discard = () => {
    onChange(baseline);
    setFocusKey(null);
  };

  /** 从模拟结果跳到某条：清掉搜索、展开、确保已渲染、滚到它 */
  const revealEntry = (key: string) => {
    const index = drafts.findIndex((entry) => entry.key === key);
    if (index < 0) return;
    setSimulateOpen(false);
    setQuery('');
    setLimit((current) => Math.max(current, Math.ceil((index + 1) / BATCH) * BATCH));
    setExpanded((current) => new Set(current).add(key));
    requestAnimationFrame(() => {
      const item = listRef.current?.querySelector<HTMLElement>(
        `[data-entry-key="${CSS.escape(key)}"]`,
      );
      item?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  };

  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const out: { draft: LorebookEntryDraft; index: number }[] = [];
    drafts.forEach((draft, index) => {
      if (!normalizedQuery || entryMatches(draft, normalizedQuery)) out.push({ draft, index });
    });
    return out;
  }, [drafts, normalizedQuery]);
  const shown = visible.slice(0, limit);
  const showMore = useCallback(() => setLimit((current) => current + BATCH), []);

  const nameId = useId();
  const deleteTarget = drafts.find((draft) => draft.key === pendingDelete);

  return (
    <div data-part="lorebook-editor" data-embedded={embedded} className="@container min-w-0">
      {!embedded && (
        <LibraryHeader
          title={value.name.trim() || baseline.name}
          subtitle={t('library.lorebooks.entryCount', { total: drafts.length })}
        />
      )}

      <div className="max-w-md">
        <FieldLabel htmlFor={nameId}>{t('library.lorebooks.name')}</FieldLabel>
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

      <div className={cn('flex flex-wrap items-center gap-2', embedded ? 'mt-6' : 'mt-8')}>
        <div className="relative min-w-0 flex-1 basis-48">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-3"
          />
          <Input
            type="search"
            value={query}
            placeholder={t('library.lorebooks.search')}
            aria-label={t('library.lorebooks.search')}
            className="ps-8"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setSimulateMounted(true);
              setSimulateOpen(true);
            }}
          >
            <FlaskConical aria-hidden className="size-3.5" />
            {t('library.lorebooks.simulate.open')}
          </Button>
          <Button variant="outline" onClick={addEntry}>
            <Plus aria-hidden className="size-3.5" />
            {t('library.lorebooks.addEntry')}
          </Button>
        </div>
      </div>
      {normalizedQuery && (
        <p role="status" className="mt-2 text-xs text-ink-2">
          {t('library.lorebooks.searchCount', { count: visible.length })} ·{' '}
          {t('library.lorebooks.sortDisabled')}
        </p>
      )}

      {drafts.length === 0 ? (
        <p className="mt-4 py-6 text-center text-sm text-ink-2">
          {t('library.lorebooks.noEntries')}
        </p>
      ) : visible.length === 0 ? (
        <p className="mt-4 py-6 text-center text-sm text-ink-2">
          {t('library.lorebooks.noMatches')}
        </p>
      ) : (
        <ol
          ref={listRef}
          data-part="lorebook-entry-list"
          className="edge-rule mt-4 divide-y divide-edge border-y"
        >
          {shown.map(({ draft, index }) => (
            <EntryItem
              key={draft.key}
              draft={draft}
              isFirst={index === 0}
              isLast={index === drafts.length - 1}
              reorderDisabled={normalizedQuery !== ''}
              open={expanded.has(draft.key)}
              autoFocus={focusKey === draft.key}
              onPatch={patchEntry}
              onMove={moveEntry}
              onOpen={toggleOpen}
              onDelete={setPendingDelete}
            />
          ))}
        </ol>
      )}
      {shown.length < visible.length && (
        // key：每加载一批就重建观察器，哨兵仍在视口内时会继续加载
        <LoadMore key={limit} remaining={visible.length - shown.length} onMore={showMore} />
      )}

      {!hideSaveBar && (
        <EditorSaveBar
          part="lorebook-save-bar"
          dirty={dirty}
          saving={saving}
          canSave={nameValid}
          embedded={embedded}
          error={Boolean(saveError)}
          status={
            saveError
              ? t('library.lorebooks.editor.saveFailed', { message: errorMessage(saveError) })
              : dirty
                ? t('library.lorebooks.editor.dirty')
                : saved
                  ? t('library.lorebooks.editor.saved')
                  : t('library.lorebooks.editor.clean')
          }
          discardLabel={t('library.lorebooks.editor.discard')}
          saveLabel={saving ? t('library.lorebooks.editor.saving') : t('common.save')}
          onDiscard={discard}
          onSave={onSave}
        />
      )}

      {simulateMounted && (
        <SimulateDrawer
          open={simulateOpen}
          onClose={() => setSimulateOpen(false)}
          bookId={bookId}
          draft={value}
          baseline={baseline}
          dirty={dirty}
          onReveal={revealEntry}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title={t('library.lorebooks.entry.deleteTitle')}
        description={t('library.lorebooks.entry.deleteMessage', {
          name: deleteTarget ? entryTitle(deleteTarget) || t('library.lorebooks.untitled') : '',
        })}
        confirmLabel={t('common.delete')}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) deleteEntry(pendingDelete);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

function LoadMore({ remaining, onMore }: { remaining: number; onMore: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) onMore();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMore]);
  return (
    <div ref={ref} className="py-4 text-center">
      <Button variant="outline" size="sm" onClick={onMore}>
        {t('library.lorebooks.showMore', { count: remaining })}
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface EntryItemProps {
  draft: LorebookEntryDraft;
  isFirst: boolean;
  isLast: boolean;
  reorderDisabled: boolean;
  open: boolean;
  autoFocus: boolean;
  onPatch: (key: string, patch: LorebookEntryPatch) => void;
  onMove: (key: string, delta: -1 | 1) => void;
  onOpen: (key: string) => void;
  onDelete: (key: string) => void;
}

const EntryItem = memo(function EntryItem({
  draft,
  isFirst,
  isLast,
  reorderDisabled,
  open,
  autoFocus,
  onPatch,
  onMove,
  onOpen,
  onDelete,
}: EntryItemProps) {
  const { t } = useTranslation();
  const bodyId = useId();
  const title = entryTitle(draft);
  const displayTitle = title || t('library.lorebooks.untitled');
  const strategy = draft.constant ? 'constant' : draft.vectorized ? 'vectorized' : 'normal';

  const moveButton = (delta: -1 | 1) => {
    const blocked = reorderDisabled || (delta === -1 ? isFirst : isLast);
    const label = reorderDisabled
      ? t('library.lorebooks.sortDisabled')
      : delta === -1
        ? t('library.lorebooks.entry.moveUp')
        : t('library.lorebooks.entry.moveDown');
    return (
      <IconButton
        label={label}
        aria-disabled={blocked}
        className={cn(blocked && 'opacity-40')}
        onClick={() => {
          if (!blocked) onMove(draft.key, delta);
        }}
      >
        {delta === -1 ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
      </IconButton>
    );
  };

  return (
    <li
      data-part="lorebook-entry"
      data-entry-key={draft.key}
      data-enabled={!draft.disabled}
      data-open={open}
      data-constant={draft.constant}
      className="scroll-mt-4 py-2"
    >
      <div className="flex items-center gap-2 px-1">
        <Switch
          checked={!draft.disabled}
          onChange={(checked) => onPatch(draft.key, { disabled: !checked })}
          label={t('library.lorebooks.entry.toggle', { name: displayTitle })}
        />
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onOpen(draft.key)}
          className="focus-ring rounded-control flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-0.5 text-left"
        >
          <ChevronRight
            aria-hidden
            className={cn('motion-transform size-3.5 shrink-0 text-ink-3', open && 'rotate-90')}
          />
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                'block truncate text-sm',
                draft.disabled || !title ? 'text-ink-3' : 'text-ink',
              )}
            >
              {displayTitle}
            </span>
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
              <Badge variant={draft.constant ? 'default' : 'outline'}>
                {t(`library.lorebooks.strategy.${strategy}`)}
              </Badge>
              <span className="shrink-0 tabular-nums">
                {positionShort(t, draft.position, draft.depth)} ·{' '}
                {t('library.lorebooks.entry.orderMeta', { value: draft.entryOrder })}
              </span>
              <span className="min-w-0 truncate">
                {draft.keys.length > 0
                  ? draft.keys.join(', ')
                  : t('library.lorebooks.entry.noKeys')}
              </span>
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center">
          {moveButton(-1)}
          {moveButton(1)}
        </div>
      </div>

      {open && (
        <EntryBody
          id={bodyId}
          draft={draft}
          autoFocus={autoFocus}
          onPatch={onPatch}
          onDelete={onDelete}
        />
      )}
    </li>
  );
});

/* ------------------------------------------------------------------ */

function EntryBody({
  id,
  draft,
  autoFocus,
  onPatch,
  onDelete,
}: {
  id: string;
  draft: LorebookEntryDraft;
  autoFocus: boolean;
  onPatch: (key: string, patch: LorebookEntryPatch) => void;
  onDelete: (key: string) => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const patch = (value: LorebookEntryPatch) => onPatch(draft.key, value);
  const L = (key: string) => t(`library.lorebooks.entry.${key}`);
  const A = (key: string) => t(`library.lorebooks.advanced.${key}`);
  const strategy = draft.constant ? 'constant' : draft.vectorized ? 'vectorized' : 'normal';
  const delayUntilRecursionOn =
    draft.delayUntilRecursion === true || typeof draft.delayUntilRecursion === 'number';

  return (
    <div id={id} className="mt-3 mb-2 space-y-4 ps-1 pe-1 @xl:ps-12">
      <FormField label={L('title')} htmlFor={`${ids}-title`}>
        <Input
          id={`${ids}-title`}
          size="sm"
          autoFocus={autoFocus}
          value={draft.comment ?? ''}
          onChange={(event) => patch({ comment: event.target.value })}
        />
      </FormField>

      <div className="grid gap-3 @2xl:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)]">
        <FormField label={L('keys')} htmlFor={`${ids}-keys`}>
          <KeywordInput
            id={`${ids}-keys`}
            value={draft.keys}
            placeholder={L('keysPlaceholder')}
            onChange={(keys) => patch({ keys })}
          />
        </FormField>
        <FormField label={L('logic')} htmlFor={`${ids}-logic`}>
          <Select
            id={`${ids}-logic`}
            size="sm"
            value={String(draft.selectiveLogic ?? 0)}
            onChange={(event) => patch({ selectiveLogic: Number(event.target.value) })}
          >
            {LOGIC_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {t(`library.lorebooks.logic.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label={L('secondaryKeys')} htmlFor={`${ids}-secondary`}>
          <KeywordInput
            id={`${ids}-secondary`}
            value={draft.secondaryKeys}
            placeholder={L('secondaryPlaceholder')}
            onChange={(secondaryKeys) => patch({ secondaryKeys })}
          />
        </FormField>
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <label
            htmlFor={`${ids}-content`}
            className="text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase"
          >
            {L('content')}
          </label>
          <span className="text-[11px] text-ink-3 tabular-nums">
            {t('library.lorebooks.entry.chars', { count: [...draft.content].length })}
          </span>
        </div>
        <Textarea
          id={`${ids}-content`}
          rows={8}
          value={draft.content}
          onChange={(event) => patch({ content: event.target.value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
        <FormField label={L('strategy')} htmlFor={`${ids}-strategy`}>
          <Select
            id={`${ids}-strategy`}
            size="sm"
            value={strategy}
            onChange={(event) => {
              const value = event.target.value;
              patch({ constant: value === 'constant', vectorized: value === 'vectorized' });
            }}
          >
            <option value="constant">{t('library.lorebooks.strategy.constant')}</option>
            <option value="normal">{t('library.lorebooks.strategy.normal')}</option>
            {draft.vectorized && (
              <option value="vectorized">{t('library.lorebooks.strategy.vectorized')}</option>
            )}
          </Select>
        </FormField>
        <FormField label={L('position')} htmlFor={`${ids}-position`}>
          <Select
            id={`${ids}-position`}
            size="sm"
            value={String(draft.position)}
            onChange={(event) => patch({ position: Number(event.target.value) })}
          >
            {!POSITION_OPTIONS.includes(draft.position) && (
              <option value={draft.position}>
                {t('library.lorebooks.unknownPosition', { value: draft.position })}
              </option>
            )}
            {POSITION_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {t(`library.lorebooks.positions.${value}`)}
              </option>
            ))}
          </Select>
        </FormField>
        {draft.position === AT_DEPTH && (
          <>
            <FormField label={L('depth')} htmlFor={`${ids}-depth`}>
              <NumberField
                id={`${ids}-depth`}
                value={draft.depth}
                nullable
                min={0}
                max={9999}
                placeholder={String(DEFAULT_DEPTH)}
                onChange={(depth) => patch({ depth })}
              />
            </FormField>
            <FormField label={L('role')} htmlFor={`${ids}-role`}>
              <Select
                id={`${ids}-role`}
                size="sm"
                value={draft.role ?? 'system'}
                onChange={(event) => patch({ role: event.target.value as LorebookEntryRole })}
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {t(`library.lorebooks.roles.${role}`)}
                  </option>
                ))}
              </Select>
            </FormField>
          </>
        )}
        {draft.position === OUTLET && (
          <FormField label={L('outletName')} htmlFor={`${ids}-outlet`} className="col-span-2">
            <Input
              id={`${ids}-outlet`}
              size="sm"
              value={draft.outletName}
              onChange={(event) => patch({ outletName: event.target.value })}
            />
          </FormField>
        )}
        <FormField label={L('order')} htmlFor={`${ids}-order`}>
          <NumberField
            id={`${ids}-order`}
            value={draft.entryOrder}
            min={0}
            max={MAX}
            onChange={(value) => {
              if (value !== null) patch({ entryOrder: value });
            }}
          />
        </FormField>
        <FormField label={L('probability')} htmlFor={`${ids}-probability`}>
          <div className="flex min-w-0 items-center gap-2">
            <Switch
              checked={draft.useProbability}
              label={L('useProbability')}
              onChange={(useProbability) => patch({ useProbability })}
            />
            <NumberField
              id={`${ids}-probability`}
              value={draft.probability}
              nullable
              min={0}
              max={100}
              placeholder="100"
              disabled={!draft.useProbability}
              onChange={(probability) => patch({ probability })}
            />
          </div>
        </FormField>
      </div>

      <div>
        <button
          type="button"
          aria-expanded={advancedOpen}
          aria-controls={`${ids}-advanced`}
          onClick={() => setAdvancedOpen((value) => !value)}
          className="focus-ring rounded-control inline-flex cursor-pointer items-center gap-1 py-0.5 text-xs text-ink-2 hover:text-ink"
        >
          <ChevronRight
            aria-hidden
            className={cn('motion-transform size-3.5', advancedOpen && 'rotate-90')}
          />
          {L('advanced')}
        </button>

        {advancedOpen && (
          <div id={`${ids}-advanced`} className="mt-3 space-y-4">
            <div className="grid gap-3 @xl:grid-cols-3">
              <FormField label={A('group')} htmlFor={`${ids}-group`} hint={A('groupHint')}>
                <Input
                  id={`${ids}-group`}
                  size="sm"
                  value={draft.group ?? ''}
                  onChange={(event) => patch({ group: event.target.value })}
                />
              </FormField>
              <FormField
                label={A('groupWeight')}
                htmlFor={`${ids}-weight`}
                hint={A('groupWeightHint')}
              >
                <NumberField
                  id={`${ids}-weight`}
                  value={draft.groupWeight}
                  nullable
                  min={1}
                  max={MAX}
                  placeholder="100"
                  onChange={(groupWeight) => patch({ groupWeight })}
                />
              </FormField>
              <FormField
                label={A('automationId')}
                htmlFor={`${ids}-automation`}
                hint={A('automationIdHint')}
              >
                <Input
                  id={`${ids}-automation`}
                  size="sm"
                  value={draft.automationId ?? ''}
                  placeholder={A('none')}
                  onChange={(event) => patch({ automationId: event.target.value })}
                />
              </FormField>
            </div>

            <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4">
              <FormField label={A('scanDepth')} htmlFor={`${ids}-scan`}>
                <NumberField
                  id={`${ids}-scan`}
                  value={draft.scanDepth}
                  nullable
                  min={0}
                  max={1000}
                  placeholder={A('useGlobal')}
                  onChange={(scanDepth) => patch({ scanDepth })}
                />
              </FormField>
              <FormField label={A('caseSensitive')} htmlFor={`${ids}-case`}>
                <TriSelect
                  id={`${ids}-case`}
                  value={draft.caseSensitive}
                  onChange={(caseSensitive) => patch({ caseSensitive })}
                />
              </FormField>
              <FormField label={A('matchWholeWords')} htmlFor={`${ids}-whole`}>
                <TriSelect
                  id={`${ids}-whole`}
                  value={draft.matchWholeWords}
                  onChange={(matchWholeWords) => patch({ matchWholeWords })}
                />
              </FormField>
              <FormField label={A('useGroupScoring')} htmlFor={`${ids}-scoring`}>
                <TriSelect
                  id={`${ids}-scoring`}
                  value={draft.useGroupScoring}
                  onChange={(useGroupScoring) => patch({ useGroupScoring })}
                />
              </FormField>
            </div>

            <div className="grid gap-3 @xl:grid-cols-3">
              {(['sticky', 'cooldown', 'delay'] as const).map((field) => (
                <FormField
                  key={field}
                  label={A(field)}
                  htmlFor={`${ids}-${field}`}
                  hint={A(`${field}Hint`)}
                >
                  <NumberField
                    id={`${ids}-${field}`}
                    value={draft[field]}
                    nullable
                    min={0}
                    max={MAX}
                    placeholder={A(`${field}Placeholder`)}
                    onChange={(value) => patch({ [field]: value })}
                  />
                </FormField>
              ))}
            </div>

            <div className="grid gap-x-6 @xl:grid-cols-2">
              <SwitchRow
                title={A('groupOverride')}
                hint={A('groupOverrideHint')}
                checked={draft.groupOverride === true}
                onChange={(groupOverride) => patch({ groupOverride })}
              />
              <SwitchRow
                title={A('ignoreBudget')}
                hint={A('ignoreBudgetHint')}
                checked={draft.ignoreBudget === true}
                onChange={(ignoreBudget) => patch({ ignoreBudget })}
              />
              <SwitchRow
                title={A('excludeRecursion')}
                hint={A('excludeRecursionHint')}
                checked={draft.excludeRecursion === true}
                onChange={(excludeRecursion) => patch({ excludeRecursion })}
              />
              <SwitchRow
                title={A('preventRecursion')}
                hint={A('preventRecursionHint')}
                checked={draft.preventRecursion === true}
                onChange={(preventRecursion) => patch({ preventRecursion })}
              />
              <div>
                <SwitchRow
                  title={A('delayUntilRecursion')}
                  hint={A('delayUntilRecursionHint')}
                  checked={delayUntilRecursionOn}
                  onChange={(on) => patch({ delayUntilRecursion: on })}
                />
                {delayUntilRecursionOn && (
                  <div className="mt-1 mb-2 flex items-center gap-2">
                    <label htmlFor={`${ids}-level`} className="text-xs text-ink-2">
                      {A('recursionLevel')}
                    </label>
                    <div className="w-24">
                      <NumberField
                        id={`${ids}-level`}
                        value={
                          typeof draft.delayUntilRecursion === 'number'
                            ? draft.delayUntilRecursion
                            : null
                        }
                        nullable
                        min={1}
                        max={MAX}
                        placeholder="1"
                        // ST：等级 1 与 true 等价
                        onChange={(level) =>
                          patch({
                            delayUntilRecursion: level === null || level === 1 ? true : level,
                          })
                        }
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-ink-3">
          {draft.uid === null ? '' : `uid ${draft.uid}`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-danger hover:bg-danger-soft hover:text-danger"
          onClick={() => onDelete(draft.key)}
        >
          {L('delete')}
        </Button>
      </div>
    </div>
  );
}
