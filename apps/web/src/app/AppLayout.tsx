import { Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useLocation, useMatch } from 'react-router';

import { useUiStore } from './store/ui';
import { Button } from '../components/ui/button';
import { Toaster } from '../components/ui/toast';
import { backgroundUrl, useBackdropStore } from '../features/backgrounds/api';
import { CommandPalette, CommandPaletteTrigger } from '../features/palette/CommandPalette';
import { useServerHealth } from '../lib/api';
import { cn } from '../lib/utils';
import { applyTheme, watchSystemMode } from '../themes/apply';
import { useRegisterThemeVariants } from '../themes/editor/variants-api';
import { getTheme } from '../themes/registry';
import { BackdropLayer } from '../themes/signature';

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
  const themeId = useUiStore((s) => s.themeId);
  const mode = useUiStore((s) => s.mode);
  const themeOptions = useUiStore((s) => s.themeOptions);
  const variantId = useUiStore((s) => s.variantId);
  const backdropInMinimalWorlds = useUiStore((s) => s.backdropInMinimalWorlds);
  const backdropAssetId = useBackdropStore((s) => s.assetId);
  // 变体注册要排在 applyTheme 之前（同一组件里 effect 按声明顺序执行）
  const variants = useRegisterThemeVariants();
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);
  const health = useServerHealth();
  // 对话页、写作项目页自己管三栏与滚动，外壳不加内边距、不撑高
  const pathname = useLocation().pathname;
  const fullBleed =
    pathname === '/' ||
    /^\/writing\/[^/]+/.test(pathname) ||
    /^\/studio\/[^/]+\/[^/]+/.test(pathname);

  useEffect(() => {
    applyTheme(themeId, mode, themeOptions, variantId);
    if (mode === 'system') {
      return watchSystemMode(() => applyTheme(themeId, mode, themeOptions, variantId));
    }
  }, [themeId, mode, themeOptions, variantId, variants]);

  // 用户背景（M4（二）§A.3）：素 / 书斋这类 `backdrop: 'veil'` 的世界默认不显示
  const showBackdrop =
    backdropAssetId !== null && (getTheme(themeId).backdrop !== 'veil' || backdropInMinimalWorlds);

  return (
    <div
      data-part="app-shell"
      // isolate：背景层（-z-10）画在外壳底色之上、全部内容之下
      className={cn(
        'surface-canvas relative isolate flex',
        fullBleed ? 'h-dvh overflow-hidden' : 'min-h-dvh',
      )}
    >
      <BackdropLayer
        scope="app"
        imageUrl={showBackdrop && backdropAssetId ? backgroundUrl(backdropAssetId) : null}
        treatment={getTheme(themeId).backdrop ?? 'world'}
      />

      <aside
        data-part="sidebar"
        className="surface-panel edge-rule hidden w-52 shrink-0 flex-col border-e p-5 md:flex"
      >
        <div data-part="brand" className="mb-8">
          <div className="font-display text-base font-medium tracking-tight">{t('app.name')}</div>
          <div className="mt-0.5 text-[11px] text-ink-3">{t('app.tagline')}</div>
        </div>
        <nav data-part="nav" data-variant="sidebar" className="flex flex-col gap-0.5">
          {NAV_ITEMS.map(({ to, key }) => (
            <NavItem
              key={to}
              to={to}
              label={t(`nav.${key}`)}
              className="px-2.5 py-1.5"
              idleClassName="text-ink-story hover:text-ink"
            />
          ))}
        </nav>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          data-part="app-header"
          className="edge-rule flex items-center justify-between gap-3 border-b px-4 py-2"
        >
          {/* min-w-0：不加的话 flex 子项按 max-content 撑宽，窄屏整页横向溢出 */}
          <nav
            data-part="nav"
            data-variant="compact"
            className="flex min-w-0 gap-1 overflow-x-auto md:hidden"
          >
            {NAV_ITEMS.map(({ to, key }) => (
              <NavItem
                key={to}
                to={to}
                label={t(`nav.${key}`)}
                className="px-2 py-1 whitespace-nowrap"
                idleClassName="text-ink-2"
              />
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            {/* 命令面板入口：键盘用户有 Ctrl/⌘ + K，触屏靠这里 */}
            <CommandPaletteTrigger />
            <span
              data-part="server-status"
              data-online={health.isSuccess}
              className={cn(
                'inline-flex items-center gap-1.5 text-[11px]',
                health.isSuccess ? 'text-ink-3' : 'text-danger',
              )}
            >
              {/* 状态点只是一圈线（素没有填充块）；颜色跟文字走 */}
              <span className="rounded-pill size-1.5 border border-current" />
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

        <main
          data-part="main"
          className={cn('min-w-0 flex-1', fullBleed ? 'min-h-0' : 'p-5 md:p-8')}
        >
          {/* 页面是按路由拆分的 chunk：首次进入时的轻量占位；之后的导航在过渡里完成，停留在旧页面直到新页面就绪 */}
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <CommandPalette navItems={NAV_ITEMS} />
      {/* 应用级提示条（M5（三）§3.3）：右下，窄屏顶部 */}
      <Toaster />
    </div>
  );
}

/** 等页面 chunk 时的占位：先空着，稍等仍未就绪才出现一行「加载中」（快的时候什么也不闪） */
function RouteFallback() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 240);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div
      data-part="route-fallback"
      role="status"
      aria-live="polite"
      className="flex h-full min-h-40 items-center justify-center"
    >
      {visible && <span className="pulse-live text-sm text-ink-3">{t('common.loading')}</span>}
    </div>
  );
}

/** 主导航的一项：`[data-part='nav-item'][data-active]`，当前项橙字 */
function NavItem({
  to,
  label,
  className,
  idleClassName,
}: {
  to: string;
  label: string;
  className: string;
  idleClassName: string;
}) {
  const active = useMatch({ path: to, end: to === '/' }) !== null;
  return (
    <NavLink
      to={to}
      end={to === '/'}
      data-part="nav-item"
      data-active={active}
      className={cn(
        'rounded-control focus-ring text-sm transition-colors',
        className,
        active ? 'font-medium text-accent' : idleClassName,
      )}
    >
      {label}
    </NavLink>
  );
}
