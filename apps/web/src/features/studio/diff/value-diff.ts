import { diffArrays } from 'diff';

/*
 * 结构化的值差异（纯函数，单测直接测）：改动行的 before / after 不再整段吐 JSON，而是
 * - 字符串 / 数字 / 布尔：一段文字（字符级 diff 在组件里做）；
 * - 数组：按条目对齐——新增的整条、删掉的整条、改动的条目内部再比；没变的条目收成「N 条未变」；
 * - 对象：按「字段名：值」逐项列出，只列变了的字段，其余计数；嵌套结构复杂时给原始 JSON 备查。
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export type DiffStatus = 'add' | 'del' | 'change' | 'same';

export type ValueDiff =
  | { kind: 'text'; before: string; after: string; hasBefore: boolean; hasAfter: boolean }
  | { kind: 'list'; items: ListDiffItem[]; short: boolean }
  | { kind: 'fields'; rows: FieldDiffRow[]; unchanged: number; complex: boolean };

export type ListDiffItem =
  | {
      status: Exclude<DiffStatus, 'same'>;
      /** 在新列表（删除项为旧列表）里的序号，从 0 */
      index: number;
      diff: ValueDiff;
    }
  | { status: 'same'; count: number };

export interface FieldDiffRow {
  key: string;
  status: Exclude<DiffStatus, 'same'>;
  diff: ValueDiff;
}

/** 基本值 → 文字（null / undefined 为空串） */
export function primitiveText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/** 短字符串数组（标签、关键词）：适合排成一行小块 */
function isShortList(values: unknown[]): boolean {
  return values.every(
    (item) =>
      (typeof item === 'string' || typeof item === 'number') &&
      String(item).length <= 24 &&
      !String(item).includes('\n'),
  );
}

/** 是否有嵌套的对象 / 对象数组（这类才给原始 JSON 备查） */
function isComplex(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => isRecord(item) || Array.isArray(item));
  if (isRecord(value))
    return Object.values(value).some((item) => isRecord(item) || Array.isArray(item));
  return false;
}

export function diffValue(
  before: unknown,
  after: unknown,
  hasBefore = before !== undefined,
  hasAfter = after !== undefined,
): ValueDiff {
  const b = hasBefore ? before : undefined;
  const a = hasAfter ? after : undefined;
  const bothListish =
    (Array.isArray(b) || b === undefined || b === null) &&
    (Array.isArray(a) || a === undefined || a === null) &&
    (Array.isArray(a) || Array.isArray(b));
  if (bothListish) {
    const oldList = Array.isArray(b) ? b : [];
    const newList = Array.isArray(a) ? a : [];
    return {
      kind: 'list',
      items: diffList(oldList, newList),
      short: isShortList([...oldList, ...newList]),
    };
  }
  const bothRecordish =
    (isRecord(b) || b === undefined || b === null) &&
    (isRecord(a) || a === undefined || a === null) &&
    (isRecord(a) || isRecord(b));
  if (bothRecordish) {
    const oldObj = isRecord(b) ? b : {};
    const newObj = isRecord(a) ? a : {};
    const rows: FieldDiffRow[] = [];
    let unchanged = 0;
    for (const key of new Set([...Object.keys(oldObj), ...Object.keys(newObj)])) {
      const inOld = Object.hasOwn(oldObj, key);
      const inNew = Object.hasOwn(newObj, key);
      if (inOld && inNew && sameJson(oldObj[key], newObj[key])) {
        unchanged += 1;
        continue;
      }
      rows.push({
        key,
        status: inOld && inNew ? 'change' : inNew ? 'add' : 'del',
        diff: diffValue(oldObj[key], newObj[key], inOld, inNew),
      });
    }
    return { kind: 'fields', rows, unchanged, complex: isComplex(b) || isComplex(a) };
  }
  return {
    kind: 'text',
    before: primitiveText(b),
    after: primitiveText(a),
    hasBefore: hasBefore && b !== undefined,
    hasAfter: hasAfter && a !== undefined,
  };
}

/**
 * 两个列表按条目对齐（`diffArrays`，整条相等才算同一条）。相邻的「删掉一段 + 新增一段」
 * 逐个配对成「改动」（条目内部再比），多出来的才算整条新增 / 删除。
 */
export function diffList(oldList: readonly unknown[], newList: readonly unknown[]): ListDiffItem[] {
  const changes = diffArrays([...oldList], [...newList], { comparator: sameJson });
  const items: ListDiffItem[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  let removed: unknown[] = [];
  const flush = (added: unknown[]) => {
    const paired = Math.min(removed.length, added.length);
    for (let i = 0; i < paired; i++) {
      items.push({
        status: 'change',
        index: newIndex,
        diff: diffValue(removed[i], added[i], true, true),
      });
      oldIndex += 1;
      newIndex += 1;
    }
    for (let i = paired; i < removed.length; i++) {
      items.push({
        status: 'del',
        index: oldIndex,
        diff: diffValue(removed[i], undefined, true, false),
      });
      oldIndex += 1;
    }
    for (let i = paired; i < added.length; i++) {
      items.push({
        status: 'add',
        index: newIndex,
        diff: diffValue(undefined, added[i], false, true),
      });
      newIndex += 1;
    }
    removed = [];
  };
  for (const change of changes) {
    if (change.removed) {
      removed = [...removed, ...change.value];
    } else if (change.added) {
      flush(change.value);
    } else {
      flush([]);
      items.push({ status: 'same', count: change.value.length });
      oldIndex += change.value.length;
      newIndex += change.value.length;
    }
  }
  flush([]);
  return items;
}
