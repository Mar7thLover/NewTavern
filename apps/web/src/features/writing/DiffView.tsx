import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { computeDiff } from './diff';
import { cn } from '../../lib/utils';

/**
 * 字符级对照（`data-part="writing-diff"`）：删去的划线，新增的下划线 + 软底。
 * 大文本自动退化为按词对照并提示。
 */
export function DiffView({
  before,
  after,
  className,
}: {
  before: string;
  after: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const result = useMemo(() => computeDiff(before, after), [before, after]);
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3 tabular-nums">
        <span>{t('writing.diff.stats', { added: result.added, removed: result.removed })}</span>
        {result.mode === 'words' && <span>{t('writing.diff.words')}</span>}
        {result.mode === 'whole' && <span>{t('writing.diff.whole')}</span>}
      </div>
      <div data-part="writing-diff" data-mode={result.mode} className="text-sm text-ink-story">
        {result.parts.length === 0 ? (
          <span className="text-ink-3">{t('writing.diff.empty')}</span>
        ) : (
          result.parts.map((part, index) =>
            part.kind === 'added' ? (
              <ins key={index}>{part.text}</ins>
            ) : part.kind === 'removed' ? (
              <del key={index}>{part.text}</del>
            ) : (
              <span key={index}>{part.text}</span>
            ),
          )
        )}
      </div>
    </div>
  );
}
