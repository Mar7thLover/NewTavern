import { ArrowDown, ArrowLeft, ArrowUp, ChevronRight, Plus, Search, X } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useBeforeUnload, useBlocker, useParams } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { FieldLabel, Input, Select, Textarea, fieldVariants } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import { Switch, SwitchRow } from '../../components/ui/switch';
import {
  useLorebook,
  useUpdateLorebook,
  type LorebookDetail,
  type LorebookEntry,
  type LorebookEntryInput,
} from '../../lib/api';
import { cn } from '../../lib/utils';
import { LibraryHeader, QueryStatus, errorMessage } from './shared';

/*
 * 世界书编辑器（`/lorebooks/:id`）。
 *
 * 草稿是条目列表（顺序即展示顺序）。保存时整本提交：已有条目只带改动的字段，
 * 新条目只带与 ST 新条目模板不同的字段，删掉的条目不出现在列表里（服务端据此删除）。
 * 没改动的字段不上传，导出因此保持原文件的原样（见 services/lorebook-edit.ts）。
 *
 * 条目多时：折叠行轻量渲染（memo），只有展开的条目挂编辑表单；列表按批渲染。
 */

type Role = 'system' | 'user' | 'assistant';

interface EntryDraft {
  /** 本地 key：已有条目用 id，新条目用 `new:<uuid>` */
  key: string;
  id?: string;
  uid: number | null;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  comment: string | null;
  constant: boolean;
  selective: boolean;
  selectiveLogic: number | null;
  position: number;
  depth: number | null;
  entryOrder: number;
  probability: number | null;
  group: string | null;
  groupOverride: boolean | null;
  groupWeight: number | null;
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  useGroupScoring: boolean | null;
  automationId: string | null;
  role: Role | null;
  disabled: boolean;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  excludeRecursion: boolean | null;
  preventRecursion: boolean | null;
  /** 数字 = ST 递归等级 */
  delayUntilRecursion: boolean | number | null;
  ignoreBudget: boolean | null;
  useProbability: boolean;
  vectorized: boolean;
  outletName: string;
}

type Field = Exclude<keyof EntryDraft, 'key' | 'id' | 'uid'>;
type EntryPatch = Partial<Pick<EntryDraft, Field>>;

/** ST 新条目模板（`newWorldInfoEntryTemplate`）经列派生后的值；新条目只上传与它不同的字段 */
const NEW_ENTRY: Omit<EntryDraft, 'key'> = {
  uid: null,
  keys: [],
  secondaryKeys: [],
  content: '',
  comment: '',
  constant: false,
  selective: true,
  selectiveLogic: 0,
  position: 0,
  depth: 4,
  entryOrder: 100,
  probability: 100,
  group: '',
  groupOverride: false,
  groupWeight: 100,
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: null,
  useGroupScoring: null,
  automationId: '',
  role: 'system',
  disabled: false,
  sticky: null,
  cooldown: null,
  delay: null,
  excludeRecursion: false,
  preventRecursion: false,
  delayUntilRecursion: null,
  ignoreBudget: false,
  useProbability: true,
  vectorized: false,
  outletName: '',
};

const FIELDS = Object.keys(NEW_ENTRY).filter((key) => key !== 'uid') as Field[];

/** 原文件没有该字段（列为 null）时，关掉开关 / 清空文本回到 null，避免凭空写出 false / '' */
const NULL_WHEN_EMPTY = new Set<Field>([
  'comment',
  'group',
  'automationId',
  'groupOverride',
  'excludeRecursion',
  'preventRecursion',
  'delayUntilRecursion',
  'ignoreBudget',
]);

/** ST world_info_position 在条目编辑器下拉里的顺序 */
const POSITION_OPTIONS = [0, 1, 5, 6, 2, 3, 4, 7];
const AT_DEPTH = 4;
const OUTLET = 7;
/** ST world_info_logic 在下拉里的顺序：AND ANY、AND ALL、NOT ALL、NOT ANY */
const LOGIC_OPTIONS = [0, 3, 1, 2];
const ROLES: Role[] = ['system', 'user', 'assistant'];
const DEFAULT_DEPTH = 4;
/** 一批渲染的条目数 */
const BATCH = 80;
const MAX = 999_999;

function fromRow(row: LorebookEntry): EntryDraft {
  const raw = row.extra?.raw ?? {};
  const level = raw.delayUntilRecursion;
  return {
    key: row.id,
    id: row.id,
    uid: row.uid,
    keys: row.keys,
    secondaryKeys: row.secondaryKeys,
    content: row.content,
    comment: row.comment,
    constant: row.constant,
    selective: row.selective,
    selectiveLogic: row.selectiveLogic,
    position: row.position,
    depth: row.depth,
    entryOrder: row.entryOrder,
    probability: row.probability,
    group: row.group,
    groupOverride: row.groupOverride,
    groupWeight: row.groupWeight,
    scanDepth: row.scanDepth,
    caseSensitive: row.caseSensitive,
    matchWholeWords: row.matchWholeWords,
    useGroupScoring: row.useGroupScoring,
    automationId: row.automationId,
    role: row.role,
    disabled: row.disabled,
    sticky: row.sticky,
    cooldown: row.cooldown,
    delay: row.delay,
    excludeRecursion: row.excludeRecursion,
    preventRecursion: row.preventRecursion,
    delayUntilRecursion:
      row.delayUntilRecursion ??
      (typeof level === 'number' && Number.isInteger(level) && level >= 1 ? level : null),
    ignoreBudget: row.ignoreBudget,
    useProbability: typeof raw.useProbability === 'boolean' ? raw.useProbability : true,
    vectorized: raw.vectorized === true,
    outletName: typeof raw.outletName === 'string' ? raw.outletName : '',
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b;
}

function entryChanged(draft: EntryDraft, base: Omit<EntryDraft, 'key'>): boolean {
  return FIELDS.some((field) => !sameValue(draft[field], base[field]));
}

function toInput(draft: EntryDraft, base: Omit<EntryDraft, 'key'> | undefined): LorebookEntryInput {
  const out: Record<string, unknown> = draft.id ? { id: draft.id } : {};
  const reference = base ?? NEW_ENTRY;
  for (const field of FIELDS) {
    if (!sameValue(draft[field], reference[field])) out[field] = draft[field];
  }
  return out as LorebookEntryInput;
}

interface Baseline {
  name: string;
  drafts: EntryDraft[];
  byKey: Map<string, EntryDraft>;
}

function makeBaseline(book: LorebookDetail): Baseline {
  const drafts = book.entries.map(fromRow);
  return { name: book.name, drafts, byKey: new Map(drafts.map((draft) => [draft.key, draft])) };
}

function matches(draft: EntryDraft, query: string): boolean {
  return (
    (draft.comment ?? '').toLowerCase().includes(query) ||
    draft.keys.some((key) => key.toLowerCase().includes(query)) ||
    draft.secondaryKeys.some((key) => key.toLowerCase().includes(query)) ||
    draft.content.toLowerCase().includes(query)
  );
}

/* ------------------------------------------------------------------ */

export function LorebookEditorPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const lorebook = useLorebook(id);

  return (
    <div data-part="lorebook-editor" className="mx-auto max-w-4xl">
      <Link
        to="/lorebooks"
        className="focus-ring rounded-control mb-3 inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        {t('library.lorebooks.back')}
      </Link>
      <QueryStatus
        isPending={lorebook.isPending}
        error={lorebook.error}
        onRetry={() => void lorebook.refetch()}
      />
      {/* key：换了世界书就整体重建草稿 */}
      {lorebook.data && <LorebookEditor key={lorebook.data.id} book={lorebook.data} />}
    </div>
  );
}

function LorebookEditor({ book }: { book: LorebookDetail }) {
  const { t } = useTranslation();
  const update = useUpdateLorebook(book.id);

  const [baseline, setBaseline] = useState(() => makeBaseline(book));
  const [name, setName] = useState(book.name);
  const [drafts, setDrafts] = useState<EntryDraft[]>(baseline.drafts);
  /** 放弃修改时递增，让数值输入框这类带本地文本状态的控件重建 */
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(BATCH);

  const nameValid = name.trim() !== '';
  const dirty = useMemo(() => {
    if (name.trim() !== baseline.name) return true;
    if (drafts.length !== baseline.drafts.length) return true;
    return drafts.some((draft, index) => {
      if (draft.key !== baseline.drafts[index]?.key) return true;
      const base = baseline.byKey.get(draft.key);
      return draft !== base && (!base || entryChanged(draft, base));
    });
  }, [name, drafts, baseline]);

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

  /* ---------- 草稿修改（函数式 setState，回调只随基线变化） ---------- */

  const patchEntry = useCallback(
    (key: string, patch: EntryPatch) => {
      const base = baseline.byKey.get(key);
      const next: Record<string, unknown> = { ...patch };
      for (const [field, value] of Object.entries(next)) {
        if (
          base &&
          NULL_WHEN_EMPTY.has(field as Field) &&
          base[field as Field] === null &&
          (value === false || value === '')
        ) {
          next[field] = null;
        }
      }
      setDrafts((list) => list.map((draft) => (draft.key === key ? { ...draft, ...next } : draft)));
    },
    [baseline],
  );

  const moveEntry = useCallback((key: string, delta: -1 | 1) => {
    setDrafts((list) => {
      const from = list.findIndex((draft) => draft.key === key);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= list.length) return list;
      const next = [...list];
      [next[from], next[to]] = [next[to]!, next[from]!];
      return next;
    });
  }, []);

  const toggleOpen = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const addEntry = () => {
    const key = `new:${crypto.randomUUID()}`;
    setDrafts((list) => [{ ...NEW_ENTRY, key }, ...list]);
    setExpanded((current) => new Set(current).add(key));
    setFocusKey(key);
    setQuery('');
  };

  const deleteEntry = (key: string) => {
    setDrafts((list) => list.filter((draft) => draft.key !== key));
    setExpanded((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  };

  const discard = () => {
    setDrafts(baseline.drafts);
    setName(baseline.name);
    setRevision((value) => value + 1);
    setFocusKey(null);
    update.reset();
  };

  const save = () => {
    const submitted = drafts;
    update.mutate(
      {
        name: name.trim(),
        entries: submitted.map((draft) => toInput(draft, baseline.byKey.get(draft.key))),
      },
      {
        onSuccess: (row) => {
          const next = makeBaseline(row);
          // 返回的条目与提交的顺序一致：新条目按下标换成服务端 id，展开状态跟着走
          if (next.drafts.length === submitted.length) {
            const keyMap = new Map(submitted.map((draft, i) => [draft.key, next.drafts[i]!.key]));
            setExpanded(
              (current) =>
                new Set([...current].flatMap((key) => (keyMap.has(key) ? [keyMap.get(key)!] : []))),
            );
          }
          setBaseline(next);
          setDrafts(next.drafts);
          setName(next.name);
          setFocusKey(null);
        },
      },
    );
  };

  const normalizedQuery = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const out: { draft: EntryDraft; index: number }[] = [];
    drafts.forEach((draft, index) => {
      if (!normalizedQuery || matches(draft, normalizedQuery)) out.push({ draft, index });
    });
    return out;
  }, [drafts, normalizedQuery]);
  const shown = visible.slice(0, limit);
  const showMore = useCallback(() => setLimit((value) => value + BATCH), []);

  const nameId = useId();
  const deleteTarget = drafts.find((draft) => draft.key === pendingDelete);

  return (
    <>
      <LibraryHeader
        title={name.trim() || baseline.name}
        subtitle={t('library.lorebooks.entryCount', { total: drafts.length })}
      />

      <div className="max-w-md">
        <FieldLabel htmlFor={nameId}>{t('library.lorebooks.name')}</FieldLabel>
        <Input
          id={nameId}
          value={name}
          aria-invalid={!nameValid}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
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
        <Button variant="outline" onClick={addEntry}>
          <Plus aria-hidden className="size-3.5" />
          {t('library.lorebooks.addEntry')}
        </Button>
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
          key={revision}
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

      <div
        data-part="lorebook-save-bar"
        data-dirty={dirty}
        className="surface-raised edge-rule rounded-card sticky bottom-3 z-10 mt-10 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border px-4 py-3 md:bottom-5"
      >
        <p
          role={update.error ? 'alert' : 'status'}
          className={cn('me-auto min-w-0 text-xs', update.error ? 'text-danger' : 'text-ink-2')}
        >
          {update.error
            ? t('library.lorebooks.editor.saveFailed', { message: errorMessage(update.error) })
            : dirty
              ? t('library.lorebooks.editor.dirty')
              : update.isSuccess
                ? t('library.lorebooks.editor.saved')
                : t('library.lorebooks.editor.clean')}
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={discard}
            disabled={!dirty || update.isPending}
          >
            {t('library.lorebooks.editor.discard')}
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || !nameValid || update.isPending}>
            {update.isPending ? t('library.lorebooks.editor.saving') : t('common.save')}
          </Button>
        </div>
      </div>

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

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        destructive
        title={t('library.lorebooks.editor.leaveTitle')}
        description={t('library.lorebooks.editor.leaveMessage')}
        confirmLabel={t('library.lorebooks.editor.leave')}
        onCancel={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
      />
    </>
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

/** 标题：comment，空时退到首个关键词 */
function entryTitle(draft: EntryDraft): string {
  return draft.comment?.trim() || draft.keys[0]?.trim() || '';
}

interface EntryItemProps {
  draft: EntryDraft;
  isFirst: boolean;
  isLast: boolean;
  reorderDisabled: boolean;
  open: boolean;
  autoFocus: boolean;
  onPatch: (key: string, patch: EntryPatch) => void;
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
      data-enabled={!draft.disabled}
      data-open={open}
      data-constant={draft.constant}
      className="py-2"
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
                draft.disabled ? 'text-ink-3' : 'text-ink',
                !title && 'italic',
              )}
            >
              {displayTitle}
            </span>
            <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
              <Badge variant={draft.constant ? 'default' : 'outline'}>
                {t(`library.lorebooks.strategy.${strategy}`)}
              </Badge>
              <span className="shrink-0 tabular-nums">
                {positionShort(t, draft)} ·{' '}
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

type T = ReturnType<typeof useTranslation>['t'];

function positionShort(t: T, draft: EntryDraft): string {
  if (!POSITION_OPTIONS.includes(draft.position)) {
    return t('library.lorebooks.unknownPosition', { value: draft.position });
  }
  return t(`library.lorebooks.positionShort.${draft.position}`, {
    depth: draft.depth ?? DEFAULT_DEPTH,
  });
}

/* ------------------------------------------------------------------ */

function EntryBody({
  id,
  draft,
  autoFocus,
  onPatch,
  onDelete,
}: {
  id: string;
  draft: EntryDraft;
  autoFocus: boolean;
  onPatch: (key: string, patch: EntryPatch) => void;
  onDelete: (key: string) => void;
}) {
  const { t } = useTranslation();
  const ids = useId();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const patch = (value: EntryPatch) => onPatch(draft.key, value);
  const L = (key: string) => t(`library.lorebooks.entry.${key}`);
  const A = (key: string) => t(`library.lorebooks.advanced.${key}`);
  const strategy = draft.constant ? 'constant' : draft.vectorized ? 'vectorized' : 'normal';
  const delayUntilRecursionOn =
    draft.delayUntilRecursion === true || typeof draft.delayUntilRecursion === 'number';

  return (
    <div id={id} className="mt-3 mb-2 space-y-4 ps-12 pe-1 max-sm:ps-1">
      <FormField label={L('title')} htmlFor={`${ids}-title`}>
        <Input
          id={`${ids}-title`}
          size="sm"
          autoFocus={autoFocus}
          value={draft.comment ?? ''}
          onChange={(event) => patch({ comment: event.target.value })}
        />
      </FormField>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)]">
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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
                onChange={(event) => patch({ role: event.target.value as Role })}
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
          <div className="flex items-center gap-2">
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
            <div className="grid gap-3 sm:grid-cols-3">
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

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
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

            <div className="grid gap-3 sm:grid-cols-3">
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

            <div className="grid gap-x-6 sm:grid-cols-2">
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

/* ------------------------------------------------------------------ */

function FormField({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{hint}</p>}
    </div>
  );
}

/** 整数输入：本地保留原始文本，合法时才写回草稿；nullable 时清空 = null */
function NumberField({
  id,
  value,
  nullable = false,
  min,
  max,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  value: number | null;
  nullable?: boolean;
  min: number;
  max: number;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const parse = (input: string): { ok: boolean; value: number | null } => {
    if (input.trim() === '') return { ok: nullable, value: null };
    const number = Number(input);
    return Number.isInteger(number) && number >= min && number <= max
      ? { ok: true, value: number }
      : { ok: false, value: null };
  };
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      size="sm"
      step={1}
      min={min}
      max={max}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={!parse(text).ok}
      className="tabular-nums"
      onChange={(event) => {
        setText(event.target.value);
        const result = parse(event.target.value);
        if (result.ok) onChange(result.value);
      }}
    />
  );
}

/** 可空布尔：使用全局 / 是 / 否 */
function TriSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      size="sm"
      value={value === null ? 'null' : String(value)}
      onChange={(event) =>
        onChange(event.target.value === 'null' ? null : event.target.value === 'true')
      }
    >
      <option value="null">{t('library.lorebooks.tri.global')}</option>
      <option value="true">{t('library.lorebooks.tri.yes')}</option>
      <option value="false">{t('library.lorebooks.tri.no')}</option>
    </Select>
  );
}

const SEPARATORS = /[,，\n]/;

/** 关键词标签输入：逗号或回车成词，退格删最后一个；以 `/` 开头的正则不按逗号拆 */
function KeywordInput({
  id,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  value: string[];
  placeholder: string;
  onChange: (value: string[]) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const isRegex = (input: string) => input.trimStart().startsWith('/');

  const add = (parts: string[]) => {
    const words: string[] = [];
    for (const part of parts) {
      const word = part.trim();
      if (word && !value.includes(word) && !words.includes(word)) words.push(word);
    }
    if (words.length > 0) onChange([...value, ...words]);
  };

  const commit = () => {
    if (text.trim()) add(isRegex(text) ? [text] : text.split(SEPARATORS));
    setText('');
  };

  return (
    <div
      className={cn(
        fieldVariants({ size: 'sm' }),
        'flex h-auto min-h-8 flex-wrap items-center gap-1 py-1',
      )}
    >
      {value.map((word, index) => (
        <span
          key={`${index}:${word}`}
          className="chip inline-flex max-w-full min-w-0 items-center gap-0.5 py-0.5 ps-2 pe-0.5 text-xs"
        >
          <span className="min-w-0 truncate">{word}</span>
          <button
            type="button"
            aria-label={t('library.lorebooks.entry.removeKey', { key: word })}
            title={t('library.lorebooks.entry.removeKey', { key: word })}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
            className="focus-ring rounded-control inline-flex size-4 shrink-0 cursor-pointer items-center justify-center text-ink-3 hover:text-ink"
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        placeholder={value.length === 0 ? placeholder : undefined}
        className="min-w-24 flex-1 bg-transparent py-0.5 text-xs outline-none placeholder:text-ink-3"
        onChange={(event) => {
          const next = event.target.value;
          if (!isRegex(next) && SEPARATORS.test(next)) {
            const parts = next.split(SEPARATORS);
            const rest = parts.pop() ?? '';
            add(parts);
            setText(rest);
          } else {
            setText(next);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit();
          } else if (event.key === 'Backspace' && text === '' && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}
