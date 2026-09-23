import { useSyncExternalStore } from 'react';

import slotsSource from '../../themes/slots.css?raw';

/**
 * 卡的主题贴合（M5（三）契约 §3.4）。
 *
 * iframe 是 opaque origin，拿不到宿主的 CSS 变量；宿主把当前世界（含变体与明暗）的
 * 槽位**计算值**抄一份，写成声明串塞进 srcdoc 的 `#nt-theme`，之后切主题再经 `theme` 镜像推送
 * （guest 改写那段 `<style>`，不重建 iframe）。
 *
 * 槽位清单取自 `themes/slots.css` 本身（`:root` 块与 `@theme` 块里声明的名字，去掉
 * `var(--x)` 形式的别名），不在这里另抄一份——主题手册加了槽位，这里自动跟上。
 *
 * 卡里写什么：新酒馆的名字加 `nt-` 前缀（`var(--nt-canvas)`，免得撞上卡自己的 `--canvas`），
 * 另外映射酒馆助手 / ST 美化卡常用的 `--SmartTheme*`。
 */

/** slots.css 里声明的槽位名（不含 Tailwind 别名） */
export function parseSlotNames(source: string): string[] {
  // 只看 `@theme inline` 之前：之后是 `--color-canvas: var(--canvas)` 这类工具类别名
  const cut = source.indexOf('@theme inline');
  const head = cut >= 0 ? source.slice(0, cut) : source;
  const names = new Set<string>();
  const re = /(^|[\s;{])(--[a-zA-Z0-9-]+)\s*:\s*([^;]*)/g;
  for (let match = re.exec(head); match !== null; match = re.exec(head)) {
    const name = match[2] ?? '';
    const value = (match[3] ?? '').trim();
    if (name === '' || value.startsWith('var(--')) continue;
    names.add(name);
  }
  return [...names];
}

export const SLOT_NAMES: readonly string[] = parseSlotNames(slotsSource);

/** 酒馆助手 / ST 美化卡的常见变量 → 新酒馆槽位 */
export const SMART_THEME_MAP: Readonly<Record<string, string>> = {
  '--SmartThemeBodyColor': '--ink',
  '--SmartThemeEmColor': '--ink-action',
  '--SmartThemeQuoteColor': '--ink-quote',
  '--SmartThemeBlurTintColor': '--reading',
  '--SmartThemeBorderColor': '--edge',
  '--SmartThemeUnderlineColor': '--ink-link',
  '--SmartThemeChatTintColor': '--reading',
  '--SmartThemeShadowColor': '--overlay',
};

/** 声明串里的值不能带 `;` `{` `}` `<`：它会被原样拼进 `<style>` 里 */
function safeValue(value: string): string {
  return value.replace(/[;{}<>]/g, '').replace(/\s+/g, ' ').trim();
}

/** 从一个取值函数（通常是 `getComputedStyle(documentElement)`）生成声明串 */
export function buildThemeCss(read: (name: string) => string, names: readonly string[] = SLOT_NAMES): string {
  const values = new Map<string, string>();
  const parts: string[] = [];
  for (const name of names) {
    const value = safeValue(read(name));
    if (value === '') continue;
    values.set(name, value);
    parts.push(`--nt-${name.slice(2)}:${value}`);
  }
  for (const [alias, slot] of Object.entries(SMART_THEME_MAP)) {
    const value = values.get(slot);
    if (value) parts.push(`${alias}:${value}`);
  }
  return parts.join(';');
}

/* ------------------------------------------------------------------ */
/* 订阅：<html> 的属性（data-theme / data-mode / data-variant / style）变了就重算 */
/* ------------------------------------------------------------------ */

let cached = '';
const listeners = new Set<() => void>();
let observer: MutationObserver | null = null;
let media: MediaQueryList | null = null;

function compute(): string {
  if (typeof document === 'undefined') return '';
  const style = getComputedStyle(document.documentElement);
  return buildThemeCss((name) => style.getPropertyValue(name));
}

function refresh(): void {
  // 主题 CSS 是懒加载的（themes/apply.ts）：属性先变、样式后到，下一帧再读一次
  const update = () => {
    const next = compute();
    if (next === cached) return;
    cached = next;
    for (const listener of [...listeners]) listener();
  };
  update();
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(update);
    setTimeout(update, 250);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && typeof document !== 'undefined') {
    cached = compute();
    observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, { attributes: true });
    media = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    media?.addEventListener('change', refresh);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      observer?.disconnect();
      observer = null;
      media?.removeEventListener('change', refresh);
      media = null;
    }
  };
}

function snapshot(): string {
  if (listeners.size === 0) cached = compute();
  return cached;
}

/** 当前世界的槽位声明串；切主题时组件重渲染，拿新值推镜像 */
export function useThemeCss(): string {
  return useSyncExternalStore(subscribe, snapshot, () => '');
}
