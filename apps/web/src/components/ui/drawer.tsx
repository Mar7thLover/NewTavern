import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { IconButton } from './icon-button';
import { cn } from '../../lib/utils';
import { slotSeconds } from '../../themes/apply';

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

  // 时长来自主题的 --dur-panel；只做透明度，滑入之类的位移交给主题自己加
  const duration = slotSeconds('--dur-panel');

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration }}
        >
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            data-part="drawer-overlay"
            className="surface-overlay absolute inset-0 cursor-default"
            onClick={onClose}
          />
          <motion.aside
            role="dialog"
            data-part="drawer"
            data-side={side}
            aria-modal="true"
            className={cn(
              'surface-raised edge-rule relative flex h-dvh w-[86vw] max-w-sm flex-col',
              side === 'left' ? 'mr-auto border-r' : 'ml-auto border-l',
              className,
            )}
          >
            {/* title 省略时由内容自己提供关闭入口（如会话列表的头部） */}
            {title !== undefined && <DrawerHeader title={title} onClose={onClose} />}
            <div data-part="drawer-body" className="min-h-0 flex-1 overflow-hidden">
              {children}
            </div>
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
    <div
      data-part="drawer-header"
      className="edge-rule flex items-center justify-between gap-2 border-b px-4 py-2.5"
    >
      <div data-part="drawer-title" className="min-w-0 truncate text-sm font-semibold">
        {title}
      </div>
      <IconButton label={t('common.close')} size="md" onClick={onClose}>
        <span aria-hidden className="text-lg leading-none">
          ×
        </span>
      </IconButton>
    </div>
  );
}
