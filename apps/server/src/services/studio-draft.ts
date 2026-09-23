import { parsePreset, toWorldbookEntryColumns, type StWorldbookEntry } from '@newtavern/compat';

import type { schema, Db } from '../db/client.js';
import type { WIBook } from './assemble.js';
import type { LorebookEntryExtra, LorebookRow } from './character-book.js';
import {
  LorebookInputError,
  ensureSelective,
  loadLorebookDetail,
  newStEntryTemplate,
  parseSaveInput,
  splitDelayUntilRecursion,
  type EntryInput,
  type EntryRow,
} from './lorebook-edit.js';
import { presetColumns } from './presets.js';
import { bookFromRows } from './wi-map.js';

/**
 * 工作台草稿（M6 §2.4）：未保存的角色卡 / 预设 / 世界书改动也能拿来组装、测试、模拟触发。
 * 草稿只影响本次组装，**不落库**。
 *
 * - character：`{ id, data }`，data 为完整 CCv3 data；代替同 id 的卡行
 *   （`extensions.depth_prompt` 随之从草稿读；正则仍读正则库里这张卡的脚本，内嵌书仍读 `bookId`）；
 * - preset：`{ id, data }`，ST 预设 data；代替同 id 的预设行（采样参数从草稿重算）；
 * - lorebook：`{ id, name?, entries }`，条目形态同 `PUT /api/lorebooks/:id`；代替同 id 的那本书。
 */

export interface AssembleDraft {
  character?: { id: string; data: Record<string, unknown> };
  preset?: { id: string; data: Record<string, unknown> };
  lorebook?: { id: string; name?: string; entries: EntryInput[] };
}

/** 请求体里 `draft` 的原始形态（前端复用） */
export interface AssembleDraftBody {
  character?: { id: string; data: Record<string, unknown> };
  preset?: { id: string; data: Record<string, unknown> };
  lorebook?: { id: string; name?: string; entries: Record<string, unknown>[] };
}

export class DraftInputError extends Error {}

type Json = Record<string, unknown>;
type CharacterRow = typeof schema.characters.$inferSelect;
type PresetRow = typeof schema.presets.$inferSelect;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readId(value: Json, where: string): string {
  if (typeof value.id !== 'string' || value.id === '') {
    throw new DraftInputError(`${where}.id 必须是非空字符串`);
  }
  return value.id;
}

/** 校验请求体里的 `draft`；缺省 / null 返回 undefined */
export function parseDraft(value: unknown): AssembleDraft | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new DraftInputError('draft 必须是对象');
  const out: AssembleDraft = {};

  if (value.character !== undefined && value.character !== null) {
    if (!isRecord(value.character)) throw new DraftInputError('draft.character 必须是对象');
    const id = readId(value.character, 'draft.character');
    const data = value.character.data;
    if (!isRecord(data)) throw new DraftInputError('draft.character.data 必须是对象');
    if (typeof data.name !== 'string' || data.name.trim() === '') {
      throw new DraftInputError('draft.character.data.name 必须是非空字符串');
    }
    out.character = { id, data };
  }

  if (value.preset !== undefined && value.preset !== null) {
    if (!isRecord(value.preset)) throw new DraftInputError('draft.preset 必须是对象');
    const id = readId(value.preset, 'draft.preset');
    try {
      out.preset = { id, data: parsePreset(value.preset.data) };
    } catch (e) {
      throw new DraftInputError(`draft.preset.data：${(e as Error).message}`);
    }
  }

  if (value.lorebook !== undefined && value.lorebook !== null) {
    if (!isRecord(value.lorebook)) throw new DraftInputError('draft.lorebook 必须是对象');
    const id = readId(value.lorebook, 'draft.lorebook');
    try {
      const parsed = parseSaveInput(value.lorebook);
      out.lorebook = { id, entries: parsed.entries, ...(parsed.name ? { name: parsed.name } : {}) };
    } catch (e) {
      if (e instanceof LorebookInputError) {
        throw new DraftInputError(`draft.lorebook：${e.message}`);
      }
      throw e;
    }
  }
  return out;
}

/** 卡行套上草稿（id 相同才替换） */
export function withCharacterDraft(
  row: CharacterRow | undefined,
  draft: AssembleDraft | undefined,
): CharacterRow | undefined {
  const character = draft?.character;
  if (!row || !character || character.id !== row.id) return row;
  const name = typeof character.data.name === 'string' ? character.data.name.trim() : row.name;
  return { ...row, name: name || row.name, data: character.data };
}

/** 预设行套上草稿（id 相同才替换），采样参数 / apiFamily 从草稿重算 */
export function withPresetDraft(
  row: PresetRow | undefined,
  draft: AssembleDraft | undefined,
): PresetRow | undefined {
  const preset = draft?.preset;
  if (!row || !preset || preset.id !== row.id) return row;
  return { ...row, ...presetColumns(preset.data) };
}

/**
 * 草稿条目 → 内存里的条目行（与 `saveLorebook` 写库后的行同形，不落库）。
 * 有 id 的条目以库里的行为底叠加传入的列；无 id 的按 ST 模板新建，uid 接在本书最大 uid 之后。
 */
export function draftEntryRows(db: Db, bookId: string, entries: readonly EntryInput[]): EntryRow[] {
  const rows = loadLorebookDetail(db, bookId)?.entries ?? [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  let nextUid = 0;
  for (const row of rows) {
    const stKey = Number((row.extra as LorebookEntryExtra | null)?.stKey);
    nextUid = Math.max(nextUid, (row.uid ?? -1) + 1, Number.isInteger(stKey) ? stKey + 1 : 0);
  }
  const now = new Date();

  return entries.map((entry, index) => {
    const base = entry.id !== undefined ? byId.get(entry.id) : undefined;
    if (entry.id !== undefined && !base) {
      throw new DraftInputError(`entries[${index}].id 不属于这本世界书：${entry.id}`);
    }
    const columns = { ...entry.columns };
    let row: EntryRow;
    let extra: LorebookEntryExtra;
    if (base) {
      row = base;
      extra = structuredClone((base.extra ?? {}) as LorebookEntryExtra);
      ensureSelective(columns, base.selective);
    } else {
      const uid = nextUid++;
      const template = newStEntryTemplate(uid);
      extra = { stKey: String(uid), raw: template };
      ensureSelective(columns, true);
      row = {
        ...toWorldbookEntryColumns(template),
        id: `draft:${index}`,
        bookId,
        uid,
        displayIndex: null,
        decorators: null,
        extra: null,
        createdAt: now,
        updatedAt: now,
      };
    }
    const raw = { ...((extra.raw ?? {}) as Json) };
    splitDelayUntilRecursion(columns, raw);
    for (const [key, value] of Object.entries(entry.raw)) raw[key] = value;
    return {
      ...row,
      ...(columns as Partial<EntryRow>),
      extra: { ...extra, raw: raw as StWorldbookEntry },
    };
  });
}

/** 组装用的书列表里，把草稿那本（同 id）换成草稿内容；书名随草稿 */
export function withLorebookDraft(
  db: Db,
  books: WIBook[],
  draft: AssembleDraft | undefined,
): WIBook[] {
  const lorebook = draft?.lorebook;
  if (!lorebook) return books;
  return books.map((book) => {
    if (book.id !== lorebook.id) return book;
    const row = { id: book.id, name: lorebook.name ?? book.name } as LorebookRow;
    return bookFromRows(row, draftEntryRows(db, book.id, lorebook.entries), book.scope);
  });
}
