import { useEffect } from 'react';

/**
 * 输入框的外部写入口：slash `/setinput`（前端卡的 `triggerSlash` 也能调）要把文字放进
 * Composer，而 Composer 的草稿是它自己的组件状态。这里是一个按会话分发的小总线，
 * Composer 订阅，别处只管发。
 */

type Listener = (text: string) => void;

const listeners = new Map<string, Set<Listener>>();

export function requestComposerInput(chatId: string, text: string): void {
  for (const listener of [...(listeners.get(chatId) ?? [])]) listener(text);
}

export function useComposerInputRequests(chatId: string | undefined, onInput: Listener): void {
  useEffect(() => {
    if (!chatId) return undefined;
    const bucket = listeners.get(chatId) ?? new Set<Listener>();
    bucket.add(onInput);
    listeners.set(chatId, bucket);
    return () => {
      bucket.delete(onInput);
      if (bucket.size === 0) listeners.delete(chatId);
    };
  }, [chatId, onInput]);
}
