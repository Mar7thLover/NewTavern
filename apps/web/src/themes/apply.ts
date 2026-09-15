import {
  getTheme,
  resolveThemeOptions,
  type ModeSetting,
  type ThemeMeta,
  type ThemeMode,
  type ThemeOptionValue,
} from './registry';

/** 每个主题各自存的选项：`{ yuye: { rain: 'off' } }` */
export type StoredThemeOptions = Readonly<
  Record<string, Readonly<Record<string, ThemeOptionValue>>>
>;

/**
 * 主题 CSS 按需加载：`themes/<id>/theme.css` 由 Vite 切成独立 chunk，
 * 切到哪个主题才下载哪个，并且只下载一次。
 */
const cssLoaders = import.meta.glob('./*/theme.css');

const loadedCss = new Set<string>();
const loadedFonts = new Set<string>();
const pending = new Map<string, Promise<void>>();

function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** 设置里的模式 → 该主题实际能用的模式（不支持就回落到 defaultMode） */
export function resolveMode(theme: ThemeMeta, mode: ModeSetting): ThemeMode {
  const wanted: ThemeMode = mode === 'system' ? (prefersDark() ? 'dark' : 'light') : mode;
  return theme.modes.includes(wanted) ? wanted : theme.defaultMode;
}

/** 加载某个主题的 CSS 与字体（幂等，可重复调用；预览卡也用它预热） */
export function loadThemeAssets(themeId: string): Promise<void> {
  const existing = pending.get(themeId);
  if (existing) return existing;

  const theme = getTheme(themeId);
  const tasks: Promise<unknown>[] = [];

  const key = `./${theme.id}/theme.css`;
  const loader = cssLoaders[key];
  if (loader && !loadedCss.has(theme.id)) {
    loadedCss.add(theme.id);
    tasks.push(loader());
  }
  if (theme.loadFonts && !loadedFonts.has(theme.id)) {
    loadedFonts.add(theme.id);
    tasks.push(theme.loadFonts());
  }

  const promise = Promise.all(tasks).then(() => undefined);
  pending.set(theme.id, promise);
  return promise;
}

/** 把主题选项写成 `data-opt-<key>`；先清掉旧主题留下的全部 `data-opt-*` */
function applyOptions(root: HTMLElement, theme: ThemeMeta, stored: StoredThemeOptions | undefined) {
  for (const name of root.getAttributeNames()) {
    if (name.startsWith('data-opt-')) root.removeAttribute(name);
  }
  const values = resolveThemeOptions(theme, stored?.[theme.id]);
  for (const [key, value] of Object.entries(values)) root.setAttribute(`data-opt-${key}`, value);
}

/** 写 `<html data-theme data-mode data-opt-*>` 并触发资源加载；返回实际生效的模式 */
export function applyTheme(
  themeId: string,
  mode: ModeSetting,
  options?: StoredThemeOptions,
): ThemeMode {
  const theme = getTheme(themeId);
  const resolved = resolveMode(theme, mode);
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.dataset.mode = resolved;
  applyOptions(root, theme, options);
  // 让原生控件（滚动条、表单）跟着换
  root.style.colorScheme = resolved;
  void loadThemeAssets(theme.id);
  return resolved;
}

/** 跟随系统明暗（mode === 'system' 时挂上） */
export function watchSystemMode(onChange: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/**
 * 读一个时长槽位（`--dur-panel` …）给 framer-motion 用（秒）。
 * 动效也是世界的一部分，组件不该写死 0.2s。
 */
export function slotSeconds(name: string, fallback = 0.16): number {
  if (typeof window === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return raw.endsWith('ms') ? value / 1000 : value;
}
