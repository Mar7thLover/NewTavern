import { validateJsonSchema, type SchemaIssue } from '@newtavern/core';

/**
 * 变量管理器的纯逻辑（M5（三）契约 §1）：路径读写、增删改名、类型切换、改动计数、schema 标错。
 * 组件（`VariableEditor.tsx`）只管显示与交互，全部改动都经这里产生一份新表（不可变更新）。
 *
 * 路径用段数组（`['stat_data', '昔涟', '好感度']`、数组下标是 number），
 * 显示与对 schema 问题时用 `pathKey`（与 core `validateJsonSchema` 的写法一致：`a.b[0]`）。
 */

export type Segment = string | number;
export type Path = readonly Segment[];
export type VariableTable = Record<string, unknown>;

/** 叶子的四种编辑形态（契约：字符串、数字、布尔、null、JSON 文本） */
export type LeafKind = 'string' | 'number' | 'boolean' | 'null' | 'json';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** MVU 的 `[值, "说明"]` 二元组：当叶子编辑，只改 `[0]`，说明只读 */
export function isValueWithDescription(value: unknown): value is [unknown, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[1] === 'string' &&
    (value[0] === null || typeof value[0] !== 'object')
  );
}

export function pathKey(path: Path): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else out = out === '' ? segment : `${out}.${segment}`;
  }
  return out;
}

export function getAt(root: unknown, path: Path): unknown {
  let cursor = root;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string | number, unknown>)[segment];
  }
  return cursor;
}

/** 不可变地更新路径上的值；`updater` 收到旧值返回新值 */
export function updateAt(root: VariableTable, path: Path, updater: (value: unknown) => unknown): VariableTable {
  const walk = (node: unknown, index: number): unknown => {
    if (index === path.length) return updater(node);
    const segment = path[index] as Segment;
    if (Array.isArray(node)) {
      const copy = [...node];
      copy[segment as number] = walk(node[segment as number], index + 1);
      return copy;
    }
    const base = isRecord(node) ? node : {};
    return { ...base, [segment]: walk(base[segment as string], index + 1) };
  };
  return walk(root, 0) as VariableTable;
}

export function setAt(root: VariableTable, path: Path, value: unknown): VariableTable {
  return updateAt(root, path, () => value);
}

/** 删一个键 / 一个数组元素 */
export function deleteAt(root: VariableTable, path: Path): VariableTable {
  if (path.length === 0) return root;
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1] as Segment;
  const remove = (parent: unknown): unknown => {
    if (Array.isArray(parent)) return parent.filter((_, index) => index !== last);
    if (!isRecord(parent)) return parent;
    const copy = { ...parent };
    delete copy[last as string];
    return copy;
  };
  if (parentPath.length === 0) return remove(root) as VariableTable;
  return updateAt(root, parentPath, remove);
}

/** 改键名，保留键的顺序；新名已存在时返回 null（不覆盖别的键） */
export function renameAt(root: VariableTable, path: Path, nextName: string): VariableTable | null {
  const last = path[path.length - 1];
  if (typeof last !== 'string' || nextName === '' || nextName === last) return root;
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length === 0 ? root : getAt(root, parentPath);
  if (!isRecord(parent) || nextName in parent) return null;
  const renamed = Object.fromEntries(
    Object.entries(parent).map(([key, value]) => [key === last ? nextName : key, value]),
  );
  return parentPath.length === 0 ? renamed : updateAt(root, parentPath, () => renamed);
}

/** 对象加键（值缺省为空串）/ 数组追加；键已存在返回 null */
export function addChild(root: VariableTable, path: Path, key: string, value: unknown = ''): VariableTable | null {
  const target = path.length === 0 ? root : getAt(root, path);
  if (Array.isArray(target)) return updateAt(root, path, () => [...target, value]);
  if (!isRecord(target)) return null;
  if (key === '' || key in target) return null;
  return path.length === 0 ? { ...root, [key]: value } : updateAt(root, path, () => ({ ...target, [key]: value }));
}

export function kindOf(value: unknown): LeafKind {
  if (value === null) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'string') return 'string';
  return 'json';
}

/** 切类型：尽量保留原值的意思（`"12"` → 12、`true` → `"true"`） */
export function convertValue(value: unknown, kind: LeafKind): unknown {
  switch (kind) {
    case 'string':
      return value === null || value === undefined
        ? ''
        : typeof value === 'string'
          ? value
          : JSON.stringify(value);
    case 'number': {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    case 'boolean':
      return value === true || value === 'true' || value === 1;
    case 'null':
      return null;
    case 'json':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return {};
        }
      }
      return typeof value === 'object' && value !== null ? value : {};
  }
}

/**
 * 两张表之间的改动处数：按叶子路径比较（新增、删除、改值各算一处）。
 * `[值, 说明]` 当一个叶子。
 */
export function countChanges(before: unknown, after: unknown): number {
  const leaves = (value: unknown, prefix: string, out: Map<string, string>) => {
    if (isValueWithDescription(value) || value === null || typeof value !== 'object') {
      out.set(prefix, JSON.stringify(value) ?? 'undefined');
      return out;
    }
    const entries = Array.isArray(value)
      ? value.map((item, index) => [`${prefix}[${index}]`, item] as const)
      : Object.entries(value).map(([key, item]) => [prefix === '' ? key : `${prefix}.${key}`, item] as const);
    if (entries.length === 0) out.set(prefix, Array.isArray(value) ? '[]' : '{}');
    for (const [key, item] of entries) leaves(item, key, out);
    return out;
  };
  const left = leaves(before ?? {}, '', new Map());
  const right = leaves(after ?? {}, '', new Map());
  let changes = 0;
  for (const [key, value] of right) if (left.get(key) !== value) changes += 1;
  for (const key of left.keys()) if (!right.has(key)) changes += 1;
  return changes;
}

/** schema 问题按路径分组；`[值,说明]` 的 `x[0]` 同时记到 `x` 上（叶子行按自己的路径查） */
export function issuesByPath(value: unknown, schema: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!schema) return out;
  const push = (key: string, message: string) => {
    const list = out.get(key) ?? [];
    list.push(message);
    out.set(key, list);
  };
  for (const issue of validateJsonSchema(value, schema) as SchemaIssue[]) {
    push(issue.path, issue.message);
    if (issue.path.endsWith('[0]')) push(issue.path.slice(0, -3), issue.message);
  }
  return out;
}

/** 键是不是簿记键（`$meta` / `$internal` …）：默认折叠 */
export function isBookkeepingKey(key: Segment): boolean {
  return typeof key === 'string' && key.startsWith('$');
}
