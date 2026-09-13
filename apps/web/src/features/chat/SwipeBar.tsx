import { ChevronLeft, ChevronRight, GitBranch, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../components/ui/icon-button';

export interface SwipeBarProps {
  /** 当前兄弟的下标（从 0 起） */
  index: number;
  total: number;
  /** 兄弟中有节点带后代 —— 切换会改变后续整段对话 */
  branched: boolean;
  busy: boolean;
  onPrev: () => void;
  onNext: () => void;
  /** 在同一父节点下重新生成一条（= 新 swipe） */
  onRegenerate: () => void;
}

/** 助手消息的 swipe 条：‹ i/n ›、重生成、分叉提示 */
export function SwipeBar({
  index,
  total,
  branched,
  busy,
  onPrev,
  onNext,
  onRegenerate,
}: SwipeBarProps) {
  const { t } = useTranslation();
  const atEnd = index >= total - 1;

  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        label={t('chat.swipe.prev')}
        size="xs"
        disabled={index <= 0 || busy}
        onClick={onPrev}
      >
        <ChevronLeft aria-hidden />
      </IconButton>
      <span className="min-w-10 text-center text-[11px] tabular-nums text-muted-foreground">
        {index + 1}/{total}
      </span>
      <IconButton
        label={atEnd ? t('chat.swipe.new') : t('chat.swipe.next')}
        size="xs"
        disabled={busy}
        onClick={atEnd ? onRegenerate : onNext}
      >
        <ChevronRight aria-hidden />
      </IconButton>
      <IconButton
        label={t('chat.message.regenerate')}
        size="xs"
        disabled={busy}
        onClick={onRegenerate}
      >
        <RefreshCw aria-hidden />
      </IconButton>
      {branched && (
        <span
          title={t('chat.swipe.branchedHint')}
          className="ms-1 inline-flex items-center gap-1 rounded-full bg-primary/12 px-1.5 py-0.5 text-[10px] font-medium text-primary"
        >
          <GitBranch aria-hidden className="size-3" />
          {t('chat.swipe.branched')}
        </span>
      )}
    </div>
  );
}
