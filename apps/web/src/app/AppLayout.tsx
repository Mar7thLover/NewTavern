import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet } from 'react-router';

import { useUiStore } from './store/ui';
import { Button } from '../components/ui/button';
import { applyTheme, watchSystemTheme } from '../components/ui/theme';
import { useServerHealth } from '../lib/api';
import { cn } from '../lib/utils';

const NAV_ITEMS = [
  { to: '/', key: 'chat' },
  { to: '/characters', key: 'characters' },
  { to: '/presets', key: 'presets' },
  { to: '/lorebooks', key: 'lorebooks' },
  { to: '/personas', key: 'personas' },
  { to: '/studio', key: 'studio' },
  { to: '/writing', key: 'writing' },
  { to: '/connections', key: 'connections' },
  { to: '/migration', key: 'migration' },
  { to: '/settings', key: 'settings' },
] as const;

export function AppLayout() {
  const { t } = useTranslation();
  const theme = useUiStore((s) => s.theme);
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);
  const health = useServerHealth();

  useEffect(() => {
    applyTheme(theme);
    if (theme === 'system') return watchSystemTheme(() => applyTheme('system'));
  }, [theme]);

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-card p-4 md:flex">
        <div className="mb-6">
          <div className="text-lg font-bold">{t('app.name')}</div>
          <div className="text-xs text-muted-foreground">{t('app.tagline')}</div>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV_ITEMS.map(({ to, key }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground',
                )
              }
            >
              {t(`nav.${key}`)}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
          <nav className="flex gap-1 overflow-x-auto md:hidden">
            {NAV_ITEMS.map(({ to, key }) => (
              <NavLink
                key={to}
                to={to}
                end={to === '/'}
                className={({ isActive }) =>
                  cn(
                    'whitespace-nowrap rounded-md px-2 py-1 text-sm',
                    isActive ? 'bg-accent font-medium' : 'text-muted-foreground',
                  )
                }
              >
                {t(`nav.${key}`)}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 text-xs',
                health.isSuccess ? 'text-muted-foreground' : 'text-destructive',
              )}
            >
              <span
                className={cn(
                  'size-2 rounded-full',
                  health.isSuccess ? 'bg-green-500' : 'bg-destructive animate-pulse',
                )}
              />
              {health.isSuccess ? t('common.online') : t('common.offline')}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLanguage(language === 'zh-CN' ? 'en' : 'zh-CN')}
            >
              {language === 'zh-CN' ? 'EN' : '中文'}
            </Button>
          </div>
        </header>

        <main className="min-w-0 flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
