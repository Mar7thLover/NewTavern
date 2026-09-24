import { Check, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../../components/ui/badge';
import { IconButton } from '../../../components/ui/icon-button';
import { cn } from '../../../lib/utils';
import type { StudioKind } from '../../../lib/api-studio';
import { valueText, type ChangeRow, type FieldChange } from '../draft/changes';
import { collapseEqual, diffStats, diffText } from '../draft/text-diff';
import { diffValue, type ValueDiff } from './value-diff';
import type { AnyStudioDraft } from '../types';
import type { OpDecision } from '../assist/turns';
import { entryFieldLabel, pathLabel } from './labels';

/*
 * 字段级 diff 列表（AI 协作的「本轮改动」与版本页签共用）。
 * 增删色只落在改动的那几个字上（`--success-soft` / `--danger-soft`）；整段新增 / 删除
 * 不铺底色，改用一条细竖线标记，免得大面积上色。
 */

/** 相同部分少于这个比例就当作整段重写：分别列出旧文与新文，不逐字标色 */
const REWRITE_RATIO = 0.2;
/** 整段重写时旧文最多显示多少字 */
const OLD_PREVIEW = 240;

/** 两段文字的字符级 diff（相同部分太少时退成「原文 / 改为」两块） */
function StringDiff({
  before,
  after,
  hasBefore,
  hasAfter,
}: {
  before: string;
  after: string;
  hasBefore: boolean;
  hasAfter: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const oldText = hasBefore ? before : '';
  const newText = hasAfter ? after : '';
  const diff = useMemo(() => diffText(oldText, newText), [oldText, newText]);

  const equalLength = diff.segments
    .filter((segment) => segment.type === 'equal')
    .reduce((sum, segment) => sum + segment.text.length, 0);
  const total = Math.max(oldText.length, newText.length, 1);
  const rewrite = diff.mode === 'replace' || equalLength / total < REWRITE_RATIO;

  if (rewrite) {
    const oldChars = Array.from(oldText);
    const oldShown =
      expanded || oldChars.length <= OLD_PREVIEW
        ? oldText
        : `${oldChars.slice(0, OLD_PREVIEW).join('')}…`;
    return (
      <div data-part="studio-diff" data-mode="rewrite" className="space-y-2">
        {oldText !== '' && (
          <div className="border-s-2 border-danger ps-2.5">
            <div className="mb-0.5 text-[10px] tracking-wide text-danger">
              {t('studio.diff.old')}
            </div>
            <p className="text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-3">
              {oldShown}
            </p>
            {oldChars.length > OLD_PREVIEW && (
              <button
                type="button"
                className="focus-ring rounded-control mt-1 cursor-pointer text-[11px] text-ink-2 hover:text-ink"
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? t('common.collapse') : t('common.expand')}
              </button>
            )}
          </div>
        )}
        {newText !== '' ? (
          <div className="border-s-2 border-success ps-2.5">
            {oldText !== '' && (
              <div className="mb-0.5 text-[10px] tracking-wide text-success">
                {t('studio.diff.new')}
              </div>
            )}
            <p className="text-xs leading-relaxed break-words whitespace-pre-wrap">{newText}</p>
          </div>
        ) : (
          hasAfter && <p className="text-xs text-ink-3">{t('studio.diff.empty')}</p>
        )}
      </div>
    );
  }

  const parts = collapseEqual(diff.segments);
  const stats = diffStats(diff.segments);
  return (
    <div data-part="studio-diff" data-mode={diff.mode}>
      <p className="text-xs leading-relaxed break-words whitespace-pre-wrap">
        {parts.map((part, index) => {
          if (part.type === 'gap') {
            return (
              <span key={index} className="text-[11px] text-ink-3">
                {` ⋯ ${t('studio.diff.gap', { n: part.count })} ⋯ `}
              </span>
            );
          }
          if (part.type === 'add') {
            return (
              <ins
                key={index}
                data-part="studio-diff-add"
                className="rounded-[2px] bg-success-soft text-success no-underline"
              >
                {part.text}
              </ins>
            );
          }
          if (part.type === 'del') {
            return (
              <del
                key={index}
                data-part="studio-diff-del"
                className="rounded-[2px] bg-danger-soft text-danger decoration-1"
              >
                {part.text}
              </del>
            );
          }
          return <span key={index}>{part.text}</span>;
        })}
      </p>
      <p className="mt-1 text-[10px] text-ink-3 tabular-nums">
        +{stats.added} −{stats.removed}
      </p>
    </div>
  );
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** CCv3 内嵌世界书（`{ entries: [...] }`）：整本写入时按条目列摘要，原始 JSON 折叠起来 */
function isBookValue(value: unknown): value is { entries: unknown[] } {
  return isRecord(value) && Array.isArray(value.entries);
}

function BookSummary({ row }: { row: Extract<ChangeRow, { type: 'field' }> }) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(false);
  const entries = (row.after as { entries: unknown[] }).entries.filter(isRecord);
  return (
    <div data-part="studio-diff" data-mode="book" className="space-y-1.5">
      <ul className="border-s-2 border-success ps-2.5 space-y-1.5">
        {entries.map((entry, index) => {
          const keys = Array.isArray(entry.keys)
            ? entry.keys.filter((k) => typeof k === 'string')
            : [];
          const title =
            (typeof entry.comment === 'string' && entry.comment.trim()) ||
            (typeof entry.name === 'string' && entry.name.trim()) ||
            keys[0] ||
            t('studio.diff.untitledEntry');
          const content = typeof entry.content === 'string' ? entry.content : '';
          return (
            <li key={index} className="text-xs leading-relaxed">
              <span className="font-medium">{title}</span>
              {keys.length > 0 && (
                <span className="ms-1.5 text-[11px] text-ink-3">{keys.join('、')}</span>
              )}
              <p className="line-clamp-2 break-words text-ink-2">{content}</p>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="focus-ring rounded-control cursor-pointer text-[11px] text-ink-3 hover:text-ink"
        onClick={() => setRaw((value) => !value)}
      >
        {raw ? t('studio.diff.hideJson') : t('studio.diff.showJson')}
      </button>
      {raw && <RawJson value={row.after} />}
    </div>
  );
}

/**
 * 任意值的差异：文字逐字比；数组按条目（新增整条增色、删掉整条删色、改动的条目内部再比）；
 * 对象按「字段名：值」列出变了的字段。不直接吐 JSON（嵌套复杂的对象另给可展开的原始 JSON）。
 */
export function TextDiff({
  before,
  after,
  hasBefore,
  hasAfter,
}: {
  before: unknown;
  after: unknown;
  hasBefore: boolean;
  hasAfter: boolean;
}) {
  const diff = useMemo(
    () => diffValue(before, after, hasBefore, hasAfter),
    [before, after, hasBefore, hasAfter],
  );
  return <ValueDiffView diff={diff} before={before} after={after} />;
}

function ValueDiffView({
  diff,
  before,
  after,
}: {
  diff: ValueDiff;
  /** 原始值（复杂对象的「原始 JSON」用） */
  before?: unknown;
  after?: unknown;
}) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(false);
  if (diff.kind === 'text') {
    return (
      <StringDiff
        before={diff.before}
        after={diff.after}
        hasBefore={diff.hasBefore}
        hasAfter={diff.hasAfter}
      />
    );
  }
  if (diff.kind === 'list') {
    if (diff.items.length === 0) {
      return <p className="text-xs text-ink-3">{t('studio.diff.empty')}</p>;
    }
    return diff.short ? <ShortListDiff diff={diff} /> : <LongListDiff diff={diff} />;
  }
  return (
    <div data-part="studio-diff" data-mode="fields" className="space-y-2">
      <dl className="space-y-2">
        {diff.rows.map((row) => (
          <div key={row.key} className="grid gap-0.5">
            <dt className="flex items-center gap-1.5 text-[11px] text-ink-2">
              <span className="font-mono">{row.key}</span>
              {row.status !== 'change' && (
                <span className={row.status === 'add' ? 'text-success' : 'text-danger'}>
                  {t(`studio.diff.item.${row.status}`)}
                </span>
              )}
            </dt>
            <dd className="min-w-0">
              <ValueDiffView diff={row.diff} />
            </dd>
          </div>
        ))}
      </dl>
      {diff.unchanged > 0 && (
        <p className="text-[11px] text-ink-3">
          {t('studio.diff.fieldsSame', { n: diff.unchanged })}
        </p>
      )}
      {diff.complex && (before !== undefined || after !== undefined) && (
        <>
          <button
            type="button"
            className="focus-ring rounded-control cursor-pointer text-[11px] text-ink-3 hover:text-ink"
            onClick={() => setRaw((value) => !value)}
          >
            {raw ? t('studio.diff.hideJson') : t('studio.diff.showJson')}
          </button>
          {raw && <RawJson value={after !== undefined ? after : before} />}
        </>
      )}
    </div>
  );
}

function RawJson({ value }: { value: unknown }) {
  return (
    <pre className="edge-rule rounded-control max-h-60 overflow-auto border p-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
      {valueText(value)}
    </pre>
  );
}

/** 条目本身（整条新增 / 删除时）：文字直接显示，结构再往下列 */
function WholeValue({ diff }: { diff: ValueDiff }) {
  if (diff.kind === 'text') {
    const text = diff.hasAfter ? diff.after : diff.before;
    return <p className="text-xs leading-relaxed break-words whitespace-pre-wrap">{text}</p>;
  }
  return <ValueDiffView diff={diff} />;
}

/** 短列表（标签、关键词）：排成一行小块 */
function ShortListDiff({ diff }: { diff: Extract<ValueDiff, { kind: 'list' }> }) {
  const { t } = useTranslation();
  const chip = 'rounded-[2px] px-1.5 py-0.5 text-xs';
  const text = (value: ValueDiff, side: 'before' | 'after') =>
    value.kind === 'text' ? value[side] : '';
  return (
    <div data-part="studio-diff" data-mode="list" className="flex flex-wrap items-center gap-1">
      {diff.items.map((item, index) => {
        if (item.status === 'same') {
          return (
            <span key={index} className="text-[11px] text-ink-3">
              {t('studio.diff.itemsSame', { n: item.count })}
            </span>
          );
        }
        return (
          <span key={index} className="inline-flex gap-1">
            {item.status !== 'add' && (
              <del
                data-part="studio-diff-del"
                className={cn(chip, 'bg-danger-soft text-danger decoration-1')}
              >
                {text(item.diff, 'before')}
              </del>
            )}
            {item.status !== 'del' && (
              <ins
                data-part="studio-diff-add"
                className={cn(chip, 'bg-success-soft text-success no-underline')}
              >
                {text(item.diff, 'after')}
              </ins>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** 长列表（备用开场白等）：逐条，新增 / 删除整条上色，改动的条目内部再比 */
function LongListDiff({ diff }: { diff: Extract<ValueDiff, { kind: 'list' }> }) {
  const { t } = useTranslation();
  return (
    <ol data-part="studio-diff" data-mode="list" className="space-y-2">
      {diff.items.map((item, index) => {
        if (item.status === 'same') {
          return (
            <li key={index} className="text-[11px] text-ink-3">
              {t('studio.diff.itemsSame', { n: item.count })}
            </li>
          );
        }
        const label = (
          <div
            className={cn(
              'mb-1 text-[10px] tracking-wide',
              item.status === 'add'
                ? 'text-success'
                : item.status === 'del'
                  ? 'text-danger'
                  : 'text-ink-3',
            )}
          >
            #{item.index + 1} · {t(`studio.diff.item.${item.status}`)}
          </div>
        );
        if (item.status === 'change') {
          return (
            <li key={index}>
              {label}
              <ValueDiffView diff={item.diff} />
            </li>
          );
        }
        return (
          <li
            key={index}
            data-part={item.status === 'add' ? 'studio-diff-add' : 'studio-diff-del'}
            className={cn(
              'rounded-[2px] px-2 py-1.5',
              item.status === 'add' ? 'bg-success-soft' : 'bg-danger-soft text-ink-2',
            )}
          >
            {label}
            <WholeValue diff={item.diff} />
          </li>
        );
      })}
    </ol>
  );
}

function FieldDiff({ change, label }: { change: FieldChange; label: string }) {
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-medium text-ink-2">{label}</div>
      <TextDiff
        before={change.before}
        after={change.after}
        hasBefore={change.hasBefore}
        hasAfter={change.hasAfter}
      />
    </div>
  );
}

export interface ChangeListProps {
  kind: StudioKind;
  rows: readonly ChangeRow[];
  /** 当前草稿（标签里要用预设条目的名字） */
  draft?: AnyStudioDraft;
  /** 逐条决定（AI 补丁）；不给则只读（版本对比） */
  decisions?: readonly OpDecision[];
  onAccept?: (index: number) => void;
  onReject?: (index: number) => void;
  disabled?: boolean;
}

export function ChangeList({
  kind,
  rows,
  draft,
  decisions,
  onAccept,
  onReject,
  disabled,
}: ChangeListProps) {
  const { t } = useTranslation();
  return (
    <ol className="divide-y divide-edge">
      {rows.map((row, index) => {
        const decision = decisions?.[index];
        let title: ReactNode;
        if (row.type === 'field') {
          title = <span className="min-w-0 truncate">{pathLabel(t, kind, row.path, draft)}</span>;
        } else {
          title = (
            <span className="flex min-w-0 items-center gap-1.5">
              <Badge variant={row.action === 'delete' ? 'outline' : 'muted'}>
                {t(`studio.diff.entry.${row.action}`)}
              </Badge>
              <span className="min-w-0 truncate">
                {row.title || t('studio.diff.untitledEntry')}
              </span>
              {row.uid !== null && (
                <span className="shrink-0 text-[10px] text-ink-3 tabular-nums">#{row.uid}</span>
              )}
            </span>
          );
        }
        return (
          <li
            key={row.key}
            data-decision={decision}
            className={cn('py-3', decision === 'rejected' && 'opacity-50')}
          >
            <div className="mb-2 flex items-center gap-2 text-xs font-medium">
              <div className="flex min-w-0 flex-1 items-center">{title}</div>
              {decision === 'accepted' && (
                <span className="shrink-0 text-[11px] text-success">
                  {t('studio.assist.accepted')}
                </span>
              )}
              {decision === 'rejected' && (
                <span className="shrink-0 text-[11px] text-ink-3">
                  {t('studio.assist.rejected')}
                </span>
              )}
              {decision === 'pending' && onAccept && onReject && (
                <span className="flex shrink-0 gap-1">
                  <IconButton
                    label={t('studio.assist.reject')}
                    variant="outline"
                    size="xs"
                    disabled={disabled}
                    onClick={() => onReject(index)}
                  >
                    <X aria-hidden />
                  </IconButton>
                  <IconButton
                    label={t('studio.assist.accept')}
                    variant="outline"
                    size="xs"
                    disabled={disabled}
                    onClick={() => onAccept(index)}
                  >
                    <Check aria-hidden />
                  </IconButton>
                </span>
              )}
            </div>
            {row.type === 'field' && isBookValue(row.after) ? (
              <BookSummary row={row} />
            ) : row.type === 'field' ? (
              <TextDiff
                before={row.before}
                after={row.after}
                hasBefore={row.hasBefore}
                hasAfter={row.hasAfter}
              />
            ) : row.fields.length === 0 ? (
              <p className="text-xs text-ink-3">{t('studio.diff.noFields')}</p>
            ) : (
              <div className="space-y-2.5">
                {row.fields.map((change) => (
                  <FieldDiff
                    key={change.field}
                    change={change}
                    label={entryFieldLabel(t, change.field)}
                  />
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
