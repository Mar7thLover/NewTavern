import { useTranslation } from 'react-i18next';

import type { WritingAiController } from './useWritingAi';
import { Button } from '../../components/ui/button';

/**
 * 纸面下沿的一条：续写流式中是「正在写 · 停止」，写完是「保留 / 撤销 / 重来」（M7 §5.3）。
 * 其余时候不占位置。
 */
export function AiDecisionBar({ ai }: { ai: WritingAiController }) {
  const { t } = useTranslation();
  if (ai.phase !== 'streaming' && ai.phase !== 'decide') return null;
  const streaming = ai.phase === 'streaming';
  const actionLabel = ai.action ? t(`writing.ai.actions.${ai.action}`) : '';
  return (
    <div
      data-part="writing-ai-bar"
      data-state={streaming ? 'streaming' : 'decide'}
      role="region"
      aria-label={t('writing.ai.barLabel')}
      className="surface-raised edge-rule flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t px-4 py-2.5"
    >
      <span
        role="status"
        aria-live="polite"
        className={
          streaming
            ? 'pulse-live min-w-0 flex-1 text-xs text-ink-2'
            : 'min-w-0 flex-1 text-xs text-ink-2'
        }
      >
        {streaming
          ? ai.reasoning
            ? t('writing.ai.reasoning')
            : t('writing.ai.generating', { action: actionLabel })
          : t('writing.ai.pendingHint', { action: actionLabel })}
      </span>
      {streaming ? (
        <Button size="sm" variant="outline" onClick={ai.stop}>
          {t('writing.ai.stop')}
        </Button>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => void ai.retry()}>
            {t('writing.ai.retry')}
          </Button>
          <Button size="sm" variant="outline" onClick={ai.undo}>
            {t('writing.ai.undo')}
          </Button>
          <Button size="sm" onClick={() => void ai.keep()}>
            {t('writing.ai.keep')}
          </Button>
        </div>
      )}
    </div>
  );
}
