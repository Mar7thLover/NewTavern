import { useTranslation } from 'react-i18next';

/** 里程碑占位页：M0 仅提供外壳与双语切换 */
export function PlaceholderPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-display text-[28px] leading-tight font-light tracking-tight">
        {t(titleKey)}
      </h1>
      <p className="rounded-panel edge-rule mt-4 border p-8 text-center text-ink-2">
        {t('common.comingSoon')}
      </p>
    </div>
  );
}
