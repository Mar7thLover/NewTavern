import { X } from 'lucide-react';
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';

import './toast.css';

/**
 * 应用级提示条。见 docs/M5-CONTRACT.md 第二部分 §3.3。
 *
 * - `toast({ title, description?, tone, action? })` 在任何地方都能调（不需要 hook）；
 * - 右下角（窄屏在顶部）最多堆 3 条，新的在下；超出时挤掉最早的一条；
 * - 5 秒自动消失，`danger` 不自动消失（出错要让人看见并主动关掉）；
 * - 只用槽位与材质类：底是 `surface-raised`，语气只体现在左侧一道细线与标题颜色上；
 * - `prefers-reduced-motion` 下没有位移动画（只保留透明度）。
 *
 * `<Toaster/>` 挂在 `AppLayout`。前端卡里的 `toastr` 仍是卡自己的（在 iframe 里），
 * 只有卡调到宿主的 `notify` 才会走到这里。
 */

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: ToastTone;
  action?: ToastAction;
  /** 覆盖自动消失时长（毫秒）；0 = 不自动消失。缺省 5000，danger 缺省 0 */
  duration?: number;
}

export interface ToastItem extends Required<Pick<ToastOptions, 'title' | 'tone'>> {
  id: number;
  description?: string;
  action?: ToastAction;
  duration: number;
}

const MAX_VISIBLE = 3;
const DEFAULT_DURATION = 5000;

let items: ToastItem[] = [];
let sequence = 0;
const subscribers = new Set<() => void>();
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function publish(next: ToastItem[]): void {
  items = next;
  for (const notify of [...subscribers]) notify();
}

/** 弹一条提示；返回 id（可以用 `dismissToast` 提前关掉） */
export function toast(options: ToastOptions): number {
  sequence += 1;
  const tone = options.tone ?? 'info';
  const item: ToastItem = {
    id: sequence,
    title: options.title,
    tone,
    duration: options.duration ?? (tone === 'danger' ? 0 : DEFAULT_DURATION),
    ...(options.description ? { description: options.description } : {}),
    ...(options.action ? { action: options.action } : {}),
  };
  // 同标题同内容的连发（卡在循环里 toastr）合并成一条：只重置计时
  const duplicate = items.find(
    (existing) =>
      existing.title === item.title &&
      existing.description === item.description &&
      existing.tone === item.tone,
  );
  if (duplicate) {
    schedule(duplicate);
    return duplicate.id;
  }
  const next = [...items, item];
  for (const dropped of next.slice(0, Math.max(0, next.length - MAX_VISIBLE))) clearTimer(dropped.id);
  publish(next.slice(-MAX_VISIBLE));
  schedule(item);
  return item.id;
}

export function dismissToast(id: number): void {
  clearTimer(id);
  if (!items.some((item) => item.id === id)) return;
  publish(items.filter((item) => item.id !== id));
}

/** 测试用：清空全部 */
export function clearToasts(): void {
  for (const id of timers.keys()) clearTimer(id);
  publish([]);
}

export function getToasts(): readonly ToastItem[] {
  return items;
}

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(id);
}

function schedule(item: ToastItem): void {
  clearTimer(item.id);
  if (item.duration <= 0) return;
  timers.set(
    item.id,
    setTimeout(() => dismissToast(item.id), item.duration),
  );
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function useToasts(): readonly ToastItem[] {
  return useSyncExternalStore(subscribe, getToasts, getToasts);
}

/** 语气只落在一道 2px 细线和标题色上：底色统一 `surface-raised`，不做彩色大块 */
const TONE_RULE: Record<ToastTone, string> = {
  info: 'border-s-info',
  success: 'border-s-success',
  warning: 'border-s-warning',
  danger: 'border-s-danger',
};

const TONE_TITLE: Record<ToastTone, string> = {
  info: 'text-ink',
  success: 'text-ink',
  warning: 'text-warning',
  danger: 'text-danger',
};

export function Toaster() {
  const { t } = useTranslation();
  const list = useToasts();

  // 卸载时清掉所有计时器（热更新 / 测试环境）
  useEffect(() => () => clearToasts(), []);

  return (
    <section
      data-part="toaster"
      aria-label={t('toast.region')}
      className={cn(
        'pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 p-3',
        'md:inset-x-auto md:end-0 md:top-auto md:bottom-0 md:items-end md:p-5',
      )}
    >
      {list.map((item) => (
        <div
          key={item.id}
          data-part="toast"
          data-tone={item.tone}
          role={item.tone === 'danger' || item.tone === 'warning' ? 'alert' : 'status'}
          aria-live={item.tone === 'danger' ? 'assertive' : 'polite'}
          className={cn(
            'surface-raised rounded-card edge-rule pointer-events-auto flex w-full max-w-sm items-start gap-3 border border-s-2 px-3.5 py-2.5 text-sm',
            'nt-toast-enter',
            TONE_RULE[item.tone],
          )}
        >
          <div className="min-w-0 flex-1">
            <p className={cn('leading-snug font-medium break-words', TONE_TITLE[item.tone])}>
              {item.title}
            </p>
            {item.description && (
              <p className="mt-0.5 text-xs leading-relaxed break-words whitespace-pre-line text-ink-2">
                {item.description}
              </p>
            )}
            {item.action && (
              <button
                type="button"
                className="focus-ring mt-1.5 cursor-pointer text-xs font-medium text-ink-link underline-offset-2 hover:underline"
                onClick={() => {
                  item.action?.onClick();
                  dismissToast(item.id);
                }}
              >
                {item.action.label}
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label={t('toast.dismiss')}
            className="action-ghost focus-ring rounded-control -me-1 shrink-0 cursor-pointer p-1"
            onClick={() => dismissToast(item.id)}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </section>
  );
}

/**
 * 卡 / 脚本的 `toastr.*` 与 `notify` 级别 → 提示条语气。
 * 酒馆助手的级别是 success / info / warning / error。
 */
export function toneOfLevel(level: string): ToastTone {
  if (level === 'error' || level === 'danger') return 'danger';
  if (level === 'warning' || level === 'warn') return 'warning';
  if (level === 'success') return 'success';
  return 'info';
}
