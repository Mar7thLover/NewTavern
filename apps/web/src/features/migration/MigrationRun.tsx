import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Button, buttonVariants } from '../../components/ui/button';
import type { MigrationDone, MigrationItem, MigrationStatus } from '../../lib/api-migration';
import { cn } from '../../lib/utils';

export interface RunState {
  total: number | null;
  items: MigrationItem[];
  done: MigrationDone | null;
  /** 'interrupted' = 连接中断；其余是开始前的错误信息 */
  error: string | null;
}

const STATUS_CLASS: Record<MigrationStatus, string> = {
  imported: 'text-success',
  skipped: 'text-ink-3',
  failed: 'text-danger',
};

function itemLabel(item: MigrationItem, t: (key: string) => string): string {
  if (item.category === 'settings') {
    return item.file === 'worldInfo' || item.file === 'defaultPersona'
      ? t(`migration.run.settingsItems.${item.file}`)
      : item.file;
  }
  return item.file;
}

export function MigrationRun({ state, onAgain }: { state: RunState; onAgain: () => void }) {
  const { t } = useTranslation();
  const logRef = useRef<HTMLOListElement>(null);
  const running = state.done === null && state.error === null;
  const finished = state.done !== null;
  const total = state.total ?? 0;
  const progress = total > 0 ? Math.min(1, state.items.length / total) : finished ? 1 : 0;

  // 进行中跟到最新一项
  useEffect(() => {
    const log = logRef.current;
    if (running && log) log.scrollTop = log.scrollHeight;
  }, [running, state.items.length]);

  const sum = (status: MigrationStatus) =>
    state.items.filter((item) => item.status === status).length;

  return (
    <section data-part="migration-run" className="space-y-6">
      <div className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p role="status" className={cn('text-sm font-medium', running && 'pulse-live')}>
            {finished
              ? t('migration.run.done')
              : running
                ? t('migration.run.running', {
                    done: state.items.length,
                    total: state.total ?? '…',
                  })
                : state.error === 'interrupted'
                  ? t('migration.run.interrupted')
                  : t('migration.run.failed', { message: state.error })}
          </p>
          <p className="text-xs text-ink-2 tabular-nums">
            {t('migration.run.summary', {
              imported: sum('imported'),
              skipped: sum('skipped'),
              failed: sum('failed'),
            })}
          </p>
        </div>
        <div
          data-part="migration-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={state.items.length}
          className="h-0.5 w-full bg-edge"
        >
          <div
            className={cn('h-full', state.error && !finished ? 'bg-danger' : 'bg-accent')}
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      </div>

      {state.items.length > 0 && (
        <ol
          ref={logRef}
          data-part="migration-log"
          className="edge-rule max-h-[55dvh] divide-y divide-edge overflow-y-auto border-y"
        >
          {state.items.map((item, index) => {
            const row = (
              <span className="flex min-w-0 items-baseline gap-3">
                <span className={cn('w-12 shrink-0 text-xs', STATUS_CLASS[item.status])}>
                  {t(`migration.run.status.${item.status}`)}
                </span>
                <span className="w-16 shrink-0 text-xs text-ink-3">
                  {t(`migration.review.categories.${item.category}`)}
                </span>
                <span className="min-w-0 flex-1 text-sm break-all">{itemLabel(item, t)}</span>
              </span>
            );
            return (
              <li
                key={`${item.category}:${item.file}:${index}`}
                data-part="migration-log-item"
                data-status={item.status}
                className="px-1 py-2"
              >
                {item.message ? (
                  <details open={item.status === 'failed' && state.items.length <= 20}>
                    <summary className="focus-ring cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                      {row}
                    </summary>
                    <p
                      className={cn(
                        'mt-1.5 ms-[7.75rem] text-xs leading-relaxed break-words max-sm:ms-0',
                        item.status === 'failed' ? 'text-danger' : 'text-ink-2',
                      )}
                    >
                      {item.message}
                    </p>
                  </details>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ol>
      )}

      {finished && state.done && state.done.warnings.length > 0 && (
        <div data-part="migration-warnings" className="space-y-2">
          <h2 className="text-sm font-semibold">{t('migration.run.warnings')}</h2>
          <ul className="edge-rule space-y-1.5 border-s ps-3 text-xs leading-relaxed text-ink-2">
            {state.done.warnings.map((warning, index) => (
              <li key={index} className="break-words">
                {warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!running && (
        <div data-part="migration-next" className="flex flex-wrap gap-2">
          <Link to="/characters" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('migration.run.goCharacters')}
          </Link>
          <Link to="/presets" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('migration.run.goPresets')}
          </Link>
          <Link to="/lorebooks" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('migration.run.goLorebooks')}
          </Link>
          <Link to="/" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            {t('migration.run.goChats')}
          </Link>
          <Button variant="ghost" size="sm" onClick={onAgain}>
            {t('migration.run.again')}
          </Button>
        </div>
      )}
    </section>
  );
}
