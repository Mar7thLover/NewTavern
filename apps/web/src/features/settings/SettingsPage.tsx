import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Language } from '@newtavern/i18n';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { AppearanceSettings } from './AppearanceSettings';
import { CardsSettings } from './CardsSettings';
import { GlobalSystemPromptSettings } from './GlobalSystemPromptSettings';
import { RegexSettings } from './RegexSettings';
import { WorldInfoSettings } from './WorldInfoSettings';
import { SettingsSection } from './shared';
import { ScriptsSettings } from '../scripts/ScriptsSettings';
import { useUiStore } from '../../app/store/ui';
import { formatBytes } from '../../components/AttachmentFiles';
import { Button } from '../../components/ui/button';
import { Switch } from '../../components/ui/switch';
import { useAssetsGc } from '../../lib/api';
import { cn } from '../../lib/utils';

const SECTIONS = [
  'general',
  'appearance',
  'worldInfo',
  'globalSystemPrompt',
  'regex',
  'cards',
  'scripts',
  'storage',
] as const;
type SectionKey = (typeof SECTIONS)[number];

/** 分区标题的 i18n 键：「存储」在 M4 的 settings.storage.* 命名空间里 */
const sectionLabelKey = (key: SectionKey) =>
  key === 'storage' ? 'settings.storage.title' : `settings.sections.${key}`;

/** 设置页：桌面左侧分区导航 + 右侧内容，窄屏顶部页签 */
export function SettingsPage() {
  const { t } = useTranslation();
  // 分区记在 ?section= 里：可直接链接到「外观」，截图脚本也不用点击
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('section');
  const section: SectionKey = SECTIONS.find((key) => key === requested) ?? 'general';
  const setSection = (key: SectionKey) =>
    setSearchParams(key === 'general' ? {} : { section: key });

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 md:flex-row">
      <h1 className="sr-only">{t('settings.title')}</h1>

      <nav
        aria-label={t('settings.title')}
        data-part="settings-nav"
        className="-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 md:mx-0 md:w-48 md:flex-col md:overflow-visible md:px-0"
      >
        {SECTIONS.map((key) => (
          <button
            key={key}
            type="button"
            data-part="settings-nav-item"
            data-active={section === key}
            aria-current={section === key ? 'page' : undefined}
            onClick={() => setSection(key)}
            className={cn(
              'rounded-control focus-ring cursor-pointer px-2.5 py-1.5 text-sm whitespace-nowrap transition-colors md:text-left',
              section === key ? 'font-medium text-accent' : 'text-ink-story hover:text-ink',
            )}
          >
            {t(sectionLabelKey(key))}
          </button>
        ))}
      </nav>

      <div className="min-w-0 flex-1 space-y-8">
        {section === 'general' && <GeneralSettings />}
        {section === 'appearance' && <AppearanceSettings />}
        {section === 'worldInfo' && <WorldInfoSettings />}
        {section === 'globalSystemPrompt' && <GlobalSystemPromptSettings />}
        {section === 'regex' && <RegexSettings />}
        {section === 'cards' && <CardsSettings />}
        {section === 'scripts' && <ScriptsSettings />}
        {section === 'storage' && <StorageSettings />}
      </div>
    </div>
  );
}

function GeneralSettings() {
  const { t } = useTranslation();
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);
  const developerMode = useUiStore((s) => s.developerMode);
  const setDeveloperMode = useUiStore((s) => s.setDeveloperMode);

  return (
    <>
      <SettingsSection title={t('common.language')} hint={t('settings.languageDescription')}>
        <div className="flex gap-2">
          {SUPPORTED_LANGUAGES.map((lang) => (
            // 当前项只用 1px 墨线描边：一个视图里唯一的实心物件留给主动作
            <Button
              key={lang}
              variant="outline"
              size="sm"
              aria-pressed={language === lang}
              className={cn(language === lang ? 'border-ink text-ink' : 'text-ink-2')}
              onClick={() => setLanguage(lang as Language)}
            >
              {LANGUAGE_LABELS[lang]}
            </Button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.developerMode')} hint={t('settings.developerModeHint')}>
        <Switch
          checked={developerMode}
          label={t('settings.developerMode')}
          onChange={setDeveloperMode}
        />
      </SettingsSection>
    </>
  );
}

/** 存储：清理没人用的上传文件与生成图片（M4 契约 §3.4 → `POST /api/assets/gc`） */
function StorageSettings() {
  const { t, i18n } = useTranslation();
  const gc = useAssetsGc();

  return (
    <SettingsSection title={t('settings.storage.title')} hint={t('settings.storage.hint')}>
      <div data-part="storage-gc" className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button variant="outline" size="sm" disabled={gc.isPending} onClick={() => gc.mutate()}>
          {gc.isPending ? t('settings.storage.cleaning') : t('settings.storage.clean')}
        </Button>
        <p role="status" aria-live="polite" className="min-w-0 text-xs leading-relaxed">
          {gc.isError ? (
            <span className="text-danger">
              {t('settings.storage.failed', {
                message: gc.error instanceof Error ? gc.error.message : String(gc.error),
              })}
            </span>
          ) : gc.data ? (
            <span className="text-ink-2">
              {gc.data.removed === 0
                ? t('settings.storage.nothing')
                : t('settings.storage.result', {
                    total: gc.data.removed,
                    size: formatBytes(gc.data.freedBytes, i18n.language),
                  })}
            </span>
          ) : null}
        </p>
      </div>
    </SettingsSection>
  );
}
