import { AnimatePresence, motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

import { assetUrl } from '../lib/api';
import { cn } from '../lib/utils';
import { slotSeconds } from '../themes/apply';

/* ------------------------------------------------------------------ */
/* 状态：任何地方 `openLightbox(items, index)`，`LightboxHost` 负责渲染    */
/* ------------------------------------------------------------------ */

export interface LightboxImage {
  assetId: string;
  mime?: string;
  name?: string;
}

interface LightboxState {
  items: LightboxImage[];
  index: number;
  open: boolean;
  show: (items: LightboxImage[], index: number) => void;
  go: (index: number) => void;
  close: () => void;
}

const useLightboxStore = create<LightboxState>()((set, get) => ({
  items: [],
  index: 0,
  open: false,
  show: (items, index) =>
    set({
      items,
      index: Math.min(Math.max(index, 0), Math.max(items.length - 1, 0)),
      open: items.length > 0,
    }),
  go: (index) => {
    const { items } = get();
    if (items.length === 0) return;
    set({ index: (index + items.length) % items.length });
  },
  close: () => set({ open: false }),
}));

export function openLightbox(items: LightboxImage[], index = 0): void {
  useLightboxStore.getState().show(items, index);
}

/** 挂一次即可（对话页挂在 ChatView 里）；Portal 到 body，压在抽屉与弹窗之上 */
export function LightboxHost() {
  const { items, index, open, go, close } = useLightboxStore();
  return (
    <AnimatePresence>
      {open && items.length > 0 && (
        <Lightbox key="lightbox" items={items} index={index} onIndexChange={go} onClose={close} />
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* 灯箱                                                                 */
/* ------------------------------------------------------------------ */

/** 手指横向滑过这么远就翻页 */
const SWIPE_PX = 56;

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function extensionOf(mime: string | undefined): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'png';
  }
}

export interface LightboxProps {
  items: readonly LightboxImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

/**
 * 全屏看图（M4 契约 §3.4）：左右切换、Esc 关闭、下载原图、手机左右滑动；
 * `role="dialog"`，Tab 焦点圈在灯箱里，关闭后焦点回到打开它的元素。
 * 底是该世界自己的 canvas（素的白纸、酒馆的橡木、雨夜的深蓝），不是统一的黑幕。
 */
export function Lightbox({ items, index, onIndexChange, onClose }: LightboxProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const total = items.length;
  const current = items[Math.min(index, total - 1)];
  const many = total > 1;
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [dragX, setDragX] = useState(0);
  const pointer = useRef<{ id: number; x: number; y: number; horizontal: boolean | null } | null>(
    null,
  );
  /** 刚滑过一次：紧随其后的 click 不算「点空白关闭」 */
  const swiped = useRef(false);
  const duration = slotSeconds('--dur-panel');

  const prev = useCallback(() => onIndexChange(index - 1), [index, onIndexChange]);
  const next = useCallback(() => onIndexChange(index + 1), [index, onIndexChange]);

  useEffect(() => setStatus('loading'), [current?.assetId, index]);

  // 打开：记住焦点、锁滚动；关闭：还原
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus?.({ preventScroll: true });
    };
  }, []);

  // 键盘在捕获阶段接住：抽屉 / 弹窗挂在 document 上的 Esc 不会跟着关
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === 'ArrowLeft' && many) {
        event.preventDefault();
        event.stopPropagation();
        prev();
      } else if (event.key === 'ArrowRight' && many) {
        event.preventDefault();
        event.stopPropagation();
        next();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [many, next, onClose, prev]);

  /** Tab 圈在灯箱内 */
  const trapFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  /* ---------------- 手势：横向滑动翻页，轻点空白处关闭 ---------------- */

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    swiped.current = false;
    if (event.pointerType === 'mouse') return;
    pointer.current = { id: event.pointerId, x: event.clientX, y: event.clientY, horizontal: null };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointer.current;
    if (!start || start.id !== event.pointerId || !many) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (start.horizontal === null && Math.hypot(dx, dy) > 8) {
      start.horizontal = Math.abs(dx) > Math.abs(dy);
      if (start.horizontal) event.currentTarget.setPointerCapture(event.pointerId);
    }
    if (start.horizontal) {
      swiped.current = true;
      setDragX(dx);
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = pointer.current;
    if (!start || start.id !== event.pointerId) return;
    pointer.current = null;
    const dx = event.clientX - start.x;
    setDragX(0);
    if (start.horizontal && many && Math.abs(dx) >= SWIPE_PX) {
      if (dx < 0) next();
      else prev();
    }
  };

  if (!current) return null;

  const counter = t('lightbox.counter', { current: index + 1, total });
  const fileName =
    current.name ?? `image-${current.assetId.slice(0, 8)}.${extensionOf(current.mime)}`;

  return createPortal(
    <motion.div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={current.name ? `${t('lightbox.title')} · ${current.name}` : t('lightbox.title')}
      data-part="lightbox"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration }}
      onKeyDown={trapFocus}
      className="fixed inset-0 z-[70] flex flex-col overflow-hidden text-ink"
    >
      {/* 底：这个世界的 canvas（不透明：半透明时底下的界面会像残影）；点它关闭 */}
      <div
        aria-hidden
        data-part="lightbox-backdrop"
        className="surface-canvas absolute inset-0"
        onClick={onClose}
      />

      <div
        data-part="lightbox-bar"
        className="relative flex min-w-0 shrink-0 items-center gap-2 px-3 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2 sm:px-4"
      >
        <div className="min-w-0 flex-1">
          {many && (
            <span className="me-2 text-xs text-ink-2 tabular-nums" aria-live="polite">
              {counter}
            </span>
          )}
          <span className="truncate text-sm text-ink" title={current.name}>
            {current.name ?? ''}
          </span>
        </div>
        <a
          href={assetUrl(current.assetId)}
          download={fileName}
          aria-label={t('lightbox.download')}
          title={t('lightbox.download')}
          data-part="lightbox-button"
          className="action-quiet surface-raised bg-raised focus-ring inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-pill [&_svg]:size-4"
        >
          <Download aria-hidden />
        </a>
        <button
          ref={closeRef}
          type="button"
          aria-label={t('lightbox.close')}
          title={t('lightbox.close')}
          data-part="lightbox-button"
          onClick={onClose}
          className="action-quiet surface-raised bg-raised focus-ring inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-pill [&_svg]:size-4"
        >
          <X aria-hidden />
        </button>
      </div>

      <div
        data-part="lightbox-stage"
        className="relative min-h-0 flex-1 touch-pan-y"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {/* 图片外的空白也算「底」：点一下关闭 */}
        <div
          className="absolute inset-0 flex items-center justify-center px-3 pb-3 sm:px-20 sm:pb-8"
          onClick={(event) => {
            if (event.target === event.currentTarget && !swiped.current) onClose();
          }}
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.img
              key={`${current.assetId}-${index}`}
              src={assetUrl(current.assetId)}
              alt={current.name ?? counter}
              draggable={false}
              data-part="lightbox-image"
              data-status={status}
              initial={{ opacity: 0 }}
              animate={{ opacity: status === 'error' ? 0 : 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration }}
              onLoad={() => setStatus('ready')}
              onError={() => setStatus('error')}
              style={{ x: dragX }}
              className="rounded-card max-h-full max-w-full object-contain shadow-raised select-none"
            />
          </AnimatePresence>
          {status !== 'ready' && (
            <p
              role={status === 'error' ? 'alert' : 'status'}
              className={cn(
                'pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm',
                status === 'error' ? 'text-ink-2' : 'pulse-live text-ink-3',
              )}
            >
              {status === 'error' ? t('lightbox.loadFailed') : t('common.loading')}
            </p>
          )}
        </div>

        {many && (
          <>
            <StageButton side="prev" label={t('lightbox.prev')} onClick={prev} />
            <StageButton side="next" label={t('lightbox.next')} onClick={next} />
          </>
        )}
      </div>

      {/* 手机：翻页键放在拇指够得着的底部 */}
      {many && (
        <div
          data-part="lightbox-bar"
          data-position="bottom"
          className="relative flex shrink-0 items-center justify-center gap-6 px-3 pt-1 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:hidden"
        >
          <BarButton label={t('lightbox.prev')} onClick={prev}>
            <ChevronLeft aria-hidden />
          </BarButton>
          <span className="min-w-12 text-center text-xs text-ink-2 tabular-nums">{counter}</span>
          <BarButton label={t('lightbox.next')} onClick={next}>
            <ChevronRight aria-hidden />
          </BarButton>
        </div>
      )}
    </motion.div>,
    document.body,
  );
}

function StageButton({
  side,
  label,
  onClick,
}: {
  side: 'prev' | 'next';
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-part="lightbox-button"
      data-side={side}
      onClick={onClick}
      className={cn(
        'action-quiet surface-raised bg-raised focus-ring absolute top-1/2 hidden size-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-pill sm:inline-flex [&_svg]:size-5',
        side === 'prev' ? 'start-4' : 'end-4',
      )}
    >
      {side === 'prev' ? <ChevronLeft aria-hidden /> : <ChevronRight aria-hidden />}
    </button>
  );
}

function BarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-part="lightbox-button"
      onClick={onClick}
      className="action-quiet surface-raised bg-raised focus-ring inline-flex size-11 cursor-pointer items-center justify-center rounded-pill [&_svg]:size-5"
    >
      {children}
    </button>
  );
}
