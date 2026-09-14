import type { WIActivation } from '@newtavern/core';
import { useTranslation } from 'react-i18next';

import type { InspectWorldInfo } from './types';
import { Badge } from '../../components/ui/badge';

/** 世界书面板：激活条目（书名 / 标题 / 触发键 / 原因）与被拒条目（原因） */
export function WorldInfoView({ wi }: { wi: InspectWorldInfo }) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span>{t('inspector.wi.budget', { used: wi.budgetUsed.toLocaleString() })}</span>
        {wi.overflowed && (
          <span className="rounded-full border border-destructive/50 bg-destructive/10 px-2 py-0.5 text-destructive">
            {t('inspector.wi.overflowed')}
          </span>
        )}
      </div>

      <section>
        <h3 className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t('inspector.wi.activated')} · {wi.activations.length}
        </h3>
        {wi.activations.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('inspector.wi.none')}</p>
        ) : (
          <ul className="space-y-1.5">
            {wi.activations.map((activation, index) => (
              <ActivationRow key={`${activation.entry.id}-${index}`} activation={activation} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t('inspector.wi.rejected')} · {wi.rejected.length}
        </h3>
        {wi.rejected.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('inspector.wi.noneRejected')}</p>
        ) : (
          <ul className="space-y-1">
            {wi.rejected.map((item, index) => (
              <li
                key={`${item.entryId}-${index}`}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-card/40 px-2.5 py-1.5 text-xs"
              >
                <span className="min-w-0 truncate text-muted-foreground">{item.entryId}</span>
                <Badge variant="outline">
                  {t([`inspector.wi.rejects.${item.reason}`, item.reason])}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ActivationRow({ activation }: { activation: WIActivation }) {
  const { t } = useTranslation();
  const { entry } = activation;
  const title = entry.comment?.trim() || t('inspector.wi.untitled');

  return (
    <li className="rounded-md border border-border bg-card/60 px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        <Badge variant="default">
          {t([`inspector.wi.reasons.${activation.reason}`, activation.reason])}
        </Badge>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        {entry.source?.bookName && <span className="truncate">{entry.source.bookName}</span>}
        <span>
          {t(
            [`library.lorebooks.positions.${entry.position}`, 'library.lorebooks.unknownPosition'],
            { value: entry.position },
          )}
        </span>
        {activation.matchedKeys.length > 0 && (
          <span className="min-w-0 truncate">
            {t('inspector.wi.keys')}: {activation.matchedKeys.join(', ')}
          </span>
        )}
        <span className="ms-auto tabular-nums">
          {t('inspector.segments.tokens', { total: activation.tokens })}
        </span>
      </div>
    </li>
  );
}
