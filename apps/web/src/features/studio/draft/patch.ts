import {
  NEW_LOREBOOK_ENTRY,
  type LorebookDraft,
  type LorebookEntryDraft,
} from '../../library/lorebook-editor/model';
import type { PresetDraft } from '../../library/preset-editor';
import type { CharacterDraft, StudioPatchOp } from '../types';

/*
 * 把 AI 协作者的补丁（M6 §3.2 `StudioPatchOp`）合进工作台草稿。纯函数，全部返回新对象、不改入参。
 * 补丁是相对「发起那一轮时的草稿」算的；逐条接受时其余改动可能还没合进来，所以写入时
 * 父级缺了就补对象、数组下标越过末尾就追加，尽量让每一条都能单独落地。
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** `/a/b~1c` → ['a', 'b/c']；空串与 `/` 为根；缺前导 `/` 时补上 */
export function parsePointer(path: string): string[] {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '/') return [];
  const p = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return p
    .slice(1)
    .split('/')
    .map((token) => token.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function formatPointer(tokens: readonly string[]): string {
  return tokens.map((t) => `/${t.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

const INDEX_RE = /^(0|[1-9]\d*)$/;

/** 读路径；不存在时 found=false */
export function getAt(
  root: unknown,
  tokens: readonly string[],
): { found: boolean; value: unknown } {
  let cur: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(cur)) {
      if (!INDEX_RE.test(token) || Number(token) >= cur.length) {
        return { found: false, value: undefined };
      }
      cur = cur[Number(token)];
    } else if (isRecord(cur)) {
      if (!Object.hasOwn(cur, token)) return { found: false, value: undefined };
      cur = cur[token];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

/**
 * 不可变写入：沿路径浅拷贝。父级不存在（或不是容器）时补一个对象；
 * 数组下标 ≥ 长度时追加到末尾；`-` 也是追加。
 */
export function setAtImmutable<T>(root: T, tokens: readonly string[], value: unknown): T {
  if (tokens.length === 0) return value as T;
  const [head, ...rest] = tokens as [string, ...string[]];
  if (FORBIDDEN_KEYS.has(head)) return root;
  if (Array.isArray(root)) {
    const next = [...(root as unknown[])];
    const index = head === '-' || !INDEX_RE.test(head) ? next.length : Number(head);
    if (index >= next.length) next.push(setAtImmutable(undefined, rest, value));
    else next[index] = setAtImmutable(next[index], rest, value);
    return next as T;
  }
  const base: Json = isRecord(root) ? { ...root } : {};
  base[head] = setAtImmutable(base[head], rest, value);
  return base as T;
}

/* ------------------------------------------------------------------ */
/* 角色卡                                                               */
/* ------------------------------------------------------------------ */

/** 角色卡只有 `set`；条目类补丁（内嵌书只读）忽略 */
export function applyCharacterOps(
  draft: CharacterDraft,
  ops: readonly StudioPatchOp[],
): CharacterDraft {
  let next = draft;
  for (const op of ops) {
    if (op.op !== 'set') continue;
    const tokens = parsePointer(op.path);
    if (tokens.length === 0) continue;
    next = setAtImmutable(next, tokens, structuredClone(op.value));
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* 预设                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 预设补丁的路径相对 ST 预设 data（请求草稿 = data，另带 `name`）。
 * `/name` 写草稿名称（data 原本有 name 时一并写回 data）。
 */
export function applyPresetOps(draft: PresetDraft, ops: readonly StudioPatchOp[]): PresetDraft {
  let next = draft;
  for (const op of ops) {
    if (op.op !== 'set') continue;
    const tokens = parsePointer(op.path);
    if (tokens.length === 0) continue;
    const value = structuredClone(op.value);
    if (tokens.length === 1 && tokens[0] === 'name') {
      if (typeof value !== 'string') continue;
      next = {
        ...next,
        name: value,
        ...(Object.hasOwn(next.data, 'name') ? { data: { ...next.data, name: value } } : {}),
      };
      continue;
    }
    next = { ...next, data: setAtImmutable(next.data, tokens, value) };
  }
  return next;
}

/** 预设的协作草稿：ST 预设 data + 名称（补丁的 `/name` 对应编辑器的名称） */
export function presetAssistDraft(draft: PresetDraft): Json {
  return { ...draft.data, name: draft.name };
}

/* ------------------------------------------------------------------ */
/* 世界书                                                               */
/* ------------------------------------------------------------------ */

type EntryField = Exclude<keyof LorebookEntryDraft, 'key' | 'id' | 'uid'>;
const ENTRY_FIELDS = Object.keys(NEW_LOREBOOK_ENTRY).filter((key) => key !== 'uid') as EntryField[];

/** 只取编辑器认识的条目字段 */
export function pickEntryFields(source: Json): Partial<Pick<LorebookEntryDraft, EntryField>> {
  const out: Json = {};
  for (const field of ENTRY_FIELDS) {
    if (Object.hasOwn(source, field) && source[field] !== undefined) {
      out[field] = structuredClone(source[field]);
    }
  }
  return out as Partial<Pick<LorebookEntryDraft, EntryField>>;
}

/** 世界书只允许 `/name` 的 set，其余是条目补丁 */
export function applyLorebookOps(
  draft: LorebookDraft,
  ops: readonly StudioPatchOp[],
): LorebookDraft {
  let next = draft;
  for (const op of ops) {
    switch (op.op) {
      case 'set': {
        const tokens = parsePointer(op.path);
        if (tokens.length === 1 && tokens[0] === 'name' && typeof op.value === 'string') {
          next = { ...next, name: op.value };
        }
        break;
      }
      case 'add_entry': {
        // 同一个 uid 已经在草稿里（重复接受）就不再加
        if (next.entries.some((entry) => entry.uid === op.uid)) break;
        const entry: LorebookEntryDraft = {
          ...NEW_LOREBOOK_ENTRY,
          keys: [],
          secondaryKeys: [],
          ...pickEntryFields(op.entry),
          key: `new:${crypto.randomUUID()}`,
          uid: op.uid,
        };
        next = { ...next, entries: [...next.entries, entry] };
        break;
      }
      case 'update_entry': {
        const fields = pickEntryFields(op.patch);
        next = {
          ...next,
          entries: next.entries.map((entry) =>
            entry.uid === op.uid ? { ...entry, ...fields } : entry,
          ),
        };
        break;
      }
      case 'delete_entry':
        next = { ...next, entries: next.entries.filter((entry) => entry.uid !== op.uid) };
        break;
    }
  }
  return next;
}

/** 世界书的协作草稿：编辑器草稿原样（条目带全字段，服务端只取 PUT 认的） */
export function lorebookAssistDraft(draft: LorebookDraft): Json {
  return { name: draft.name, entries: draft.entries.map((entry) => ({ ...entry })) };
}
