import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { IconButton } from '../../components/ui/icon-button';
import { useSignature } from '../../themes/signature';

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

/** 助手消息的 swipe 条：指示器（记忆物件）+ 重生成 + 分叉提示 */
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
  const { SwipeIndicator } = useSignature();
  const atEnd = index >= total - 1;

  return (
    <div data-part="swipe" className="flex items-center gap-1.5">
      {/* 记忆物件：swipe 指示的形态由主题决定（素 = 「2 / 3」纯文字 + 两个箭头） */}
      <SwipeIndicator
        index={index}
        total={total}
        busy={busy}
        labels={{
          prev: t('chat.swipe.prev'),
          next: t('chat.swipe.next'),
          new: t('chat.swipe.new'),
        }}
        onPrev={onPrev}
        onNext={atEnd ? onRegenerate : onNext}
      />
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
          className="chip-accent ms-1 inline-flex items-center px-1.5 py-0.5 text-[10px] font-medium"
        >
          {t('chat.swipe.branched')}
        </span>
      )}
    </div>
  );
}
