import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Language } from '@newtavern/i18n';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GlobalSystemPromptSettings } from './GlobalSystemPromptSettings';
import { RegexSettings } from './RegexSettings';
import { WorldInfoSettings } from './WorldInfoSettings';
import { SettingsSection } from './shared';
import { useUiStore, type ThemeSetting } from '../../app/store/ui';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';

const THEMES: { value: ThemeSetting; labelKey: string }[] = [
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
  { value: 'system', labelKey: 'settings.themeSystem' },
];

const SECTIONS = ['general', 'worldInfo', 'globalSystemPrompt', 'regex'] as const;
type SectionKey = (typeof SECTIONS)[number];

/** 设置页：桌面左侧分区导航 + 右侧内容，窄屏顶部页签 */
export function SettingsPage() {
  const { t } = useTranslation();
  const [section, setSection] = useState<SectionKey>('general');

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 md:flex-row">
      <h1 className="sr-only">{t('settings.title')}</h1>

      <nav
        aria-label={t('settings.title')}
        className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 md:mx-0 md:w-48 md:flex-col md:overflow-visible md:px-0"
      >
        {SECTIONS.map((key) => (
          <button
            key={key}
            type="button"
            aria-current={section === key ? 'page' : undefined}
            onClick={() => setSection(key)}
            className={cn(
              'cursor-pointer rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-left',
              section === key
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground',
            )}
          >
            {t(`settings.sections.${key}`)}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 space-y-8">
        {section === 'general' && <GeneralSettings />}
        {section === 'worldInfo' && <WorldInfoSettings />}
        {section === 'globalSystemPrompt' && <GlobalSystemPromptSettings />}
        {section === 'regex' && <RegexSettings />}
      </div>
    </div>
  );
}

function GeneralSettings() {
  const { t } = useTranslation();
  const { language, theme, setLanguage, setTheme } = useUiStore();

  return (
    <div className="space-y-8">
      <SettingsSection title={t('common.language')} hint={t('settings.languageDescription')}>
        <div className="flex gap-2">
          {SUPPORTED_LANGUAGES.map((lang) => (
            <Button
              key={lang}
              variant={language === lang ? 'default' : 'outline'}
              size="sm"
              onClick={() => setLanguage(lang as Language)}
            >
              {LANGUAGE_LABELS[lang]}
            </Button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.theme')}>
        <div className="flex gap-2">
          {THEMES.map(({ value, labelKey }) => (
            <Button
              key={value}
              variant={theme === value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setTheme(value)}
            >
              {t(labelKey)}
            </Button>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
