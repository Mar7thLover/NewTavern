import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AttachmentDocumentChip, AttachmentIconButton } from './AttachmentChip';
import { extensionLabel, formatBytes } from './AttachmentFiles';
import type { AttachmentTray as TrayState, TrayItem } from '../features/chat/useAttachmentTray';
import { cn } from '../lib/utils';

/**
 * 输入托盘（M4 契约 §3.4）：在输入框上方一行，图片是缩略图、文档是小片；
 * 上传中画进度线，失败的项标红（能重试的给重试键），每项都能移除。
 * 横向放不下时自己滚动，不撑宽页面。
 */
export function AttachmentTray({ tray }: { tray: TrayState }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLUListElement>(null);
  const count = tray.items.length;
  // 放不下时两端淡出，告诉人「还能往那边滑」，而不是一张卡被生硬地切掉
  const [edges, setEdges] = useState({ start: false, end: false });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const max = element.scrollWidth - element.clientWidth;
      const left = Math.abs(element.scrollLeft);
      const next = { start: left > 1, end: max - left > 1 };
      setEdges((current) =>
        current.start === next.start && current.end === next.end ? current : next,
      );
    };
    // 滚动条藏起来了：鼠标竖向滚轮也能横着翻
    const onWheel = (event: WheelEvent) => {
      if (event.deltaX !== 0 || event.shiftKey) return;
      if (element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY;
    };
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: false });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', measure);
      element.removeEventListener('wheel', onWheel);
      observer?.disconnect();
    };
  }, [count]);

  // 往已有的托盘里再加文件：新的排在最后，滚过去让人看见它（从空托盘一次加一批时停在开头）
  const previousCount = useRef(count);
  useEffect(() => {
    const element = ref.current;
    if (element && previousCount.current > 0 && count > previousCount.current) {
      element.scrollTo({ left: element.scrollWidth, behavior: 'auto' });
    }
    previousCount.current = count;
  }, [count]);

  if (count === 0) return null;

  const fade = 28;
  const mask =
    edges.start || edges.end
      ? `linear-gradient(to right, ${edges.start ? `transparent, #000 ${fade}px` : '#000'}, ${
          edges.end ? `#000 calc(100% - ${fade}px), transparent` : '#000'
        })`
      : undefined;

  return (
    <ul
      ref={ref}
      data-part="composer-tray"
      data-overflow-start={edges.start}
      data-overflow-end={edges.end}
      aria-label={t('chat.attach.trayLabel')}
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
      className="-mx-2 -mt-1 flex min-w-0 gap-2 overflow-x-auto overscroll-x-contain px-2 pt-1.5 pb-2.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tray.items.map((item) => (
        <li key={item.key} className="flex shrink-0">
          {item.kind === 'image' ? (
            <TrayImage item={item} onRemove={tray.remove} onRetry={tray.retry} />
          ) : (
            <TrayDocument item={item} onRemove={tray.remove} onRetry={tray.retry} />
          )}
        </li>
      ))}
    </ul>
  );
}

interface TrayItemProps {
  item: TrayItem;
  onRemove: (key: string) => void;
  onRetry: (key: string) => void;
}

/** 失败原因的短句 */
function useErrorText() {
  const { t } = useTranslation();
  return (item: TrayItem): string => {
    if (!item.error) return '';
    if (item.error.message) return item.error.message;
    return t(`chat.attach.errors.${item.error.reason}`);
  };
}

function TrayImage({ item, onRemove, onRetry }: TrayItemProps) {
  const { t } = useTranslation();
  const errorText = useErrorText();
  const percent = Math.round(item.progress * 100);
  const label =
    item.status === 'uploading'
      ? `${item.name} · ${t('chat.attach.uploading', { percent })}`
      : item.status === 'error'
        ? `${item.name} · ${errorText(item)}`
        : item.name;

  return (
    <div
      data-part="attachment"
      data-kind="image"
      data-context="tray"
      data-status={item.status}
      title={label}
      className={cn(
        'relative size-16 overflow-hidden rounded-control border bg-control',
        item.status === 'error' ? 'border-danger' : 'edge-rule',
      )}
    >
      {item.previewUrl && (
        <img
          src={item.previewUrl}
          alt={item.name}
          draggable={false}
          className={cn(
            'size-full object-cover transition-opacity',
            item.status !== 'done' && 'opacity-55',
          )}
        />
      )}
      {item.status === 'uploading' && (
        <span
          role="progressbar"
          aria-label={item.name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          data-part="attachment-progress"
          className="absolute inset-x-1.5 bottom-1.5 h-1 overflow-hidden rounded-pill bg-raised"
        >
          <span
            className="block h-full rounded-pill bg-accent transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </span>
      )}
      {item.status === 'error' && item.retryable && (
        <span className="absolute inset-0 grid place-items-center">
          <AttachmentIconButton
            tone="retry"
            label={t('chat.attach.retry', { name: item.name })}
            onClick={() => onRetry(item.key)}
            className="size-7 [&_svg]:size-3.5"
          />
        </span>
      )}
      <AttachmentIconButton
        label={t('chat.attach.remove', { name: item.name })}
        onClick={() => onRemove(item.key)}
        className="absolute end-1 top-1"
      />
    </div>
  );
}

function TrayDocument({ item, onRemove, onRetry }: TrayItemProps) {
  const { t, i18n } = useTranslation();
  const errorText = useErrorText();
  const percent = Math.round(item.progress * 100);
  const meta =
    item.status === 'uploading'
      ? t('chat.attach.uploading', { percent })
      : item.status === 'error'
        ? errorText(item)
        : item.kind === 'pdf' && item.asset?.pages
          ? t('chat.attach.pdfMeta', {
              pages: item.asset.pages,
              size: formatBytes(item.size, i18n.language),
            })
          : `${extensionLabel(item.name, item.kind)} · ${formatBytes(item.size, i18n.language)}`;

  return (
    <AttachmentDocumentChip
      context="tray"
      kind={item.kind}
      name={item.name}
      meta={meta}
      metaTone={item.status === 'error' ? 'danger' : 'muted'}
      status={item.status}
      progress={item.progress}
      className="h-16 w-56 max-w-[70vw]"
      actions={
        <>
          {item.status === 'error' && item.retryable && (
            <AttachmentIconButton
              tone="retry"
              label={t('chat.attach.retry', { name: item.name })}
              onClick={() => onRetry(item.key)}
            />
          )}
          <AttachmentIconButton
            label={t('chat.attach.remove', { name: item.name })}
            onClick={() => onRemove(item.key)}
          />
        </>
      }
    />
  );
}
