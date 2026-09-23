import type { ThemeSignature } from './signature';
import type { ThemeVariant } from './variants';

/** 一个主题支持的模式 */
export type ThemeMode = 'light' | 'dark';

/** 设置里存的模式（`system` 跟随系统，主题不支持时回落到 defaultMode） */
export type ModeSetting = ThemeMode | 'system';

/** 双语文案：主题名与一句话由主题自带，不进 i18n 词典 */
export interface ThemeText {
  zh: string;
  en: string;
}

/** 主题选项的取值：布尔开关 */
export type ThemeOptionValue = 'on' | 'off';

/**
 * 主题选项（布尔开关，如雨夜的「雨」）。
 * 当前值写在 `<html data-opt-<key>="on|off">` 与预览卡根节点上，主题 CSS 用属性选择器响应。
 */
export interface ThemeOption {
  /** 只用小写字母、数字与连字符：它会变成 `data-opt-<key>` 属性名 */
  key: string;
  label: ThemeText;
  default: ThemeOptionValue;
}

export interface ThemeMeta {
  /** 目录名，同时是 `<html data-theme>` 的值 */
  id: string;
  name: ThemeText;
  /** 一句话把它描述成一个地方或一件物品（DESIGN §一-1） */
  tagline: ThemeText;
  modes: ThemeMode[];
  defaultMode: ThemeMode;
  /** 声明用到的字体栈（只作说明与预览卡用；实际赋值在 theme.css 的 --font-*） */
  fonts: { story: string; ui: string; display: string };
  /** 预览卡在主题 CSS 尚未加载时的四个代表色（CSS 颜色字面量） */
  preview: { canvas: string; reading: string; ink: string; primary: string };
  /** 记忆物件；缺的用 themes/signature.tsx 的 `_default`（=「素」） */
  signature?: Partial<ThemeSignature>;
  /** 按需加载 web 字体（npm 分片包），只会被调用一次 */
  loadFonts?: () => Promise<void>;
  /** 主题选项（外观页在模式切换下方渲染成开关） */
  options?: ThemeOption[];
  /**
   * 用户背景（M4（二）§A）在这个世界里怎么出现：
   * - `world`（缺省）：由世界自己的 `media.css` 按它的材质处理（隔冰、隔湿玻璃、窗外景……）；
   * - `veil`：默认不显示；外观设置里打开「在素 / 书斋里也显示背景」后，只盖一层按模式调色的淡化遮罩。
   */
  backdrop?: 'world' | 'veil';
}

/**
 * 自动发现主题：每个主题只需新建 `themes/<id>/theme.ts` 并默认导出 `ThemeMeta`，
 * 不用改任何共享文件。
 */
const modules = import.meta.glob<{ default: ThemeMeta }>('./*/theme.ts', { eager: true });

function collect(): ThemeMeta[] {
  const list: ThemeMeta[] = [];
  for (const module of Object.values(modules)) {
    const meta = module.default;
    if (meta && typeof meta.id === 'string') list.push(meta);
  }
  // 稳定顺序：id 字母序，避免 glob 顺序随文件系统变化
  return list.sort((a, b) => a.id.localeCompare(b.id));
}

export const THEMES: readonly ThemeMeta[] = collect();

/** 引擎兜底主题：「素」既是最小形态，也是 slots.css 的回退值 */
export const DEFAULT_THEME_ID = 'su';

export function findTheme(id: string): ThemeMeta | undefined {
  return THEMES.find((theme) => theme.id === id);
}

/** 取主题；id 不存在（主题被删 / 旧设置）时回落到「素」，再不行取第一个 */
export function getTheme(id: string): ThemeMeta {
  const found = findTheme(id) ?? findTheme(DEFAULT_THEME_ID) ?? THEMES[0];
  if (!found) throw new Error('themes/registry: 没有发现任何主题');
  return found;
}

/** 某主题全部选项的实际取值：存过的用存的，没存过的用 default；不认识的 key 丢掉 */
export function resolveThemeOptions(
  theme: ThemeMeta,
  stored: Readonly<Record<string, ThemeOptionValue>> | undefined,
): Record<string, ThemeOptionValue> {
  const values: Record<string, ThemeOptionValue> = {};
  for (const option of theme.options ?? []) {
    const saved = stored?.[option.key];
    values[option.key] = saved === 'on' || saved === 'off' ? saved : option.default;
  }
  return values;
}

/** `{ rain: 'off' }` → `{ 'data-opt-rain': 'off' }`，给预览卡这类局部作用域根展开用 */
export function optionAttributes(
  values: Readonly<Record<string, ThemeOptionValue>>,
): Record<string, ThemeOptionValue> {
  const attributes: Record<string, ThemeOptionValue> = {};
  for (const [key, value] of Object.entries(values)) attributes[`data-opt-${key}`] = value;
  return attributes;
}

/* ------------------------------------------------------------------ */
/* 主题变体（M4（二）§C）：只覆盖槽位值与主题选项，世界的形态不变          */
/* ------------------------------------------------------------------ */

let variants: readonly ThemeVariant[] = [];

/** 注册（整体替换）当前可用的变体列表：来自 settings KV `themeVariants`，已校验 */
export function registerVariants(list: readonly ThemeVariant[]): void {
  variants = list;
}

export function listVariants(): readonly ThemeVariant[] {
  return variants;
}

export function findVariant(id: string | null | undefined): ThemeVariant | undefined {
  return id ? variants.find((variant) => variant.id === id) : undefined;
}
