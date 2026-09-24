import { useMutation } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Drawer } from '../../../components/ui/drawer';
import { FieldLabel, Textarea } from '../../../components/ui/field';
import { SwitchRow } from '../../../components/ui/switch';
import { cn } from '../../../lib/utils';
import { errorMessage } from '../shared';
import {
  simulateLorebook,
  type LorebookSimulateActivated,
  type LorebookSimulateResult,
  type LorebookSimulateSkipped,
} from './api';
import { positionShort } from './fields';
import { entryTitle, lorebookDraftToEntries, type LorebookDraft } from './model';

/*
 * 触发模拟抽屉（M6 §4.2 / §2.5）：输入一段文字，当作一条用户消息扫描这本书一次，
 * 列出哪些条目会激活、为什么（常驻 / 关键词 / 副关键词 / 递归 / 装饰器 + 命中的词），
 * 以及被跳过的条目与原因。可带当前草稿（含未保存的修改）；不推进时间态、不落库。
 */

interface Snapshot {
  result: LorebookSimulateResult;
  /** 发请求时的条目列表（结果里的 index 指向它） */
  entries: LorebookDraft['entries'];
  /** 发请求时的草稿对象：之后草稿变了就提示结果可能过期 */
  draft: LorebookDraft;
}

export interface SimulateDrawerProps {
  open: boolean;
  onClose: () => void;
  bookId: string;
  draft: LorebookDraft;
  baseline: LorebookDraft;
  dirty: boolean;
  /** 点结果里的条目：在编辑器里展开并滚到它 */
  onReveal: (key: string) => void;
}

export function SimulateDrawer({
  open,
  onClose,
  bookId,
  draft,
  baseline,
  dirty,
  onReveal,
}: SimulateDrawerProps) {
  const { t } = useTranslation();
  const ids = useId();
  const [text, setText] = useState('');
  const [useDraft, setUseDraft] = useState(true);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const simulate = useMutation({
    mutationFn: (input: { text: string; withDraft: boolean }) =>
      simulateLorebook(bookId, {
        text: input.text,
        ...(input.withDraft ? { entries: lorebookDraftToEntries(draft, baseline) } : {}),
      }),
  });

  const withDraft = dirty && useDraft;
  const run = () => {
    if (!text.trim() || simulate.isPending) return;
    const entries = withDraft ? draft.entries : baseline.entries;
    const sent = draft;
    simulate.mutate(
      { text, withDraft },
      { onSuccess: (result) => setSnapshot({ result, entries, draft: sent }) },
    );
  };

  const stale = snapshot !== null && snapshot.draft !== draft;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="right"
      title={t('library.lorebooks.simulate.title')}
      className="sm:w-[28rem] sm:max-w-[calc(100vw-2rem)]"
    >
      <div data-part="lorebook-simulate" className="h-full space-y-5 overflow-y-auto p-4">
        <p className="text-xs leading-relaxed text-ink-2">{t('library.lorebooks.simulate.hint')}</p>

        <div>
          <FieldLabel htmlFor={`${ids}-text`}>{t('library.lorebooks.simulate.input')}</FieldLabel>
          <Textarea
            id={`${ids}-text`}
            rows={5}
            value={text}
            placeholder={t('library.lorebooks.simulate.placeholder')}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                run();
              }
            }}
          />
        </div>

        {dirty && (
          <SwitchRow
            title={t('library.lorebooks.simulate.useDraft')}
            hint={t('library.lorebooks.simulate.useDraftHint')}
            checked={useDraft}
            onChange={setUseDraft}
          />
        )}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-ink-3">{t('library.lorebooks.simulate.shortcut')}</span>
          <Button size="sm" onClick={run} disabled={!text.trim() || simulate.isPending}>
            {simulate.isPending
              ? t('library.lorebooks.simulate.running')
              : t('library.lorebooks.simulate.run')}
          </Button>
        </div>

        {simulate.error && (
          <p role="alert" className="text-xs break-words text-danger">
            {t('library.lorebooks.simulate.failed', { message: errorMessage(simulate.error) })}
          </p>
        )}

        {snapshot && (
          <SimulateResultView
            snapshot={snapshot}
            stale={stale}
            currentKeys={new Set(draft.entries.map((entry) => entry.key))}
            onReveal={onReveal}
          />
        )}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------------------ */

function SimulateResultView({
  snapshot,
  stale,
  currentKeys,
  onReveal,
}: {
  snapshot: Snapshot;
  stale: boolean;
  currentKeys: ReadonlySet<string>;
  onReveal: (key: string) => void;
}) {
  const { t } = useTranslation();
  const { result, entries } = snapshot;
  // 已禁用 / 没命中的通常很多，默认收起；其余被挡下的原因（预算、概率、同组落选…）直接列出
  const skipped = result.skipped.filter(
    (item) => item.reason !== 'no-match' && item.reason !== 'disabled',
  );
  const disabled = result.skipped.filter((item) => item.reason === 'disabled');
  const noMatch = result.skipped.filter((item) => item.reason === 'no-match');

  const titleOf = (item: { index: number; comment?: string | null; uid: number | null }) => {
    const entry = entries[item.index];
    const title = entry ? entryTitle(entry) : item.comment?.trim();
    if (title) return title;
    return item.uid === null ? t('library.lorebooks.untitled') : `uid ${item.uid}`;
  };
  const keyOf = (index: number) => {
    const key = entries[index]?.key;
    return key !== undefined && currentKeys.has(key) ? key : undefined;
  };
  const skippedRows = (items: LorebookSimulateSkipped[]) => (
    <ol className="edge-rule divide-y divide-edge border-y">
      {items.map((item) => (
        <SkippedRow
          key={`${item.index}:${item.uid ?? ''}`}
          item={item}
          title={titleOf(item)}
          revealKey={keyOf(item.index)}
          onReveal={onReveal}
        />
      ))}
    </ol>
  );

  return (
    <div className="space-y-5">
      {stale && (
        <p className="rounded-card bg-warning-soft px-3 py-2 text-xs text-ink-2">
          {t('library.lorebooks.simulate.stale')}
        </p>
      )}

      <section className="space-y-2">
        <h3 role="status" className="text-sm font-semibold">
          {t('library.lorebooks.simulate.activated', { count: result.activated.length })}
        </h3>
        {result.activated.length === 0 ? (
          <p className="text-xs text-ink-3">{t('library.lorebooks.simulate.noneActivated')}</p>
        ) : (
          <ol className="edge-rule divide-y divide-edge border-y">
            {result.activated.map((item) => (
              <ActivatedRow
                key={`${item.index}:${item.uid ?? ''}`}
                item={item}
                title={titleOf(item)}
                revealKey={keyOf(item.index)}
                onReveal={onReveal}
              />
            ))}
          </ol>
        )}
      </section>

      {skipped.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">
            {t('library.lorebooks.simulate.skipped', { count: skipped.length })}
          </h3>
          {skippedRows(skipped)}
        </section>
      )}

      {disabled.length > 0 && (
        <Collapsible
          label={t('library.lorebooks.simulate.disabledGroup', { count: disabled.length })}
        >
          {skippedRows(disabled)}
        </Collapsible>
      )}

      {noMatch.length > 0 && (
        <Collapsible label={t('library.lorebooks.simulate.noMatch', { count: noMatch.length })}>
          {skippedRows(noMatch)}
        </Collapsible>
      )}

      {result.warnings.length > 0 && (
        <section className="space-y-1">
          <h3 className="text-xs font-semibold text-ink-2">
            {t('library.lorebooks.simulate.warnings')}
          </h3>
          <ul className="space-y-0.5 text-xs break-words text-warning">
            {result.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** 默认收起的一组（已禁用 / 没命中） */
function Collapsible({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="focus-ring rounded-control inline-flex cursor-pointer items-center gap-1 py-0.5 text-xs text-ink-2 hover:text-ink"
      >
        <ChevronRight
          aria-hidden
          className={cn('motion-transform size-3.5', open && 'rotate-90')}
        />
        {label}
      </button>
      {open && children}
    </section>
  );
}

/** 一行的外壳：能跳转时是按钮，否则只是文字 */
function RowShell({
  revealKey,
  onReveal,
  label,
  children,
}: {
  revealKey: string | undefined;
  onReveal: (key: string) => void;
  label: string;
  children: ReactNode;
}) {
  if (revealKey === undefined) return <div className="min-w-0 px-1 py-2">{children}</div>;
  return (
    <button
      type="button"
      title={label}
      onClick={() => onReveal(revealKey)}
      className="focus-ring-inset block w-full min-w-0 cursor-pointer px-1 py-2 text-left hover:bg-accent-soft"
    >
      {children}
    </button>
  );
}

function ActivatedRow({
  item,
  title,
  revealKey,
  onReveal,
}: {
  item: LorebookSimulateActivated;
  title: string;
  revealKey: string | undefined;
  onReveal: (key: string) => void;
}) {
  const { t } = useTranslation();
  const S = (key: string, options?: Record<string, unknown>) =>
    t(`library.lorebooks.simulate.${key}`, options ?? {});
  return (
    <li data-part="lorebook-simulate-hit" data-reason={item.reason}>
      <RowShell revealKey={revealKey} onReveal={onReveal} label={S('reveal')}>
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-ink">{title}</span>
          <Badge variant={item.reason === 'constant' ? 'default' : 'outline'}>
            {S(`reasons.${item.reason}`)}
          </Badge>
        </span>
        <span className="mt-1 block text-xs text-ink-3 tabular-nums">
          {positionShort(t, item.position, item.depth)} ·{' '}
          {t('library.lorebooks.entry.orderMeta', { value: item.order })}
          {item.recursionLevel > 0 && ` · ${S('recursionLevel', { level: item.recursionLevel })}`}
        </span>
        {item.matchedKeys.length > 0 && (
          <span className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1">
            <span className="text-[11px] text-ink-3">{S('matched')}</span>
            {item.matchedKeys.map((key, index) => (
              <span
                key={`${index}:${key}`}
                className="chip max-w-full truncate px-2 py-0.5 text-xs"
              >
                {key}
              </span>
            ))}
          </span>
        )}
      </RowShell>
    </li>
  );
}

function SkippedRow({
  item,
  title,
  revealKey,
  onReveal,
}: {
  item: LorebookSimulateSkipped;
  title: string;
  revealKey: string | undefined;
  onReveal: (key: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li data-part="lorebook-simulate-skip" data-reason={item.reason}>
      <RowShell
        revealKey={revealKey}
        onReveal={onReveal}
        label={t('library.lorebooks.simulate.reveal')}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm text-ink-2">{title}</span>
          <span className="shrink-0 text-xs text-ink-3">
            {t(`library.lorebooks.simulate.skip.${item.reason}`, {
              defaultValue: item.reason,
            })}
          </span>
        </span>
      </RowShell>
    </li>
  );
}
