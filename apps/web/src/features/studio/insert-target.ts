import { useSyncExternalStore } from 'react';

/*
 * 提示库「插入」的落点：编辑器栏里最近一次获得焦点的文本框（M6 §4.4）。
 * 在编辑器栏的根上监听 focusin，记住最后一个可写的 textarea / 文本 input 及其光标；
 * 插入时用原生 value setter + input 事件，让 React 的受控 onChange 照常收到——所以不需要
 * 改任何编辑器（角色卡、预设、世界书的文本框都能插）。
 */

type TextField = HTMLTextAreaElement | HTMLInputElement;

let target: TextField | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of [...listeners]) listener();
}

function isTextField(element: EventTarget | null): element is TextField {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement) {
    return ['text', 'search', ''].includes(element.type) && !element.readOnly && !element.disabled;
  }
  return false;
}

/** 在编辑器栏根元素上开始跟踪；返回注销函数 */
export function trackInsertTarget(root: HTMLElement): () => void {
  const onFocusIn = (event: FocusEvent) => {
    if (!isTextField(event.target) || event.target === target) return;
    target = event.target;
    notify();
  };
  root.addEventListener('focusin', onFocusIn);
  return () => {
    root.removeEventListener('focusin', onFocusIn);
    if (target && root.contains(target)) {
      target = null;
      notify();
    }
  };
}

function currentTarget(): TextField | null {
  return target && target.isConnected ? target : null;
}

/** 有可插入的文本框时返回它的无障碍名称（aria-label / 关联 label / placeholder），否则 null */
export function useInsertTarget(): { label: string } | null {
  const field = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    currentTarget,
    () => null,
  );
  if (!field) return null;
  const label =
    field.getAttribute('aria-label') ||
    (field.labels?.[0]?.textContent ?? '').trim() ||
    field.placeholder ||
    '';
  return { label };
}

/** 把文字插到落点的光标处（替换选中内容）；成功返回 true */
export function insertAtCursor(text: string): boolean {
  const field = currentTarget();
  if (!field) return false;
  const value = field.value;
  const start = field.selectionStart ?? value.length;
  const end = field.selectionEnd ?? start;
  const next = value.slice(0, start) + text + value.slice(end);
  const proto =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) return false;
  setter.call(field, next);
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.focus();
  const caret = start + text.length;
  // React 重渲染后再放光标（受控组件会先把 value 写回同一个值）
  requestAnimationFrame(() => {
    if (field.isConnected) field.setSelectionRange(caret, caret);
  });
  return true;
}
