import { AnimatePresence, motion } from 'framer-motion';
import { Brain, ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';

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
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);

  const thinking = streaming && !hasText;
  const open = manualOpen ?? thinking;

  return (
    <div className="mb-2 rounded-lg border border-border/70 bg-muted/30">
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <Brain aria-hidden className="size-3.5 shrink-0" />
        <span className="shrink-0">
          {thinking ? t('chat.reasoning.thinking') : t('chat.reasoning.title')}
        </span>
        {thinking && (
          <span
            aria-hidden
            className="nt-shimmer relative h-px min-w-8 flex-1 overflow-hidden rounded-full bg-border"
          />
        )}
        <ChevronDown
          aria-hidden
          className={cn(
            'ms-auto size-3.5 shrink-0 transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="px-3 pt-0.5 pb-2.5 text-[13px] leading-[1.7] whitespace-pre-wrap text-muted-foreground">
              {reasoning || t('chat.reasoning.empty')}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
