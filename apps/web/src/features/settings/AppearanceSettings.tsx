import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsSection } from './shared';
import { useUiStore } from '../../app/store/ui';
import { SwitchRow } from '../../components/ui/switch';
import { cn } from '../../lib/utils';
import { loadThemeAssets, resolveMode } from '../../themes/apply';
import { VariantRow } from '../../themes/editor/VariantRow';
import { ThemePreviewRoot } from '../../themes/preview';
import {
  THEMES,
  resolveThemeOptions,
  type ModeSetting,
  type ThemeMeta,
  type ThemeOptionValue,
} from '../../themes/registry';
import { BackgroundLibrary } from '../backgrounds/BackgroundPicker';
import { SpriteSettings } from '../sprites/SpriteSettings';

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
  const richBlocks = useUiStore((s) => s.richBlocks);
  const cardHtml = useUiStore((s) => s.cardHtml);
  const setRichBlocks = useUiStore((s) => s.setRichBlocks);
  const setCardHtml = useUiStore((s) => s.setCardHtml);
  const cardRuntime = useUiStore((s) => s.cardRuntime);
  const setCardRuntime = useUiStore((s) => s.setCardRuntime);
  const variantId = useUiStore((s) => s.variantId);
  const backdropInMinimalWorlds = useUiStore((s) => s.backdropInMinimalWorlds);
  const setBackdropInMinimalWorlds = useUiStore((s) => s.setBackdropInMinimalWorlds);
  const veilWorlds = THEMES.filter((theme) => theme.backdrop === 'veil').map((theme) =>
    i18n.language.startsWith('zh') ? theme.name.zh : theme.name.en,
  );

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
                variantId={theme.id === themeId ? variantId : null}
                label={zh ? theme.name.zh : theme.name.en}
                tagline={zh ? theme.tagline.zh : theme.tagline.en}
                selectLabel={t('appearance.select')}
                onSelect={() => setThemeId(theme.id)}
              />
            </li>
          ))}
        </ul>
      </SettingsSection>

      {current && (
        <SettingsSection
          title={t('themeVariants.title', { world: zh ? current.name.zh : current.name.en })}
          hint={t('themeVariants.hint')}
        >
          <VariantRow theme={current} />
        </SettingsSection>
      )}

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

      <SettingsSection title={t('appearance.reading')} hint={t('appearance.readingHint')}>
        <div className="divide-y divide-edge">
          <SwitchRow
            title={t('appearance.richBlocks')}
            hint={t('appearance.richBlocksHint')}
            checked={richBlocks}
            onChange={setRichBlocks}
          />
          <SwitchRow
            title={t('appearance.cardHtml')}
            hint={t('appearance.cardHtmlHint')}
            checked={cardHtml}
            onChange={setCardHtml}
          />
          <SwitchRow
            title={t('appearance.cardRuntime')}
            hint={t('appearance.cardRuntimeHint')}
            checked={cardRuntime}
            onChange={setCardRuntime}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('backgrounds.settingsTitle')} hint={t('backgrounds.settingsHint')}>
        <BackgroundLibrary />
        <div className="divide-y divide-edge">
          <SwitchRow
            title={t('backgrounds.minimalWorlds', { worlds: veilWorlds.join(zh ? '、' : ' / ') })}
            hint={t('backgrounds.minimalWorldsHint')}
            checked={backdropInMinimalWorlds}
            onChange={setBackdropInMinimalWorlds}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('sprites.settingsTitle')} hint={t('sprites.settingsHint')}>
        <SpriteSettings />
      </SettingsSection>

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
  variantId,
  label,
  tagline,
  selectLabel,
  onSelect,
}: {
  theme: ThemeMeta;
  selected: boolean;
  mode: ModeSetting;
  options: Record<string, ThemeOptionValue>;
  variantId: string | null;
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
      {/* 真实渲染：data-theme / data-mode / data-opt-*（当前世界再带上选中的变体）作用域到这一块 */}
      <ThemePreviewRoot
        theme={theme}
        mode={previewMode}
        options={options}
        {...(variantId ? { variantId } : {})}
        label={label}
      />
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
