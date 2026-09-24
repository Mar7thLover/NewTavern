import type {
  LorebookDetail,
  LorebookEntry,
  LorebookEntryInput,
  LorebookUpdateInput,
} from '../../../lib/api';

/*
 * 世界书编辑器的草稿模型（纯函数，工作台 / 写作页 / 世界书页共用）。
 *
 * 草稿是条目列表（顺序即展示顺序）。保存时整本提交：已有条目只带改动的字段，
 * 新条目只带与 ST 新条目模板不同的字段，删掉的条目不出现在列表里（服务端据此删除）。
 * 没改动的字段不上传，导出因此保持原文件的原样（见 services/lorebook-edit.ts）。
 */

export type LorebookEntryRole = 'system' | 'user' | 'assistant';

/** 一条条目的草稿（与 PUT 的可编辑字段同形，另带本地 key / 服务端 id / uid） */
export interface LorebookEntryDraft {
  /** 本地 key：已有条目用 id，新条目用 `new:<uuid>`（保存后仍沿用，展开状态因此不丢） */
  key: string;
  /** 服务端 id；新条目没有 */
  id?: string;
  uid: number | null;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  comment: string | null;
  constant: boolean;
  selective: boolean;
  selectiveLogic: number | null;
  position: number;
  depth: number | null;
  entryOrder: number;
  probability: number | null;
  group: string | null;
  groupOverride: boolean | null;
  groupWeight: number | null;
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  useGroupScoring: boolean | null;
  automationId: string | null;
  role: LorebookEntryRole | null;
  disabled: boolean;
  sticky: number | null;
  cooldown: number | null;
  delay: number | null;
  excludeRecursion: boolean | null;
  preventRecursion: boolean | null;
  /** 数字 = ST 递归等级 */
  delayUntilRecursion: boolean | number | null;
  ignoreBudget: boolean | null;
  useProbability: boolean;
  vectorized: boolean;
  outletName: string;
}

/** 世界书编辑器的受控值 */
export interface LorebookDraft {
  name: string;
  entries: LorebookEntryDraft[];
}

export type LorebookEntryField = Exclude<keyof LorebookEntryDraft, 'key' | 'id' | 'uid'>;
export type LorebookEntryPatch = Partial<Pick<LorebookEntryDraft, LorebookEntryField>>;

type EntryValues = Omit<LorebookEntryDraft, 'key'>;

/** ST 新条目模板（`newWorldInfoEntryTemplate`）经列派生后的值；新条目只上传与它不同的字段 */
export const NEW_LOREBOOK_ENTRY: Readonly<EntryValues> = {
  uid: null,
  keys: [],
  secondaryKeys: [],
  content: '',
  comment: '',
  constant: false,
  selective: true,
  selectiveLogic: 0,
  position: 0,
  depth: 4,
  entryOrder: 100,
  probability: 100,
  group: '',
  groupOverride: false,
  groupWeight: 100,
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: null,
  useGroupScoring: null,
  automationId: '',
  role: 'system',
  disabled: false,
  sticky: null,
  cooldown: null,
  delay: null,
  excludeRecursion: false,
  preventRecursion: false,
  delayUntilRecursion: null,
  ignoreBudget: false,
  useProbability: true,
  vectorized: false,
  outletName: '',
};

const FIELDS = Object.keys(NEW_LOREBOOK_ENTRY).filter(
  (key) => key !== 'uid',
) as LorebookEntryField[];

/** 原文件没有该字段（列为 null）时，关掉开关 / 清空文本回到 null，避免凭空写出 false / '' */
const NULL_WHEN_EMPTY = new Set<LorebookEntryField>([
  'comment',
  'group',
  'automationId',
  'groupOverride',
  'excludeRecursion',
  'preventRecursion',
  'delayUntilRecursion',
  'ignoreBudget',
]);

/* ------------------------------------------------------------------ */
/* 服务端 ⇄ 草稿                                                        */
/* ------------------------------------------------------------------ */

export function entryFromRow(row: LorebookEntry): LorebookEntryDraft {
  const raw = row.extra?.raw ?? {};
  const level = raw.delayUntilRecursion;
  return {
    key: row.id,
    id: row.id,
    uid: row.uid,
    keys: row.keys,
    secondaryKeys: row.secondaryKeys,
    content: row.content,
    comment: row.comment,
    constant: row.constant,
    selective: row.selective,
    selectiveLogic: row.selectiveLogic,
    position: row.position,
    depth: row.depth,
    entryOrder: row.entryOrder,
    probability: row.probability,
    group: row.group,
    groupOverride: row.groupOverride,
    groupWeight: row.groupWeight,
    scanDepth: row.scanDepth,
    caseSensitive: row.caseSensitive,
    matchWholeWords: row.matchWholeWords,
    useGroupScoring: row.useGroupScoring,
    automationId: row.automationId,
    role: row.role,
    disabled: row.disabled,
    sticky: row.sticky,
    cooldown: row.cooldown,
    delay: row.delay,
    excludeRecursion: row.excludeRecursion,
    preventRecursion: row.preventRecursion,
    delayUntilRecursion:
      row.delayUntilRecursion ??
      (typeof level === 'number' && Number.isInteger(level) && level >= 1 ? level : null),
    ignoreBudget: row.ignoreBudget,
    useProbability: typeof raw.useProbability === 'boolean' ? raw.useProbability : true,
    vectorized: raw.vectorized === true,
    outletName: typeof raw.outletName === 'string' ? raw.outletName : '',
  };
}

/**
 * 服务端详情 → 草稿。
 * 传 `submitted`（刚提交的草稿）时：服务端按提交顺序返回条目，新条目沿用提交时的本地 key，
 * 界面上的展开 / 聚焦状态因此不丢。
 */
export function lorebookToDraft(
  detail: Pick<LorebookDetail, 'name' | 'entries'>,
  submitted?: LorebookDraft,
): LorebookDraft {
  const entries = detail.entries.map(entryFromRow);
  if (submitted && submitted.entries.length === entries.length) {
    entries.forEach((entry, index) => {
      const previous = submitted.entries[index]!;
      if (previous.id === undefined || previous.id === entry.id) entry.key = previous.key;
    });
  }
  return { name: detail.name, entries };
}

function sameValue(a: unknown, b: unknown): boolean {
  return Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : a === b;
}

function entryChanged(draft: LorebookEntryDraft, base: EntryValues): boolean {
  return FIELDS.some((field) => !sameValue(draft[field], base[field]));
}

const keyMaps = new WeakMap<LorebookDraft, Map<string, LorebookEntryDraft>>();
/** 基线条目按本地 key 建索引（按基线对象缓存） */
export function baselineIndex(baseline: LorebookDraft): Map<string, LorebookEntryDraft> {
  let map = keyMaps.get(baseline);
  if (!map) {
    map = new Map(baseline.entries.map((entry) => [entry.key, entry]));
    keyMaps.set(baseline, map);
  }
  return map;
}

/** 一条草稿 → PUT 条目：已有条目只带与基线不同的字段，新条目只带与 ST 模板不同的字段 */
export function entryToInput(
  draft: LorebookEntryDraft,
  base: LorebookEntryDraft | undefined,
): LorebookEntryInput {
  const out: Record<string, unknown> = draft.id ? { id: draft.id } : {};
  const reference: EntryValues = draft.id && base ? base : NEW_LOREBOOK_ENTRY;
  for (const field of FIELDS) {
    if (!sameValue(draft[field], reference[field])) out[field] = draft[field];
  }
  return out as LorebookEntryInput;
}

/** 草稿的条目 → PUT / 触发模拟共用的 `entries` */
export function lorebookDraftToEntries(
  draft: LorebookDraft,
  baseline: LorebookDraft,
): LorebookEntryInput[] {
  const index = baselineIndex(baseline);
  return draft.entries.map((entry) => entryToInput(entry, index.get(entry.key)));
}

/** 草稿 → `PUT /api/lorebooks/:id` 请求体 */
export function lorebookDraftToRequest(
  draft: LorebookDraft,
  baseline: LorebookDraft,
): LorebookUpdateInput {
  return { name: draft.name.trim(), entries: lorebookDraftToEntries(draft, baseline) };
}

export function isLorebookDraftValid(draft: LorebookDraft): boolean {
  return draft.name.trim() !== '';
}

export function isLorebookDraftDirty(baseline: LorebookDraft, draft: LorebookDraft): boolean {
  if (draft === baseline) return false;
  if (draft.name.trim() !== baseline.name) return true;
  if (draft.entries.length !== baseline.entries.length) return true;
  const index = baselineIndex(baseline);
  return draft.entries.some((entry, i) => {
    if (entry.key !== baseline.entries[i]?.key) return true;
    const base = index.get(entry.key);
    return entry !== base && (!base || entryChanged(entry, base));
  });
}

/* ------------------------------------------------------------------ */
/* 改草稿（全部返回新对象）                                             */
/* ------------------------------------------------------------------ */

/** 改一条：基线里该字段本是 null（原文件没有）时，关掉 / 清空写回 null */
export function patchLorebookEntry(
  draft: LorebookDraft,
  baseline: LorebookDraft,
  key: string,
  patch: LorebookEntryPatch,
): LorebookDraft {
  const base = baselineIndex(baseline).get(key);
  const next: Record<string, unknown> = { ...patch };
  for (const [field, value] of Object.entries(next)) {
    if (
      base &&
      NULL_WHEN_EMPTY.has(field as LorebookEntryField) &&
      base[field as LorebookEntryField] === null &&
      (value === false || value === '')
    ) {
      next[field] = null;
    }
  }
  return {
    ...draft,
    entries: draft.entries.map((entry) => (entry.key === key ? { ...entry, ...next } : entry)),
  };
}

export function moveLorebookEntry(draft: LorebookDraft, key: string, delta: -1 | 1): LorebookDraft {
  const from = draft.entries.findIndex((entry) => entry.key === key);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= draft.entries.length) return draft;
  const entries = [...draft.entries];
  [entries[from], entries[to]] = [entries[to]!, entries[from]!];
  return { ...draft, entries };
}

export function newLorebookEntry(key = `new:${crypto.randomUUID()}`): LorebookEntryDraft {
  return { ...NEW_LOREBOOK_ENTRY, keys: [], secondaryKeys: [], key };
}

export function addLorebookEntry(draft: LorebookDraft, entry: LorebookEntryDraft): LorebookDraft {
  return { ...draft, entries: [entry, ...draft.entries] };
}

export function deleteLorebookEntry(draft: LorebookDraft, key: string): LorebookDraft {
  return { ...draft, entries: draft.entries.filter((entry) => entry.key !== key) };
}

/** 标题：comment，空时退到首个关键词 */
export function entryTitle(draft: LorebookEntryDraft): string {
  return draft.comment?.trim() || draft.keys[0]?.trim() || '';
}

export function entryMatches(draft: LorebookEntryDraft, query: string): boolean {
  return (
    (draft.comment ?? '').toLowerCase().includes(query) ||
    draft.keys.some((key) => key.toLowerCase().includes(query)) ||
    draft.secondaryKeys.some((key) => key.toLowerCase().includes(query)) ||
    draft.content.toLowerCase().includes(query)
  );
}
