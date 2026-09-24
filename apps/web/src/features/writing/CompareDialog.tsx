import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DiffView } from './DiffView';
import type { WritingAiController } from './useWritingAi';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui/button';
import { Segmented } from '../../components/ui/segmented';

type View = 'diff' | 'result' | 'original';

/**
 * 重写 / 扩写 / 压缩 / 自定义的对照视图（M7 §5.3）：选区原文 vs 新文本的字符级 diff，
 * 「替换」才写进正文；生成中可以停止，完成后可以重来。
 */
export function CompareDialog({ ai }: { ai: WritingAiController }) {
  const { t } = useTranslation();
  const [view, setView] = useState<View>('diff');
  const compare = ai.compare;
  const open = ai.phase === 'compare' && compare !== null;
  const text = compare?.text.trim() ?? '';

  return (
    <Modal
      open={open}
      onClose={ai.discard}
      size="xl"
      dismissible={!compare?.streaming}
      title={
        compare
          ? t('writing.compare.title', { action: t(`writing.ai.actions.${compare.action}`) })
          : ''
      }
      footer={
        compare && (
          <>
            {compare.streaming ? (
              <Button variant="outline" size="sm" onClick={ai.stop}>
                {t('writing.ai.stop')}
              </Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" onClick={ai.discard}>
                  {t('writing.compare.discard')}
                </Button>
                <Button variant="outline" size="sm" onClick={() => void ai.retry()}>
                  {t('writing.ai.retry')}
                </Button>
                <Button size="sm" disabled={text === ''} onClick={() => void ai.replace()}>
                  {t('writing.compare.replace')}
                </Button>
              </>
            )}
          </>
        )
      }
    >
      {compare && (
        <div data-part="writing-compare" className="flex min-w-0 flex-col gap-3">
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            items={[
              { value: 'diff', label: t('writing.compare.diff') },
              { value: 'result', label: t('writing.compare.result') },
              { value: 'original', label: t('writing.compare.original') },
            ]}
          />
          {compare.instruction && (
            <p className="text-xs text-ink-2">
              {t('writing.compare.instruction', { text: compare.instruction })}
            </p>
          )}
          <div className="max-h-[55dvh] min-h-24 overflow-y-auto">
            {compare.streaming ? (
              <div data-part="writing-diff" className="text-sm text-ink-story">
                {text || (
                  <span className="pulse-live text-ink-3">
                    {ai.reasoning ? t('writing.ai.reasoning') : t('writing.compare.streaming')}
                  </span>
                )}
              </div>
            ) : view === 'diff' ? (
              <DiffView before={compare.original} after={text} />
            ) : (
              <div data-part="writing-diff" className="text-sm text-ink-story">
                {view === 'result' ? text : compare.original}
              </div>
            )}
          </div>
          {compare.error && (
            <p role="alert" className="text-xs text-danger">
              {t('writing.ai.failed', { message: compare.error })}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
