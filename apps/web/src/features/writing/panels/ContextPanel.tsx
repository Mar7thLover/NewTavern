import { useMutation } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../components/ui/button';
import { FieldLabel, Textarea } from '../../../components/ui/field';
import { IconButton } from '../../../components/ui/icon-button';
import {
  inspectWriting,
  useUpdateWritingDocument,
  type WritingAiRequest,
  type WritingContextReport,
  type WritingDocumentSummary,
} from '../../../lib/api-writing';
import { cn } from '../../../lib/utils';
import type { WritingAiController } from '../useWritingAi';

/**
 * 右栏「上下文」页签（M7 §5.2）：按当前光标组装一次（不调用模型），列出各段 token、截断、
 * 过期 / 丢弃的摘要、触发的圣经条目；上面是本章摘要（可看、可改、可重新生成）。
 */
export function ContextPanel({
  projectId,
  doc,
  ai,
  buildRequest,
}: {
  projectId: string;
  /** 当前打开的文档（大纲页为 null） */
  doc: WritingDocumentSummary | null;
  ai: WritingAiController;
  buildRequest: () => WritingAiRequest | null;
}) {
  const { t } = useTranslation();
  const inspect = useMutation({
    mutationFn: (body: WritingAiRequest & { docId: string }) => inspectWriting(projectId, body),
  });

  const docId = doc?.id ?? null;
  const refresh = () => {
    if (!docId) return;
    const request = buildRequest() ?? { action: 'continue' as const };
    inspect.mutate({ ...request, docId });
  };
  // 打开页签 / 换文档时组装一次
  useEffect(() => {
    if (docId) refresh();
  }, [docId]);

  const data = inspect.data;
  return (
    <div data-part="writing-context-panel" className="flex flex-col gap-5 p-4">
      {doc?.kind === 'chapter' && <SummaryEditor doc={doc} ai={ai} />}

      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <FieldLabel>{t('writing.context.title')}</FieldLabel>
          <IconButton
            label={t('common.refresh')}
            size="xs"
            disabled={!docId || inspect.isPending}
            onClick={refresh}
          >
            <RefreshCw aria-hidden className={cn(inspect.isPending && 'pulse-live')} />
          </IconButton>
        </div>
        {!docId ? (
          <p className="text-xs text-ink-3">{t('writing.context.noDocument')}</p>
        ) : inspect.error ? (
          <p role="alert" className="text-xs text-danger">
            {t('common.loadFailed', { message: inspect.error.message })}
          </p>
        ) : !data ? (
          <p className="pulse-live text-xs text-ink-3">{t('common.loading')}</p>
        ) : (
          <>
            {!data.connected && (
              <p className="mb-3 text-[11px] leading-relaxed text-ink-3">
                {t('writing.context.notConnected')}
              </p>
            )}
            <Report report={data.report} />
          </>
        )}
      </section>
    </div>
  );
}

function Report({ report }: { report: WritingContextReport }) {
  const { t } = useTranslation();
  const max = Math.max(1, ...report.segments.map((segment) => segment.tokens));
  return (
    <div className="flex flex-col gap-4 text-xs">
      <p className="text-ink-2 tabular-nums">
        {t('writing.context.total', { total: report.totalTokens, budget: report.budget })}
        {' · '}
        {t(`writing.style.${report.layoutMode === 'strict' ? 'strict' : 'cacheAware'}`)}
      </p>

      <ol data-part="writing-context-segments" className="flex flex-col gap-1.5">
        {report.segments.map((segment) => (
          <li key={segment.id} className="flex min-w-0 items-center gap-2">
            <span className="w-24 shrink-0 truncate text-ink-story">
              {t(`writing.context.segments.${segment.kind}`, { defaultValue: segment.kind })}
            </span>
            <span className="edge-rule relative h-1.5 min-w-0 flex-1 border-b">
              <span
                aria-hidden
                className="absolute inset-y-0 start-0 bg-accent opacity-60"
                style={{ width: `${(segment.tokens / max) * 100}%` }}
              />
            </span>
            <span className="w-12 shrink-0 text-end text-ink-3 tabular-nums">{segment.tokens}</span>
          </li>
        ))}
      </ol>

      {report.chapterTruncation && (
        <p className="text-ink-2">
          {t('writing.context.truncated', { chars: report.chapterTruncation.droppedChars })}
        </p>
      )}

      <ReportList
        title={t('writing.context.summaries')}
        empty={t('writing.context.noSummaries')}
        items={report.summaries.map((item) => ({
          key: item.chapterId,
          label: `${t('writing.tree.chapterN', { n: item.n })} ${item.title}`,
          note: item.stale ? t('writing.tree.stale') : `${item.tokens}`,
        }))}
      />
      {report.droppedSummaries.length > 0 && (
        <ReportList
          title={t('writing.context.dropped')}
          items={report.droppedSummaries.map((item) => ({
            key: item.chapterId,
            label: `${t('writing.tree.chapterN', { n: item.n })} ${item.title}`,
          }))}
        />
      )}
      {report.missingSummaries.length > 0 && (
        <ReportList
          title={t('writing.context.missing')}
          items={report.missingSummaries.map((item) => ({
            key: item.chapterId,
            label: `${t('writing.tree.chapterN', { n: item.n })} ${item.title}`,
          }))}
        />
      )}
      <ReportList
        title={t('writing.context.bible')}
        empty={t('writing.context.noBible')}
        items={report.bible.map((entry) => ({
          key: `${entry.bookId}:${entry.entryId}`,
          label: entry.comment?.trim() || entry.matchedKeys.join('、') || entry.entryId,
          note:
            entry.placement === 'static'
              ? t('writing.context.constant')
              : entry.matchedKeys.length > 0
                ? entry.matchedKeys.join('、')
                : String(entry.tokens),
        }))}
      />
      {report.references.length > 0 && (
        <ReportList
          title={t('writing.context.references')}
          items={report.references.map((item) => ({
            key: `${item.kind}:${item.id}`,
            label: `${item.token} → ${item.title}`,
            note: item.truncated ? t('writing.context.cut') : String(item.tokens),
          }))}
        />
      )}
      {report.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 text-warning">
          {report.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportList({
  title,
  empty,
  items,
}: {
  title: string;
  empty?: string;
  items: { key: string; label: string; note?: string }[];
}) {
  return (
    <section>
      <h3 className="mb-1 text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase">
        {title}
      </h3>
      {items.length === 0 ? (
        empty && <p className="text-ink-3">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {items.map((item) => (
            <li key={item.key} className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-ink-story">{item.label}</span>
              {item.note && (
                <span className="max-w-[45%] shrink-0 truncate text-ink-3">{item.note}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SummaryEditor({ doc, ai }: { doc: WritingDocumentSummary; ai: WritingAiController }) {
  const { t } = useTranslation();
  const id = useId();
  const update = useUpdateWritingDocument();
  const [draft, setDraft] = useState(doc.summary);
  useEffect(() => setDraft(doc.summary), [doc.summary]);
  const pending = doc.summaryPending || ai.summarizing === doc.id;

  return (
    <section data-part="writing-summary">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <FieldLabel htmlFor={`${id}-summary`}>{t('writing.context.summary')}</FieldLabel>
        {pending ? (
          <span className="pulse-live text-[11px] text-ink-3">
            {t('writing.tree.summaryPending')}
          </span>
        ) : (
          doc.summaryStale && (
            <span className="chip-outline px-1.5 py-0.5 text-[10px] leading-none">
              {t('writing.tree.stale')}
            </span>
          )
        )}
      </div>
      <Textarea
        id={`${id}-summary`}
        rows={5}
        value={draft}
        disabled={pending}
        placeholder={t('writing.context.summaryPlaceholder')}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending || ai.phase !== 'idle'}
          onClick={() => void ai.summarize(doc.id)}
        >
          {doc.summary ? t('writing.context.regenerate') : t('writing.tree.summarize')}
        </Button>
        <Button
          size="sm"
          disabled={pending || update.isPending || draft === doc.summary}
          onClick={() => update.mutate({ id: doc.id, summary: draft })}
        >
          {t('common.save')}
        </Button>
      </div>
    </section>
  );
}
