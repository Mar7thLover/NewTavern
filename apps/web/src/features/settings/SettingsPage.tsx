import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Language } from '@newtavern/i18n';
import { useTranslation } from 'react-i18next';

import { useUiStore, type ThemeSetting } from '../../app/store/ui';
import { Button } from '../../components/ui/button';

const THEMES: { value: ThemeSetting; labelKey: string }[] = [
  { value: 'light', labelKey: 'settings.themeLight' },
  { value: 'dark', labelKey: 'settings.themeDark' },
  { value: 'system', labelKey: 'settings.themeSystem' },
];

export function SettingsPage() {
  const { t } = useTranslation();
  const { language, theme, setLanguage, setTheme } = useUiStore();

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <h1 className="text-2xl font-bold">{t('nav.settings')}</h1>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t('common.language')}</h2>
        <p className="text-sm text-muted-foreground">{t('settings.languageDescription')}</p>
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
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground">{t('settings.theme')}</h2>
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
      </section>
    </div>
  );
}
