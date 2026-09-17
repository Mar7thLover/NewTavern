import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, fetchJson, mutate, queryKeys, type ChatSummary } from './api';

/**
 * SillyTavern 迁移（M4 契约 §2）：聊天记录导入导出、目录迁移向导。
 * 与 `api.ts` 分开放，避免多个代理同时改同一个文件。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

export interface ImportStChatResult {
  chat: ChatSummary;
  /** jsonl 里的消息行数 */
  messageCount: number;
  /** 建出的节点数（含 swipe 兄弟） */
  nodeCount: number;
  warnings: string[];
}

export interface ExportStChatResult {
  /** 不在当前路径上、没有导出的分支数 */
  droppedBranches: number;
  /** 没写进文件的附件数 */
  skippedAttachments: number;
}

export interface StUserChoice {
  name: string;
  path: string;
}

export interface StInventory {
  root: string;
  characters: { file: string; name: string; exists: boolean; chatCount: number; error?: string }[];
  chats: { file: string; characterFile: string | null; title: string; exists: boolean }[];
  groupChats: number;
  presets: { file: string; name: string; exists: boolean; error?: string }[];
  lorebooks: { file: string; name: string; entryCount: number; exists: boolean; error?: string }[];
  regex: { count: number; newCount: number };
  personas: { avatar: string; name: string; exists: boolean }[];
  defaultPersona: string | null;
  worldInfo: { globalBooks: string[]; hasSettings: boolean };
  skipped: {
    backgrounds: number;
    instruct: number;
    context: number;
    themes: number;
    quickReplies: number;
  };
}

export type StScanResult = { users: StUserChoice[] } | StInventory;

export interface MigrationSelect {
  characters: string[];
  chats: string[];
  presets: string[];
  lorebooks: string[];
  personas: string[];
  regex: boolean;
  worldInfo: boolean;
  defaultPersona: boolean;
}

export type MigrationCategory =
  'lorebooks' | 'characters' | 'personas' | 'presets' | 'regex' | 'settings' | 'chats';

export type MigrationStatus = 'imported' | 'skipped' | 'failed';

export interface MigrationItem {
  category: MigrationCategory;
  file: string;
  status: MigrationStatus;
  id?: string;
  message?: string;
}

export interface MigrationDone {
  counts: Record<MigrationCategory, Record<MigrationStatus, number>>;
  warnings: string[];
}

export const migrationUrls = {
  importChat: '/api/import/chat',
  exportChat: (chatId: string) => `/api/chats/${encodeURIComponent(chatId)}/export`,
  access: '/api/migration/access',
  scan: '/api/migration/st/scan',
  run: '/api/migration/st/run',
};

/* ------------------------------------------------------------------ */
/* 聊天记录                                                             */
/* ------------------------------------------------------------------ */

/**
 * 读聊天记录里的角色名 / 用户名，给导入弹窗预选角色（与服务端 compat `stChatNames` 同规则）：
 * header 有真名用 header；ST 新版 header 写的是 `'unused'`，这时取第一条角色 / 用户消息的 name。
 * 只读前 1 MB；首行不是 header 时返回 null（交给服务端报错）。
 */
export async function readStChatHeader(
  file: File,
): Promise<{ characterName: string | null; userName: string | null } | null> {
  const realName = (value: unknown) =>
    typeof value === 'string' && value !== '' && value !== 'unused' ? value : null;
  let lines: string[];
  let header: Record<string, unknown>;
  try {
    const head = await file.slice(0, 1024 * 1024).text();
    const text = head.charCodeAt(0) === 0xfeff ? head.slice(1) : head;
    lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    const parsed = JSON.parse(lines[0] ?? '') as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    header = parsed as Record<string, unknown>;
    if (!('chat_metadata' in header || 'user_name' in header)) return null;
  } catch {
    return null;
  }
  let characterName = realName(header.character_name);
  let userName = realName(header.user_name);
  for (const line of lines.slice(1)) {
    if (characterName && userName) break;
    try {
      const message = JSON.parse(line) as {
        name?: unknown;
        is_user?: unknown;
        extra?: { type?: unknown };
      };
      const name = realName(message.name);
      if (!name) continue;
      if (message.is_user) userName ??= name;
      else if (message.extra?.type !== 'narrator') characterName ??= name;
    } catch {
      // 1 MB 截断处的半行
    }
  }
  return { characterName, userName };
}

/** 导入聊天记录；characterId 为 null 表示不绑定角色，undefined 表示让服务端按名字匹配 */
export function useImportStChat() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, characterId }: { file: File; characterId?: string | null }) => {
      const form = new FormData();
      form.append('file', file);
      if (characterId !== undefined) form.append('characterId', characterId ?? '');
      return mutate<ImportStChatResult>(migrationUrls.importChat, 'POST', form);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.chats, exact: true }),
  });
}

function fileNameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // 退回 ASCII 名
    }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? null;
}

/** 下载导出的 jsonl；返回响应头里的分支 / 附件计数 */
export async function downloadStChat(chatId: string): Promise<ExportStChatResult> {
  const url = migrationUrls.exportChat(chatId);
  const res = await fetch(url);
  if (!res.ok) {
    let message = `${url} -> ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string; error?: string };
      message = body.message ?? body.error ?? message;
    } catch {
      // 非 JSON 错误体
    }
    throw new ApiError(message, res.status);
  }
  const blob = await res.blob();
  const name = fileNameFromDisposition(res.headers.get('content-disposition')) ?? 'chat.jsonl';
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
  return {
    droppedBranches: Number(res.headers.get('X-NT-Dropped-Branches') ?? 0) || 0,
    skippedAttachments: Number(res.headers.get('X-NT-Skipped-Attachments') ?? 0) || 0,
  };
}

export function useExportStChat() {
  return useMutation({ mutationFn: (chatId: string) => downloadStChat(chatId) });
}

/* ------------------------------------------------------------------ */
/* 目录迁移                                                             */
/* ------------------------------------------------------------------ */

export type MigrationAccess = 'local' | 'forbidden';

/** 进页面先探：非本机访问时服务端 403，页面只显示说明 */
export function useMigrationAccess() {
  return useQuery({
    queryKey: ['migration', 'access'] as const,
    queryFn: async (): Promise<{ access: MigrationAccess; message: string | null }> => {
      try {
        await fetchJson(migrationUrls.access);
        return { access: 'local', message: null };
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) {
          return { access: 'forbidden', message: error.message };
        }
        throw error;
      }
    },
    retry: false,
    staleTime: Infinity,
  });
}

export function useScanSt() {
  return useMutation({
    mutationFn: (path: string) => mutate<StScanResult>(migrationUrls.scan, 'POST', { path }),
  });
}

export function isUserChoice(result: StScanResult): result is { users: StUserChoice[] } {
  return 'users' in result;
}

interface SseMessage {
  event: string;
  data: string;
}

/** 最小 SSE 解析：跨 chunk 断句、CRLF、注释行 */
async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const parse = (block: string): SseMessage | null => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    return data.length > 0 ? { event, data: data.join('\n') } : null;
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n?/g, '\n');
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const message = parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        if (message) yield message;
        index = buffer.indexOf('\n\n');
      }
    }
    const tail = parse(buffer.trim());
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

export interface MigrationRunHandlers {
  onStart?: (total: number) => void;
  onItem: (item: MigrationItem) => void;
  onDone: (done: MigrationDone) => void;
}

/** 开始迁移（SSE）；中途断开时抛错，已完成的项已经在库里 */
export async function runStMigration(
  path: string,
  select: MigrationSelect,
  handlers: MigrationRunHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(migrationUrls.run, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ path, select }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok || !res.body) {
    let message = `${migrationUrls.run} -> ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // 非 JSON
    }
    throw new ApiError(message, res.status);
  }
  let finished = false;
  for await (const message of readSse(res.body)) {
    const data = JSON.parse(message.data) as unknown;
    if (message.event === 'start') handlers.onStart?.((data as { total: number }).total);
    else if (message.event === 'item') handlers.onItem(data as MigrationItem);
    else if (message.event === 'done') {
      finished = true;
      handlers.onDone(data as MigrationDone);
    } else if (message.event === 'error') {
      throw new ApiError((data as { message?: string }).message ?? 'error', 500);
    }
  }
  if (!finished) throw new ApiError('迁移连接中断', 0);
}

/** 迁移完成后把库里各处列表都标脏 */
export function useInvalidateAfterMigration() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      [
        queryKeys.characters,
        queryKeys.presets,
        queryKeys.lorebooks,
        queryKeys.personas,
        queryKeys.chats,
        queryKeys.regexScripts,
        ['settings'],
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
}
