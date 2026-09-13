import type { ThemeSetting } from '../../app/store/ui';

/** 根据设置应用主题（写 <html> 的 dark class）。system 跟随 prefers-color-scheme。 */
export function applyTheme(theme: ThemeSetting): void {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

/** 跟随系统主题变化（theme === 'system' 时调用） */
export function watchSystemTheme(onChange: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
