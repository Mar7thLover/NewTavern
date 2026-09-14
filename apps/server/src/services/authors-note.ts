import type { ChatRow } from './chat-tree.js';

/**
 * 作者注释：存 `chats.metadata.authorsNote`。见 docs/M3-CONTRACT.md §3.4。
 * 注意与角色卡的 `extensions.depth_prompt`（角色深度提示）是两回事，后者独立注入。
 */

/** 0 IN_PROMPT, 1 IN_CHAT, 2 BEFORE_PROMPT */
export type AuthorsNotePosition = 0 | 1 | 2;
/** 0 system, 1 user, 2 assistant */
export type AuthorsNoteRole = 0 | 1 | 2;

export interface AuthorsNote {
  text: string;
  position: AuthorsNotePosition;
  depth: number;
  role: AuthorsNoteRole;
  /** 每 N 条插一次，1 = 每次 */
  interval: number;
}

/** ST 的作者注释默认值：in-chat、深度 4、system、每轮 */
export const DEFAULT_AUTHORS_NOTE: Omit<AuthorsNote, 'text'> = {
  position: 1,
  depth: 4,
  role: 0,
  interval: 1,
};

function isTriState(value: unknown): value is 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2;
}

/**
 * 校验并归一化 PATCH 过来的作者注释。
 * `null` → null（清除）；形状非法 → 'invalid'；缺省字段补 ST 默认值。
 */
export function parseAuthorsNote(value: unknown): AuthorsNote | null | 'invalid' {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'invalid';
  const v = value as Record<string, unknown>;
  if (typeof v.text !== 'string') return 'invalid';
  if (v.position !== undefined && !isTriState(v.position)) return 'invalid';
  if (v.role !== undefined && !isTriState(v.role)) return 'invalid';
  if (v.depth !== undefined && (typeof v.depth !== 'number' || !Number.isFinite(v.depth))) {
    return 'invalid';
  }
  if (
    v.interval !== undefined &&
    (typeof v.interval !== 'number' || !Number.isFinite(v.interval) || v.interval < 0)
  ) {
    return 'invalid';
  }
  return {
    text: v.text,
    position: (v.position ?? DEFAULT_AUTHORS_NOTE.position) as AuthorsNotePosition,
    depth: (v.depth ?? DEFAULT_AUTHORS_NOTE.depth) as number,
    role: (v.role ?? DEFAULT_AUTHORS_NOTE.role) as AuthorsNoteRole,
    interval: (v.interval ?? DEFAULT_AUTHORS_NOTE.interval) as number,
  };
}

/** 从聊天行读出作者注释（脏数据当作没有） */
export function readAuthorsNote(chat: ChatRow): AuthorsNote | null {
  const parsed = parseAuthorsNote((chat.metadata ?? {})['authorsNote'] ?? null);
  return parsed === 'invalid' ? null : parsed;
}
