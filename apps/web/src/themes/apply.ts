import {
  findVariant,
  getTheme,
  listVariants,
  resolveThemeOptions,
  type ModeSetting,
  type ThemeMeta,
  type ThemeMode,
  type ThemeOptionValue,
} from './registry';
import { variantCss, variantFonts, type ThemeVariant } from './variants';

/** 每个主题各自存的选项：`{ yuye: { rain: 'off' } }` */
export type StoredThemeOptions = Readonly<
  Record<string, Readonly<Record<string, ThemeOptionValue>>>
>;

/**
 * 主题 CSS 按需加载：`themes/<id>/theme.css` 由 Vite 切成独立 chunk，
 * 切到哪个主题才下载哪个，并且只下载一次。
 */
const cssLoaders = import.meta.glob('./*/theme.css');
/** 背景与立绘框（M4（二）§A §B.3）：每个世界自己的 `media.css`，与 theme.css 一起按需加载 */
const mediaLoaders = import.meta.glob('./*/media.css');

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
    const media = mediaLoaders[`./${theme.id}/media.css`];
    if (media) tasks.push(media());
  }
  if (theme.loadFonts && !loadedFonts.has(theme.id)) {
    loadedFonts.add(theme.id);
    tasks.push(theme.loadFonts());
  }

  const promise = Promise.all(tasks).then(() => undefined);
  pending.set(theme.id, promise);
  return promise;
}

/** 把主题选项写成 `data-opt-<key>`；先清掉旧主题留下的全部 `data-opt-*`。变体的 options 优先 */
function applyOptions(
  root: HTMLElement,
  theme: ThemeMeta,
  stored: StoredThemeOptions | undefined,
  variant: ThemeVariant | undefined,
) {
  for (const name of root.getAttributeNames()) {
    if (name.startsWith('data-opt-')) root.removeAttribute(name);
  }
  const values = resolveThemeOptions(theme, { ...stored?.[theme.id], ...variant?.options });
  for (const [key, value] of Object.entries(values)) root.setAttribute(`data-opt-${key}`, value);
}

const VARIANT_STYLE_ID = 'nt-theme-variant';
const DRAFT_STYLE_ID = 'nt-theme-variant-draft';
const loadedVariantFonts = new Set<string>();

function styleElement(id: string): HTMLStyleElement {
  let element = document.getElementById(id) as HTMLStyleElement | null;
  if (!element) {
    element = document.createElement('style');
    element.id = id;
    document.head.append(element);
  }
  return element;
}

/**
 * 把已注册的全部变体写进 `<style id="nt-theme-variant">`（M4（二）§C.2）。
 * 选择器带 `[data-variant]`，没选中的不生效；外观页的变体预览卡也靠它渲染。
 */
export function syncVariantStyles(): void {
  if (typeof document === 'undefined') return;
  const css = listVariants()
    .map((variant) => variantCss(variant))
    .filter(Boolean)
    .join('\n');
  const element = styleElement(VARIANT_STYLE_ID);
  if (element.textContent !== css) element.textContent = css;
}

/** 变体编辑器的实时预览：草稿单独一段样式（不进 settings，关掉编辑器时传 null 清掉） */
export function setDraftVariantStyle(variant: ThemeVariant | null): void {
  if (typeof document === 'undefined') return;
  const element = styleElement(DRAFT_STYLE_ID);
  element.textContent = variant ? variantCss(variant) : '';
  if (variant) loadVariantFonts(variant);
}

function loadVariantFonts(variant: ThemeVariant): void {
  for (const font of variantFonts(variant)) {
    if (!font.load || loadedVariantFonts.has(font.id)) continue;
    loadedVariantFonts.add(font.id);
    void font.load();
  }
}

/** 写 `<html data-theme data-mode data-opt-* data-variant>` 并触发资源加载；返回实际生效的模式 */
export function applyTheme(
  themeId: string,
  mode: ModeSetting,
  options?: StoredThemeOptions,
  variantId?: string | null,
): ThemeMode {
  const theme = getTheme(themeId);
  const resolved = resolveMode(theme, mode);
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.dataset.mode = resolved;
  // 变体只在 base 与当前世界一致时生效
  const found = findVariant(variantId);
  const variant = found && found.base === theme.id ? found : undefined;
  if (variant) {
    root.dataset.variant = variant.id;
    syncVariantStyles();
    loadVariantFonts(variant);
  } else {
    delete root.dataset.variant;
  }
  applyOptions(root, theme, options, variant);
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
