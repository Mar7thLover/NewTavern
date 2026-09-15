import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { CompareMessage, CompareResult } from './types';
import { useCompareStRequest, type CompareInput } from './useInspect';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Textarea } from '../../components/ui/field';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/utils';
import { errorMessage } from '../library/shared';

export interface CompareViewProps {
  target: Omit<CompareInput, 'stRequest'>;
}

const STEP_KEYS = ['1', '2', '3'] as const;

/**
 * 「与 SillyTavern 对照」：粘贴 ST 实际发出的请求体 JSON → POST /api/inspect/compare →
 * 两侧 messages 数组都拿到手后，完整差异在前端算（服务端只给数据，不改契约）。
 */
export function CompareView({ target }: CompareViewProps) {
  const { t } = useTranslation();
  const compare = useCompareStRequest();
  const [raw, setRaw] = useState('');
  const [parseError, setParseError] = useState<string | null>(null);

  const run = () => {
    setParseError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setParseError(t('inspector.compare.invalidJson'));
      return;
    }
    compare.mutate({ ...target, stRequest: parsed });
  };

  // 端点尚未实现时服务端 404，给一句明确说明而不是干巴巴的错误码
  const notImplemented = compare.error instanceof ApiError && compare.error.status === 404;

  return (
    <div data-part="compare-view" className="space-y-3 p-3">
      <div>
        <h3 className="text-sm font-semibold">{t('inspector.compare.title')}</h3>
        <p className="mt-1 text-xs leading-relaxed text-ink-2">{t('inspector.compare.hint')}</p>
      </div>

      <ol className="list-decimal space-y-1 ps-4 text-[11px] leading-relaxed text-ink-2">
        {STEP_KEYS.map((key) => (
          <li key={key}>{t(`inspector.compare.steps.${key}`)}</li>
        ))}
      </ol>

      <Textarea
        rows={6}
        value={raw}
        spellCheck={false}
        placeholder={t('inspector.compare.placeholder')}
        onChange={(event) => setRaw(event.target.value)}
        className="font-mono text-[11px]"
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={run} disabled={raw.trim() === '' || compare.isPending}>
          {compare.isPending ? t('common.processing') : t('inspector.compare.run')}
        </Button>
        {parseError && <span className="text-xs text-danger">{parseError}</span>}
      </div>

      {compare.error && (
        <p role="alert" className="text-xs text-danger">
          {notImplemented ? t('inspector.compare.unavailable') : errorMessage(compare.error)}
        </p>
      )}

      {compare.data && <CompareResultView result={compare.data} />}
    </div>
  );
}

type CompareDiffKind = 'role' | 'content' | 'both' | 'onlyOurs' | 'onlyTheirs';

interface CompareDiffItem {
  index: number;
  kind: CompareDiffKind;
  ours?: CompareMessage;
  theirs?: CompareMessage;
}

function contentEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** 按下标对齐两侧 messages，逐条给出差异（角色不同 / 内容不同 / 仅一侧存在） */
function computeDiffs(result: CompareResult): CompareDiffItem[] {
  const total = Math.max(result.ours.length, result.theirs.length);
  const diffs: CompareDiffItem[] = [];
  for (let index = 0; index < total; index += 1) {
    const ours = result.ours[index];
    const theirs = result.theirs[index];
    if (ours === undefined) {
      diffs.push({ index, kind: 'onlyTheirs', theirs });
      continue;
    }
    if (theirs === undefined) {
      diffs.push({ index, kind: 'onlyOurs', ours });
      continue;
    }
    const roleDiffers = ours.role !== theirs.role;
    const contentDiffers = !contentEqual(ours.content, theirs.content);
    if (roleDiffers && contentDiffers) diffs.push({ index, kind: 'both', ours, theirs });
    else if (roleDiffers) diffs.push({ index, kind: 'role', ours, theirs });
    else if (contentDiffers) diffs.push({ index, kind: 'content', ours, theirs });
  }
  return diffs;
}

function CompareResultView({ result }: { result: CompareResult }) {
  const { t } = useTranslation();
  const diffs = useMemo(() => computeDiffs(result), [result]);

  return (
    <div className="space-y-2">
      <p className={cn('text-xs font-medium', diffs.length > 0 ? 'text-danger' : 'text-ink-2')}>
        {diffs.length === 0
          ? t('inspector.compare.same')
          : t('inspector.compare.summary', {
              ours: result.ours.length,
              theirs: result.theirs.length,
              diffs: diffs.length,
            })}
      </p>

      {diffs.length > 0 && (
        <div className="space-y-2">
          {diffs.map((item) => (
            <CompareDiffRow key={item.index} item={item} />
          ))}
        </div>
      )}

      {result.hints.length > 0 && (
        <div className="edge-rule border-t px-0.5 py-2">
          <div className="text-[11px] font-medium text-ink-2">{t('inspector.compare.hints')}</div>
          <ul className="mt-1 list-disc space-y-0.5 ps-4 text-xs text-ink-2">
            {result.hints.map((hint, i) => (
              <li key={i}>{hint}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CompareDiffRow({ item }: { item: CompareDiffItem }) {
  const { t } = useTranslation();
  return (
    <div
      data-part="compare-diff"
      data-kind={item.kind}
      className="rounded-card edge-rule border p-2.5"
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{t('inspector.compare.index', { index: item.index })}</Badge>
        <span className="text-[11px] text-ink-2">
          {t(`inspector.compare.diffKind.${item.kind}`)}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <CompareSide title={t('inspector.compare.ours')} message={item.ours} />
        <CompareSide title={t('inspector.compare.theirs')} message={item.theirs} />
      </div>
    </div>
  );
}

function CompareSide({ title, message }: { title: string; message: CompareMessage | undefined }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const content =
    typeof message?.content === 'string'
      ? message.content
      : JSON.stringify(message?.content, null, 2);

  return (
    <div className="rounded-card edge-rule min-w-0 border p-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px] text-ink-2">
        <span className="font-medium">{title}</span>
        {message && <span>{message.role}</span>}
      </div>
      {message ? (
        <>
          <pre
            className={cn(
              'mt-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap',
              !expanded && 'line-clamp-4',
            )}
          >
            {content}
          </pre>
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent"
          >
            <ChevronDown aria-hidden className={cn('size-3', expanded && 'rotate-180')} />
            {expanded ? t('common.collapse') : t('common.expand')}
          </button>
        </>
      ) : (
        <p className="mt-1.5 text-[11px] text-ink-2">{t('inspector.compare.missing')}</p>
      )}
    </div>
  );
}
