import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';
import { slotSeconds } from '../../themes/apply';
import { useSignature } from '../../themes/signature';

export interface ReasoningBlockProps {
  reasoning: string;
  /** 本条消息正在流式输出 */
  streaming: boolean;
  /** 正文已经开始输出 —— 此时推理区自动折叠 */
  hasText: boolean;
}

/**
 * 推理折叠区。流式且尚无正文时展开并显示「思考中…」+ shimmer；
 * 正文一出现就自动折叠，用户手动展开/折叠后以手动状态为准。
 */
export function ReasoningBlock({ reasoning, streaming, hasText }: ReasoningBlockProps) {
  const { t } = useTranslation();
  const { StreamingCursor } = useSignature();
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);

  const thinking = streaming && !hasText;
  const open = manualOpen ?? thinking;

  return (
    <div data-part="reasoning" data-open={open} className="rounded-card edge-rule mb-3 border">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-ink-2 transition-colors hover:text-ink focus-ring-inset"
      >
        <span className="shrink-0">
          {thinking ? t('chat.reasoning.thinking') : t('chat.reasoning.title')}
        </span>
        {thinking && <StreamingCursor kind="reasoning" />}
        <ChevronDown
          aria-hidden
          className={cn('ms-auto size-3.5 shrink-0 motion-transform', open && 'rotate-180')}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: slotSeconds('--dur-panel') }}
            className="overflow-hidden"
          >
            <div className="px-3 pt-0.5 pb-2.5 text-[13px] leading-[1.7] whitespace-pre-wrap text-ink-2">
              {reasoning || t('chat.reasoning.empty')}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
