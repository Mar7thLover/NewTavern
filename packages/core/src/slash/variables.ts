/**
 * slash 变量命令的读写语义。照 ST `public/scripts/variables.js` 的
 * `getLocalVariable` / `setLocalVariable` / `addLocalVariable` 核对，差异如下：
 *
 * - ST 的变量表里全是**字符串**（数组 / 对象存成 JSON 文本）；新酒馆的变量表是 JSON 值
 *   （MVU 的 `stat_data` 就在里面），所以：
 *   - `key` 除了精确键名，还认点路径（`stat_data.好感度`）——表里有同名键时优先精确键；
 *   - `/setvar` 覆盖一个**数字 / 布尔**时，数字样 / `true|false` 的文本按原类型写回，
 *     其余写字符串（不然一条 `/setvar key=stat_data.好感度 50` 就把 MVU 的数字变成了 "50"）；
 *   - `index=` 写进去的容器存成真正的数组 / 对象，而不是 JSON 文本；
 * - MVU 的 `[值, "说明"]` 二元组：`/getvar` 读出值本身，`/setvar` `/addvar` 只改 `[0]`、保留说明
 *   （与 MVU 的 `_.set` 同一条特判）。
 */

import { getPath, hasPath, setPath, unsetPath } from '../variables/path.js';
import type { SlashHost, SlashVarScope } from './types.js';

type Table = Record<string, unknown>;

function isClosureLike(value: unknown): value is { kind: 'closure'; node: { raw: string } } {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'closure'
  );
}

/** MVU 的「带说明的值」：`[值, "说明"]` */
export function isValueWithDescription(value: unknown): value is [unknown, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[1] === 'string' &&
    (value[0] === null || typeof value[0] !== 'object')
  );
}

/** 值 → 管道文本：字符串原样，数字布尔转字符串，对象数组 JSON，undefined / null 空串 */
export function displayValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (isClosureLike(value)) return value.node.raw;
  return JSON.stringify(value);
}

function hasKey(table: Table, key: string): boolean {
  return Object.hasOwn(table, key);
}

function getIn(table: Table, key: string): unknown {
  if (hasKey(table, key)) return table[key];
  return getPath(table, key);
}

function setIn(table: Table, key: string, value: unknown): void {
  if (hasKey(table, key) || !/[.[]/.test(key)) {
    table[key] = value;
    return;
  }
  setPath(table, key, value);
}

export function existsVar(table: Table, key: string): boolean {
  return hasKey(table, key) || hasPath(table, key);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** ST `convertValueType`（`as=`） */
export function convertValueType(value: string, type: string | undefined): unknown {
  switch ((type ?? 'string').toLowerCase()) {
    case 'number': {
      const number = Number(value);
      return Number.isNaN(number) ? value : number;
    }
    case 'int':
      return Number.parseInt(value, 10);
    case 'float':
      return Number.parseFloat(value);
    case 'bool':
    case 'boolean':
      return ['true', 'on', '1', 'yes'].includes(value.trim().toLowerCase());
    case 'list':
    case 'array':
    case 'object':
    case 'dictionary':
    case 'json':
      return parseMaybeJson(value);
    case 'null':
      return null;
    default:
      return value;
  }
}

/** 覆盖旧值时尽量保持它原来的类型（见文件头） */
function coerceLike(previous: unknown, value: string): unknown {
  if (typeof previous === 'number') {
    const number = Number(value);
    if (value.trim() !== '' && !Number.isNaN(number)) return number;
  }
  if (typeof previous === 'boolean') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true') return true;
    if (lower === 'false') return false;
  }
  return value;
}

/** 读一个变量（不存在 = undefined）；VWD 取值本身 */
export async function readVar(
  host: SlashHost,
  scope: SlashVarScope,
  key: string,
  index?: string,
): Promise<unknown> {
  const table = await host.readVariables(scope);
  let value = getIn(table, key);
  if (isValueWithDescription(value)) value = value[0];
  if (index !== undefined && index !== '') {
    const container = parseMaybeJson(value);
    if (typeof container !== 'object' || container === null) return undefined;
    const numeric = Number(index);
    value =
      Array.isArray(container) && !Number.isNaN(numeric)
        ? container[numeric]
        : (container as Table)[index];
  }
  return value;
}

/** `/setvar`：返回写进去的值 */
export async function writeVar(
  host: SlashHost,
  scope: SlashVarScope,
  key: string,
  value: string,
  options: { index?: string; as?: string } = {},
): Promise<unknown> {
  if (key === '') throw new Error('变量名不能为空');
  const table = await host.readVariables(scope);
  const previous = getIn(table, key);

  if (options.index !== undefined && options.index !== '') {
    let container = parseMaybeJson(previous);
    const numeric = Number(options.index);
    const useArray = !Number.isNaN(numeric);
    if (typeof container !== 'object' || container === null) container = useArray ? [] : {};
    const converted = convertValueType(value, options.as);
    if (Array.isArray(container) && useArray) container[numeric] = converted;
    else (container as Table)[options.index] = converted;
    setIn(table, key, container);
    await host.writeVariables(scope, table);
    return converted;
  }

  let next: unknown = options.as ? convertValueType(value, options.as) : value;
  if (isValueWithDescription(previous)) {
    const inner = options.as ? next : coerceLike(previous[0], value);
    setIn(table, key, [inner, previous[1]]);
    await host.writeVariables(scope, table);
    return inner;
  }
  if (!options.as) next = coerceLike(previous, value);
  setIn(table, key, next);
  await host.writeVariables(scope, table);
  return next;
}

/** `/addvar`：数组就 push，两边都是数字就相加，否则字符串拼接（ST addLocalVariable） */
export async function addVar(
  host: SlashHost,
  scope: SlashVarScope,
  key: string,
  value: string,
): Promise<unknown> {
  if (key === '') throw new Error('变量名不能为空');
  const table = await host.readVariables(scope);
  const stored = getIn(table, key);
  const vwd = isValueWithDescription(stored) ? stored : null;
  const current = vwd ? vwd[0] : stored;

  const write = async (next: unknown): Promise<void> => {
    setIn(table, key, vwd ? [next, vwd[1]] : next);
    await host.writeVariables(scope, table);
  };

  const parsed = parseMaybeJson(current);
  if (Array.isArray(parsed)) {
    const list = [...(parsed as unknown[]), value];
    // 原来存的是 JSON 文本就还存文本（ST 表里就是这样的）
    await write(typeof current === 'string' ? JSON.stringify(list) : list);
    return list;
  }

  const base = current === undefined || current === null || current === '' ? 0 : current;
  const increment = Number(value);
  const baseNumber = typeof base === 'number' ? base : Number(base);
  if (value.trim() === '' || Number.isNaN(increment) || Number.isNaN(baseNumber)) {
    const text = `${base === 0 ? '' : displayValue(base)}${value}`;
    await write(text);
    return text;
  }
  const sum = baseNumber + increment;
  await write(sum);
  return sum;
}

/** `/flushvar`：删掉一个变量（不存在就什么都不做） */
export async function deleteVar(host: SlashHost, scope: SlashVarScope, key: string): Promise<void> {
  const table = await host.readVariables(scope);
  if (hasKey(table, key)) {
    delete table[key];
  } else if (!unsetPath(table, key)) {
    return;
  }
  await host.writeVariables(scope, table);
}
