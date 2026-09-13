import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '../lib/utils';

/** 打开中的模态栈：Esc 只关闭最上层（详情里再弹确认框时不会连带关闭） */
const openStack: string[] = [];

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** 面板宽度 */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** 为 true 时 Esc/遮罩不关闭（如提交中） */
  dismissible?: boolean;
  className?: string;
}

const SIZE_CLASS = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-5xl',
} as const;

/** 轻量模态：Portal 到 body，Esc 关闭，点遮罩关闭，窄屏贴底全宽 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  dismissible = true,
  className,
}: ModalProps) {
  const { t } = useTranslation();
  const id = useId();
  const titleId = `${id}-title`;
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);

  useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
  });

  useEffect(() => {
    if (!open) return;
    openStack.push(id);
    const previousFocus = document.activeElement as HTMLElement | null;
    // 子元素 autoFocus 已拿到焦点时不抢
    if (!panelRef.current?.contains(document.activeElement)) panelRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || openStack[openStack.length - 1] !== id) return;
      event.stopPropagation();
      if (dismissibleRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const index = openStack.lastIndexOf(id);
      if (index !== -1) openStack.splice(index, 1);
      if (openStack.length === 0) document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.();
    };
  }, [open, id]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-[2px] sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          'flex max-h-[92dvh] w-full flex-col rounded-t-lg border border-border bg-card text-card-foreground shadow-xl outline-none sm:max-h-[85dvh] sm:rounded-lg',
          SIZE_CLASS[size],
          className,
        )}
      >
        {title !== undefined && (
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-3">
            <h2 id={titleId} className="min-w-0 flex-1 text-base font-semibold">
              {title}
            </h2>
            {dismissible && (
              <button
                type="button"
                onClick={onClose}
                aria-label={t('common.close')}
                className="-mr-2 inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-lg leading-none text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              >
                ×
              </button>
            )}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer !== undefined && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
