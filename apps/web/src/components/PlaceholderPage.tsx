import { useTranslation } from 'react-i18next';

/** 里程碑占位页：M0 仅提供外壳与双语切换 */
export function PlaceholderPage({ titleKey }: { titleKey: string }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold">{t(titleKey)}</h1>
      <p className="mt-4 rounded-lg border border-dashed border-border p-8 text-center text-muted-foreground">
        {t('common.comingSoon')}
      </p>
    </div>
  );
}
