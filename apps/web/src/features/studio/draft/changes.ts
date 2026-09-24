import {
  NEW_LOREBOOK_ENTRY,
  type LorebookDraft,
  type LorebookEntryDraft,
} from '../../library/lorebook-editor/model';
import type { PresetDraft } from '../../library/preset-editor';
import type { CharacterDraft, StudioPatchOp } from '../types';
import { formatPointer } from './patch';

/*
 * 「改动行」：AI 补丁与版本对比共用的展示模型。
 * - field：一个字段（JSON Pointer 路径）从 before 变成 after；
 * - entry：世界书的一条条目整体新增 / 修改 / 删除，内含逐字段的变化。
 * 组件按行渲染字段级 diff（长文本逐字，见 text-diff.ts）。
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
  /** 原先不存在（新增字段） */
  hasBefore: boolean;
  /** 之后不存在（字段被删） */
  hasAfter: boolean;
}

export type ChangeRow =
  | ({ key: string; type: 'field'; path: string } & Omit<FieldChange, 'field'>)
  | {
      key: string;
      type: 'entry';
      action: 'add' | 'update' | 'delete';
      uid: number | null;
      title: string;
      fields: FieldChange[];
    };

type EntryField = Exclude<keyof LorebookEntryDraft, 'key' | 'id' | 'uid'>;
const ENTRY_FIELDS = Object.keys(NEW_LOREBOOK_ENTRY).filter((key) => key !== 'uid') as EntryField[];

/** 条目标题：comment，空时退到首个关键词 */
export function entryTitleOf(entry: Json): string {
  const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
  if (comment) return comment;
  const keys = Array.isArray(entry.keys) ? entry.keys : [];
  return typeof keys[0] === 'string' ? keys[0].trim() : '';
}

/** 新条目：列出与 ST 模板不同的字段 */
function addedFields(entry: Json): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of ENTRY_FIELDS) {
    if (!Object.hasOwn(entry, field)) continue;
    const value = entry[field];
    if (sameJson(value, NEW_LOREBOOK_ENTRY[field])) continue;
    out.push({ field, before: undefined, after: value, hasBefore: false, hasAfter: true });
  }
  return out;
}

/** 被删的条目：列出有内容的字段（正文、标题、关键词） */
function removedFields(entry: Json): FieldChange[] {
  const out: FieldChange[] = [];
  for (const field of ['comment', 'keys', 'content'] as const) {
    const value = entry[field];
    if (value === undefined || value === null || value === '' || sameJson(value, [])) continue;
    out.push({ field, before: value, after: undefined, hasBefore: true, hasAfter: false });
  }
  return out;
}

/** 补丁 → 改动行（一条补丁一行，下标一一对应，逐条接受按下标） */
export function opsToRows(ops: readonly StudioPatchOp[]): ChangeRow[] {
  return ops.map((op, index): ChangeRow => {
    const key = `op-${index}`;
    switch (op.op) {
      case 'set':
        return {
          key,
          type: 'field',
          path: op.path,
          before: op.before,
          after: op.value,
          hasBefore: Object.hasOwn(op, 'before'),
          hasAfter: true,
        };
      case 'add_entry':
        return {
          key,
          type: 'entry',
          action: 'add',
          uid: op.uid,
          title: entryTitleOf(op.entry),
          fields: addedFields(op.entry),
        };
      case 'update_entry':
        return {
          key,
          type: 'entry',
          action: 'update',
          uid: op.uid,
          title: entryTitleOf({ ...op.before, ...op.patch }),
          fields: Object.keys(op.patch).map((field) => ({
            field,
            before: op.before[field],
            after: op.patch[field],
            hasBefore: Object.hasOwn(op.before, field),
            hasAfter: true,
          })),
        };
      case 'delete_entry':
        return {
          key,
          type: 'entry',
          action: 'delete',
          uid: op.uid,
          title: entryTitleOf(op.before),
          fields: removedFields(op.before),
        };
    }
  });
}

/* ------------------------------------------------------------------ */
/* 版本对比（before = 当前草稿，after = 该版本：即「恢复会带来的改动」） */
/* ------------------------------------------------------------------ */

/** 逐层比较两个 JSON 值，产出叶子级的改动；数组等长时逐项比，不等长整体比 */
export function diffJson(
  before: unknown,
  after: unknown,
  tokens: string[] = [],
  out: ChangeRow[] = [],
): ChangeRow[] {
  if (sameJson(before, after)) return out;
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      const inBefore = Object.hasOwn(before, key);
      const inAfter = Object.hasOwn(after, key);
      if (inBefore && inAfter) {
        diffJson(before[key], after[key], [...tokens, key], out);
      } else {
        const path = formatPointer([...tokens, key]);
        out.push({
          key: `v-${path}`,
          type: 'field',
          path,
          before: before[key],
          after: after[key],
          hasBefore: inBefore,
          hasAfter: inAfter,
        });
      }
    }
    return out;
  }
  if (
    Array.isArray(before) &&
    Array.isArray(after) &&
    before.length === after.length &&
    before.length > 0
  ) {
    before.forEach((item, index) => diffJson(item, after[index], [...tokens, String(index)], out));
    return out;
  }
  const path = formatPointer(tokens);
  out.push({
    key: `v-${path}`,
    type: 'field',
    path,
    before,
    after,
    hasBefore: before !== undefined,
    hasAfter: after !== undefined,
  });
  return out;
}

/** 角色卡：整份 CCv3 data 逐字段比（内嵌书在世界书里编辑，不比） */
export function compareCharacterVersion(current: CharacterDraft, version: unknown): ChangeRow[] {
  if (!isRecord(version)) return [];
  const strip = (data: Json) => {
    const { character_book: _book, ...rest } = data;
    return rest;
  };
  return diffJson(strip(current), strip(version));
}

/** 预设版本里放布局策略的保留键（服务端 `PRESET_LAYOUT_POLICY_KEY`） */
export const PRESET_LAYOUT_POLICY_KEY = '__layoutPolicy';

export function comparePresetVersion(current: PresetDraft, version: unknown): ChangeRow[] {
  if (!isRecord(version)) return [];
  const { [PRESET_LAYOUT_POLICY_KEY]: policy, ...data } = version;
  const rows: ChangeRow[] = [];
  if (typeof data.name === 'string' && data.name !== current.name) {
    rows.push({
      key: 'v-name',
      type: 'field',
      path: '/name',
      before: current.name,
      after: data.name,
      hasBefore: true,
      hasAfter: true,
    });
  }
  const currentData = { ...current.data };
  if (typeof data.name === 'string') {
    delete currentData.name;
    delete data.name;
  }
  diffJson(currentData, data, [], rows);
  const versionPolicy = isRecord(policy) ? policy : null;
  if (!sameJson(current.layoutPolicy ?? null, versionPolicy)) {
    rows.push({
      key: 'v-layout',
      type: 'field',
      path: `/${PRESET_LAYOUT_POLICY_KEY}`,
      before: current.layoutPolicy,
      after: versionPolicy,
      hasBefore: current.layoutPolicy !== null,
      hasAfter: versionPolicy !== null,
    });
  }
  return rows;
}

/** 世界书：名称 + 条目按 id（没有 id 的按 uid）对齐 */
export function compareLorebookVersion(current: LorebookDraft, version: unknown): ChangeRow[] {
  if (!isRecord(version)) return [];
  const rows: ChangeRow[] = [];
  if (typeof version.name === 'string' && version.name !== current.name) {
    rows.push({
      key: 'v-name',
      type: 'field',
      path: '/name',
      before: current.name,
      after: version.name,
      hasBefore: true,
      hasAfter: true,
    });
  }
  const versionEntries = (Array.isArray(version.entries) ? version.entries : []).filter(isRecord);
  const matched = new Set<Json>();
  const findVersionEntry = (entry: LorebookEntryDraft): Json | undefined =>
    versionEntries.find(
      (item) =>
        !matched.has(item) &&
        ((entry.id !== undefined && item.id === entry.id) ||
          (entry.id === undefined && entry.uid !== null && item.uid === entry.uid)),
    );
  for (const entry of current.entries) {
    const other = findVersionEntry(entry);
    const entryJson = entry as unknown as Json;
    if (!other) {
      rows.push({
        key: `v-del-${entry.key}`,
        type: 'entry',
        action: 'delete',
        uid: entry.uid,
        title: entryTitleOf(entryJson),
        fields: removedFields(entryJson),
      });
      continue;
    }
    matched.add(other);
    const fields: FieldChange[] = [];
    for (const field of ENTRY_FIELDS) {
      if (!Object.hasOwn(other, field)) continue;
      if (sameJson(entry[field], other[field])) continue;
      fields.push({
        field,
        before: entry[field],
        after: other[field],
        hasBefore: true,
        hasAfter: true,
      });
    }
    if (fields.length > 0) {
      rows.push({
        key: `v-upd-${entry.key}`,
        type: 'entry',
        action: 'update',
        uid: entry.uid,
        title: entryTitleOf(entryJson) || entryTitleOf(other),
        fields,
      });
    }
  }
  versionEntries.forEach((item, index) => {
    if (matched.has(item)) return;
    rows.push({
      key: `v-add-${index}`,
      type: 'entry',
      action: 'add',
      uid: typeof item.uid === 'number' ? item.uid : null,
      title: entryTitleOf(item),
      fields: addedFields(item),
    });
  });
  return rows;
}

/** 改动行里的值 → 展示文本：字符串原样，其余 JSON 缩进 */
export function valueText(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  // 字符串数组（备用开场白、标签）：短的用逗号连起来，长的逐条编号分段，免得看一坨 JSON
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    const items = value as string[];
    if (items.every((item) => item.length <= 24 && !item.includes('\n'))) return items.join(', ');
    return items.map((item, index) => `#${index + 1}\n${item}`).join('\n\n');
  }
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}
