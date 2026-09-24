import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { AutosaveScheduler, type AutosaveStatus } from './autosave';
import { cn } from '../../lib/utils';

/**
 * 大纲（M7 §1）：纯文本 / Markdown，每次 AI 动作都进上下文。和正文一样停手 1.5 秒自动保存。
 */
export function OutlinePane({
  outline,
  leading,
  trailing,
  onSave,
  onDirtyChange,
}: {
  outline: string;
  leading?: ReactNode;
  trailing?: ReactNode;
  onSave: (outline: string) => Promise<unknown>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(outline);
  const [status, setStatus] = useState<AutosaveStatus>('saved');
  const latest = useRef(outline);
  const callbacks = useRef({ onSave, onDirtyChange });
  useEffect(() => {
    callbacks.current = { onSave, onDirtyChange };
  });

  const schedulerRef = useRef<AutosaveScheduler | null>(null);
  useEffect(() => {
    const scheduler = new AutosaveScheduler({
      save: async () => {
        await callbacks.current.onSave(latest.current);
      },
      // 大纲没有版本历史
      snapshot: () => Promise.resolve(),
      onStatus: (next) => {
        setStatus(next);
        callbacks.current.onDirtyChange(next !== 'saved');
      },
    });
    schedulerRef.current = scheduler;
    return () => {
      void scheduler.flush().catch(() => undefined);
      scheduler.dispose();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
      callbacks.current.onDirtyChange(false);
    };
  }, []);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header
        data-part="writing-header"
        className="edge-rule flex min-w-0 items-center gap-2 border-b px-3 py-2 sm:px-5"
      >
        {leading}
        <h1 className="font-display min-w-0 flex-1 truncate text-lg leading-tight">
          {t('writing.tree.outline')}
        </h1>
        <span
          data-part="writing-save-status"
          data-status={status}
          role="status"
          aria-live="polite"
          className={cn(
            'hidden text-[11px] text-ink-3 sm:inline',
            status === 'error' && 'text-danger',
          )}
        >
          {t(`writing.editor.status.${status}`)}
        </span>
        {trailing}
      </header>
      <div data-part="writing-scroll" className="min-h-0 flex-1 overflow-y-auto sm:px-6 sm:py-8">
        <div data-part="writing-page" data-kind="outline" className="surface-reading">
          <p className="mx-auto mb-4 max-w-(--story-measure) text-xs leading-relaxed text-ink-3">
            {t('writing.outline.hint')}
          </p>
          <textarea
            value={value}
            aria-label={t('writing.tree.outline')}
            placeholder={t('writing.outline.placeholder')}
            onChange={(event) => {
              setValue(event.target.value);
              latest.current = event.target.value;
              schedulerRef.current?.markDirty();
            }}
            className="writing-prose block min-h-[60vh] w-full resize-none bg-transparent placeholder:text-ink-3"
          />
        </div>
      </div>
    </div>
  );
}
