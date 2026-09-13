import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { IconButton } from './icon-button';
import { cn } from '../../lib/utils';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side: 'left' | 'right';
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** 移动端侧边抽屉：Portal 到 body，Esc / 点遮罩关闭；与 Modal 的交互约定一致 */
export function Drawer({ open, onClose, side, title, children, className }: DrawerProps) {
  // onClose 常是内联箭头函数；用 ref 持有，避免每次渲染都重跑副作用
  // （那样会把 body.overflow 的「原值」覆盖成 hidden 而无法恢复）
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            className="absolute inset-0 cursor-default bg-black/50 backdrop-blur-[2px]"
            onClick={onClose}
          />
          <motion.aside
            role="dialog"
            aria-modal="true"
            initial={{ x: side === 'left' ? '-100%' : '100%' }}
            animate={{ x: 0 }}
            exit={{ x: side === 'left' ? '-100%' : '100%' }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className={cn(
              'relative flex h-dvh w-[86vw] max-w-sm flex-col border-border bg-card text-card-foreground shadow-xl',
              side === 'left' ? 'mr-auto border-r' : 'ml-auto border-l',
              className,
            )}
          >
            {/* title 省略时由内容自己提供关闭入口（如会话列表的头部） */}
            {title !== undefined && <DrawerHeader title={title} onClose={onClose} />}
            <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function DrawerHeader({ title, onClose }: { title?: ReactNode; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
      <div className="min-w-0 truncate text-sm font-semibold">{title}</div>
      <IconButton label={t('common.close')} size="md" onClick={onClose}>
        <span aria-hidden className="text-lg leading-none">
          ×
        </span>
      </IconButton>
    </div>
  );
}
