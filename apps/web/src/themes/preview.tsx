import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../lib/utils';
import {
  optionAttributes,
  type ThemeMeta,
  type ThemeMode,
  type ThemeOptionValue,
} from './registry';
import {
  BackdropLayer,
  MessageOrnamentLayer,
  SignatureScope,
  useSignature,
} from './signature';

/**
 * 活的预览卡（DESIGN §2.3）：`data-theme` / `data-mode` / `data-opt-*`（/ `data-variant`）作用域到这一块，
 * 真实渲染该世界的缩影（背景层 + 两条消息与装饰层 + 输入框 + 主按钮，带与应用里相同的 data-part）。
 * 外观页的主题卡与变体编辑器的实时预览共用。
 */
export function ThemePreviewRoot({
  theme,
  mode,
  options,
  variantId,
  label,
  className,
}: {
  theme: ThemeMeta;
  mode: ThemeMode;
  options: Record<string, ThemeOptionValue>;
  variantId?: string;
  label: string;
  className?: string;
}) {
  return (
    // relative + isolate + overflow-hidden：背景层（absolute、-z-10）裁在卡内、垫在内容下
    <div
      data-theme={theme.id}
      data-mode={mode}
      {...(variantId ? { 'data-variant': variantId } : {})}
      {...optionAttributes(options)}
      data-part="theme-preview"
      className={cn('surface-canvas relative isolate overflow-hidden', className)}
    >
      <SignatureScope themeId={theme.id}>
        <BackdropLayer scope="preview" />
        <ThemePreview label={label} />
      </SignatureScope>
    </div>
  );
}

/** 迷你版对话：两条消息（带装饰层）+ 输入框 + 主按钮，data-part 与应用里一致 */
export function ThemePreview({ label, children }: { label: string; children?: ReactNode }) {
  const { t } = useTranslation();
  const { AvatarFrame, SendButton, SwipeIndicator, MessageDivider } = useSignature();
  const userName = t('appearance.previewUserName');
  return (
    <div data-part="chat-view" className="pointer-events-none" aria-hidden>
      <div data-part="message-list" className="surface-reading space-y-3 px-4 pt-4 pb-3">
        <article
          data-part="message"
          data-role="assistant"
          data-index={0}
          data-streaming={false}
          className="relative"
        >
          <MessageOrnamentLayer role="assistant" id="preview-assistant" index={0} />
          <div className="flex gap-2">
            <AvatarFrame role="character" className="flex size-7 items-center justify-center">
              <span className="text-[11px] font-medium">{Array.from(label)[0] ?? 'A'}</span>
            </AvatarFrame>
            <div className="min-w-0 flex-1">
              <div data-part="message-header" className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-medium text-ink">{label}</span>
                <span className="text-[10px] text-ink-3 tabular-nums">21:04</span>
              </div>
              <div
                data-part="message-body"
                className="font-story mt-1 text-[12px] leading-relaxed text-ink-story"
              >
                <div className="nt-md">
                  <p>
                    {t('appearance.previewLine')}
                    <span className="text-ink-quote">{t('appearance.previewQuote')}</span>
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div data-part="message-actions" className="mt-1.5 ps-9">
            <div data-part="swipe" className="flex items-center gap-1.5">
              <SwipeIndicator
                index={1}
                total={3}
                busy={false}
                labels={{ prev: '', next: '', new: '' }}
                onPrev={() => {}}
                onNext={() => {}}
              />
            </div>
          </div>
        </article>

        <MessageDivider role="user" index={1} />

        <article
          data-part="message"
          data-role="user"
          data-index={1}
          data-streaming={false}
          className="relative"
        >
          <MessageOrnamentLayer role="user" id="preview-user" index={1} />
          <div className="flex gap-2">
            <AvatarFrame role="user" className="flex size-7 items-center justify-center">
              <span className="text-[11px] font-medium">{Array.from(userName)[0] ?? 'U'}</span>
            </AvatarFrame>
            <div className="min-w-0 flex-1">
              <div data-part="message-header" className="flex items-baseline gap-1.5">
                <span className="text-[11px] font-medium text-ink">{userName}</span>
                <span className="text-[10px] text-ink-3 tabular-nums">21:05</span>
              </div>
              <div
                data-part="message-body"
                className="font-story mt-1 text-[12px] leading-relaxed text-ink-story"
              >
                <div className="nt-md">
                  <p>{t('appearance.previewUser')}</p>
                </div>
              </div>
            </div>
          </div>
        </article>
        {children}
      </div>

      <div data-part="composer-dock" className="surface-reading px-4 pb-4">
        <div data-part="composer" className="field rounded-panel flex items-center gap-2 p-1.5">
          <span data-part="composer-input" className="min-w-0 flex-1 px-1.5 text-[12px] text-ink-3">
            {t('chat.composer.placeholder')}
          </span>
          <SendButton state="ready" disabled={false} label="" onClick={() => {}} />
        </div>
      </div>
    </div>
  );
}
