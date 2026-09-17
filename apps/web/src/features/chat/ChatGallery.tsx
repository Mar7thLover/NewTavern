import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { openLightbox, type LightboxImage } from '../../components/Lightbox';
import { FieldLabel } from '../../components/ui/field';
import { assetUrl, type ChatDetail } from '../../lib/api';

/** 折叠时最多露几张（三列 × 三行） */
const COLLAPSED_COUNT = 9;

/** 本对话全部节点（不只当前路径）里的图片，新的在前 */
export function collectChatImages(chat: Pick<ChatDetail, 'nodes'>): LightboxImage[] {
  const nodes = [...chat.nodes].sort((a, b) =>
    a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1,
  );
  const images: LightboxImage[] = [];
  for (const node of nodes) {
    // 同一条消息里后到的图也更「新」
    for (let i = node.parts.length - 1; i >= 0; i--) {
      const part = node.parts[i];
      if (part?.type !== 'image') continue;
      images.push({
        assetId: part.assetId,
        mime: part.mime,
        ...(part.name ? { name: part.name } : {}),
      });
    }
  }
  return images;
}

/**
 * 会话面板的「图片」分区（M4 契约 §3.4）：方格缩略图，点开进灯箱，灯箱里左右翻的是这整组。
 * 没有图片时只留一行小字，不占地方。
 */
export function ChatGallery({ chat }: { chat: ChatDetail }) {
  const { t } = useTranslation();
  const images = useMemo(() => collectChatImages(chat), [chat]);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? images : images.slice(0, COLLAPSED_COUNT);

  return (
    <section data-part="gallery" data-count={images.length}>
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel>{t('gallery.title')}</FieldLabel>
        {images.length > 0 && (
          <span className="text-[11px] text-ink-3 tabular-nums">
            {t('gallery.count', { total: images.length })}
          </span>
        )}
      </div>
      {images.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-ink-2">{t('gallery.empty')}</p>
      ) : (
        <>
          <ul className="grid grid-cols-3 gap-1.5">
            {visible.map((image, index) => (
              <li key={`${image.assetId}-${index}`}>
                <button
                  type="button"
                  data-part="gallery-item"
                  aria-label={
                    image.name
                      ? t('chat.attach.openImage', { name: image.name })
                      : t('chat.attach.openImageIndex', { index: index + 1, total: images.length })
                  }
                  title={image.name}
                  onClick={() => openLightbox(images, index)}
                  className="focus-ring block aspect-square w-full cursor-zoom-in overflow-hidden rounded-control bg-control transition-opacity hover:opacity-85"
                >
                  <img
                    src={assetUrl(image.assetId)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                    className="size-full object-cover"
                  />
                </button>
              </li>
            ))}
          </ul>
          {images.length > COLLAPSED_COUNT && (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="focus-ring mt-2 cursor-pointer text-[11px] text-ink-2 underline-offset-2 hover:text-ink hover:underline"
            >
              {expanded ? t('gallery.showLess') : t('gallery.showAll', { total: images.length })}
            </button>
          )}
        </>
      )}
    </section>
  );
}
