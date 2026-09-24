import { create } from 'zustand';

/**
 * 命令面板 → 写作项目页的请求通道（与对话页的 `requestChatPanel` 同一做法）。
 * 这个文件会进主包：只放一个极小的 store，不引编辑器。
 */

export type WritingCommand = 'newChapter' | 'aiContinue' | 'saveVersion';

interface WritingCommandState {
  request: { command: WritingCommand; nonce: number } | null;
  send: (command: WritingCommand) => void;
  /** 处理完清掉（只清自己看到的那一个，免得吞掉紧接着的新请求） */
  clear: (nonce: number) => void;
}

let sequence = 0;

export const useWritingCommands = create<WritingCommandState>((set, get) => ({
  request: null,
  send: (command) => {
    sequence += 1;
    set({ request: { command, nonce: sequence } });
  },
  clear: (nonce) => {
    if (get().request?.nonce === nonce) set({ request: null });
  },
}));

/** `/writing/:projectId` → projectId；别的路径返回 null */
export function writingProjectIdOf(pathname: string): string | null {
  const match = /^\/writing\/([^/]+)\/?$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
