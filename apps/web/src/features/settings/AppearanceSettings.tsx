import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsSection } from './shared';
import { useUiStore } from '../../app/store/ui';
import { SwitchRow } from '../../components/ui/switch';
import { cn } from '../../lib/utils';
import { loadThemeAssets, resolveMode } from '../../themes/apply';
import {
  THEMES,
  optionAttributes,
  resolveThemeOptions,
  type ModeSetting,
  type ThemeMeta,
  type ThemeOptionValue,
} from '../../themes/registry';
import {
  BackdropLayer,
  MessageOrnamentLayer,
  SignatureScope,
  useSignature,
} from '../../themes/signature';

const MODES: ModeSetting[] = ['light', 'dark', 'system'];

/**
 * 设置页「外观」：一排活的预览卡（DESIGN §2.3）。
 * 每张卡用 `data-theme` / `data-mode` / `data-opt-*` 作用域真实渲染该世界的缩影
 * （背景层 + 两条消息与装饰层 + 输入框 + 主按钮，带与应用里相同的 data-part），点选即切换；
 * 下方的模式切换只在该主题同时提供明暗时出现，再下方是该主题自己的选项开关。
 */
export function AppearanceSettings() {
  const { t, i18n } = useTranslation();
  const themeId = useUiStore((s) => s.themeId);
  const mode = useUiStore((s) => s.mode);
  const themeOptions = useUiStore((s) => s.themeOptions);
  const setThemeId = useUiStore((s) => s.setThemeId);
  const setMode = useUiStore((s) => s.setMode);
  const setThemeOption = useUiStore((s) => s.setThemeOption);

  // 预览卡要真实渲染，所以把所有主题的 CSS 都预热一遍
  useEffect(() => {
    for (const theme of THEMES) void loadThemeAssets(theme.id);
  }, []);

  const zh = i18n.language.startsWith('zh');
  const current = THEMES.find((theme) => theme.id === themeId) ?? THEMES[0];
  const bothModes = (current?.modes.length ?? 0) > 1;
  const currentOptions = current?.options ?? [];
  const currentValues = current ? resolveThemeOptions(current, themeOptions[current.id]) : {};

  return (
    <div className="space-y-8">
      <SettingsSection title={t('appearance.world')} hint={t('appearance.worldHint')}>
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {THEMES.map((theme) => (
            <li key={theme.id}>
              <ThemeCard
                theme={theme}
                selected={theme.id === themeId}
                mode={mode}
                options={resolveThemeOptions(theme, themeOptions[theme.id])}
                label={zh ? theme.name.zh : theme.name.en}
                tagline={zh ? theme.tagline.zh : theme.tagline.en}
                selectLabel={t('appearance.select')}
                onSelect={() => setThemeId(theme.id)}
              />
            </li>
          ))}
        </ul>
      </SettingsSection>

      {bothModes && (
        <SettingsSection title={t('appearance.mode')} hint={t('appearance.modeHint')}>
          <div className="flex flex-wrap gap-2">
            {MODES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                // 当前项只用 1px 墨线描边：一个视图里唯一的实心物件留给主动作
                className={cn(
                  'action-quiet focus-ring cursor-pointer px-3 py-1.5 text-sm',
                  mode === value ? 'border-ink font-medium text-ink' : 'text-ink-2',
                )}
              >
                {t(`appearance.modes.${value}`)}
              </button>
            ))}
          </div>
        </SettingsSection>
      )}

      {current && currentOptions.length > 0 && (
        <SettingsSection title={t('appearance.options')} hint={t('appearance.optionsHint')}>
          <div className="divide-y divide-edge">
            {currentOptions.map((option) => (
              <SwitchRow
                key={option.key}
                title={zh ? option.label.zh : option.label.en}
                checked={currentValues[option.key] === 'on'}
                onChange={(checked) =>
                  setThemeOption(current.id, option.key, checked ? 'on' : 'off')
                }
              />
            ))}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}

function ThemeCard({
  theme,
  selected,
  mode,
  options,
  label,
  tagline,
  selectLabel,
  onSelect,
}: {
  theme: ThemeMeta;
  selected: boolean;
  mode: ModeSetting;
  options: Record<string, ThemeOptionValue>;
  label: string;
  tagline: string;
  selectLabel: string;
  onSelect: () => void;
}) {
  const previewMode = resolveMode(theme, mode);
  return (
    <div
      data-part="theme-card"
      data-active={selected}
      className={cn(
        'rounded-panel relative overflow-hidden border transition-colors',
        selected ? 'border-accent' : 'edge-rule hover:edge-rule-strong',
      )}
    >
      {/*
       * 真实渲染：data-theme / data-mode / data-opt-* 作用域到这一块。
       * relative + isolate + overflow-hidden：背景层（absolute、-z-10）裁在卡内、垫在内容下。
       */}
      <div
        data-theme={theme.id}
        data-mode={previewMode}
        {...optionAttributes(options)}
        data-part="theme-preview"
        className="surface-canvas relative isolate overflow-hidden"
      >
        <SignatureScope themeId={theme.id}>
          <BackdropLayer scope="preview" />
          <ThemePreview label={label} />
        </SignatureScope>
      </div>
      <div className="edge-rule border-t px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
        </div>
        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-2">{tagline}</p>
      </div>
      {/* 整张卡的点击区：盖在最上层，预览里的按钮只是画面，不接事件 */}
      <button
        type="button"
        aria-pressed={selected}
        aria-label={`${selectLabel} · ${label}`}
        title={selectLabel}
        onClick={onSelect}
        className="focus-ring-inset absolute inset-0 z-10 cursor-pointer"
      />
    </div>
  );
}

/** 迷你版对话：两条消息（带装饰层）+ 输入框 + 主按钮，data-part 与应用里一致 */
function ThemePreview({ label }: { label: string }) {
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
