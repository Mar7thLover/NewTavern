import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AttachmentDocumentChip, AttachmentIconButton } from './AttachmentChip';
import { extensionLabel, kindOfMime } from './AttachmentFiles';
import { assetUrl, type DocumentPart, type ImagePart, type MediaPart } from '../lib/api';
import { cn } from '../lib/utils';

/* ------------------------------------------------------------------ */
/* 消息里的图片网格                                                      */
/* ------------------------------------------------------------------ */

/**
 * 图片自适应网格（M4 契约 §3.4）：
 * 1 张原比例、限高；2–4 张两列方格；更多三列方格。点击交给调用方开灯箱。
 */
export function AttachmentImageGrid({
  images,
  onOpen,
  className,
}: {
  images: readonly ImagePart[];
  /** 下标 = 在 `images` 里的位置 */
  onOpen: (index: number) => void;
  className?: string;
}) {
  const count = images.length;
  if (count === 0) return null;
  const layout = count === 1 ? 'single' : count <= 4 ? 'pair' : 'triple';
  return (
    <div
      data-part="message-media"
      data-kind="images"
      data-layout={layout}
      data-count={count}
      className={cn(
        layout === 'single'
          ? 'flex'
          : cn(
              'grid w-full gap-1.5',
              layout === 'pair' ? 'max-w-sm grid-cols-2' : 'max-w-md grid-cols-3',
            ),
        className,
      )}
    >
      {images.map((image, index) => (
        <ImageTile
          // 同一张图可以在一条消息里出现两次（同 sha256 去重后 id 相同）
          key={`${image.assetId}-${index}`}
          image={image}
          index={index}
          total={count}
          single={layout === 'single'}
          onOpen={() => onOpen(index)}
        />
      ))}
    </div>
  );
}

function ImageTile({
  image,
  index,
  total,
  single,
  onOpen,
}: {
  image: ImagePart;
  index: number;
  total: number;
  single: boolean;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const label = image.name
    ? t('chat.attach.openImage', { name: image.name })
    : t('chat.attach.openImageIndex', { index: index + 1, total });

  return (
    <button
      type="button"
      data-part="attachment"
      data-kind="image"
      data-context="message"
      data-status={state}
      aria-label={label}
      title={image.name}
      onClick={onOpen}
      className={cn(
        'focus-ring relative cursor-zoom-in overflow-hidden rounded-card bg-control transition-opacity hover:opacity-90',
        single
          ? cn('block max-w-full', state !== 'ready' && 'h-40 w-56 max-w-full')
          : 'aspect-square w-full',
        state === 'error' && 'edge-rule cursor-pointer border',
      )}
    >
      {state === 'error' ? (
        <span className="absolute inset-0 grid place-items-center p-2 text-center text-[11px] leading-snug text-ink-3">
          {t('lightbox.loadFailed')}
        </span>
      ) : (
        <img
          src={assetUrl(image.assetId)}
          alt={image.name ?? ''}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setState('ready')}
          onError={() => setState('error')}
          className={cn(
            single
              ? 'block h-auto max-h-[min(20rem,55vh)] w-auto max-w-full'
              : 'size-full object-cover',
            state === 'loading' && 'opacity-0',
          )}
        />
      )}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* 消息里的文档                                                          */
/* ------------------------------------------------------------------ */

export function AttachmentDocumentList({
  documents,
  className,
}: {
  documents: readonly DocumentPart[];
  className?: string;
}) {
  const { t } = useTranslation();
  if (documents.length === 0) return null;
  return (
    <div
      data-part="message-media"
      data-kind="documents"
      data-count={documents.length}
      className={cn('flex min-w-0 flex-wrap gap-2', className)}
    >
      {documents.map((document, index) => {
        const kind = kindOfMime(document.mime);
        const name =
          document.name ?? `${document.assetId.slice(0, 8)}.${kind === 'pdf' ? 'pdf' : 'txt'}`;
        return (
          <AttachmentDocumentChip
            key={`${document.assetId}-${index}`}
            context="message"
            kind={kind}
            name={name}
            meta={
              kind === 'pdf'
                ? t('chat.attach.kindPdf')
                : t('chat.attach.kindText', { ext: extensionLabel(name, kind) })
            }
            href={assetUrl(document.assetId)}
            className="w-64 max-w-full"
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 编辑态：所有附件排成一行小件，每项可移除                                */
/* ------------------------------------------------------------------ */

export function AttachmentEditList({
  media,
  onRemove,
}: {
  media: readonly MediaPart[];
  /** 下标 = 在 `media` 里的位置（同一资产可能出现两次） */
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  if (media.length === 0) return null;
  return (
    <ul
      data-part="message-media"
      data-kind="edit"
      aria-label={t('chat.attach.editLabel')}
      className="flex min-w-0 flex-wrap gap-2"
    >
      {media.map((part, index) => {
        const kind = part.type === 'image' ? 'image' : kindOfMime(part.mime);
        const name =
          part.name ?? (part.type === 'image' ? t('chat.attach.image') : t('chat.attach.document'));
        const remove = (
          <AttachmentIconButton
            label={t('chat.attach.remove', { name })}
            onClick={() => onRemove(index)}
            className={part.type === 'image' ? 'absolute end-1 top-1' : undefined}
          />
        );
        return (
          <li key={`${part.assetId}-${index}`} className="flex">
            {part.type === 'image' ? (
              <div
                data-part="attachment"
                data-kind="image"
                data-context="edit"
                title={part.name}
                className="edge-rule relative size-16 overflow-hidden rounded-control border bg-control"
              >
                <img
                  src={assetUrl(part.assetId)}
                  alt={part.name ?? ''}
                  draggable={false}
                  className="size-full object-cover"
                />
                {remove}
              </div>
            ) : (
              <AttachmentDocumentChip
                context="edit"
                kind={kind}
                name={name}
                meta={
                  kind === 'pdf'
                    ? t('chat.attach.kindPdf')
                    : t('chat.attach.kindText', { ext: extensionLabel(name, kind) })
                }
                className="h-16 w-56 max-w-full"
                actions={remove}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
