/**
 * MVU 变量更新引擎：把 `<UpdateVariable>` 里的命令应用到一份 `MvuData` 上。
 *
 * 语义对齐 MagVarUpdate `updateVariables`（2026-09 版）：
 *
 * - `set` **要求路径已存在**（变量表由 `[InitVar]` 定义，模型不能凭空造字段）；
 *   路径为空串时整表替换。
 * - **VWD（带说明的值）**：`[值, "说明"]` 这种二元组是社区最常见的 InitVar 写法，
 *   `set` 只改 `[0]` 并保留说明；旧值是数字时新值强制转数字（模型爱写 `"35"`）。
 * - `insert`/`assign`：数组 push、对象 merge，三参形式按下标 / 键插入。
 * - `delete`/`remove`/`unset`：删键、按下标或按值删数组元素。
 * - `add`：数值加减（负数就是减）；布尔值用 `true` 取反。
 * - `move`：JSON Patch 的 move。
 * - 每条命令都写进 `display_data`（全表副本，改过的位置变成 `旧->新 (理由)`）
 *   与 `delta_data`（只有改过的位置），两者都放在 `MvuData` 顶层，
 *   `stat_data` 里只有变量本身（MVU 更新过程中会临时挂 `$internal`，收尾也会删掉）。
 *
 * 不做的事（见 docs/M5-CONTRACT.md 兼容矩阵）：路径级 schema（`generateSchema`/
 * `reconcileAndApplySchema`）、模板数组（`template`）、额外模型二次解析、mathjs 全量表达式。
 */

import { commandPath, extractCommands, type MvuCommand } from './commands.js';
import { clone, getPath, hasPath, pathFix, setPath, toPath, unsetPath } from './path.js';
import { parseCommandValue } from './value.js';

/** 变量表：`stat_data` 是真正的数据，其余键（`initialized_lorebooks` 等）是 MVU 的簿记 */
export interface MvuData {
  /** 已经吃过 `[InitVar]` 的世界书：`书名 → 条目标识`，避免重复初始化 */
  initialized_lorebooks: Record<string, string[]>;
  stat_data: Record<string, unknown>;
  display_data?: Record<string, unknown>;
  delta_data?: Record<string, unknown>;
  [key: string]: unknown;
}

/** InitVar `$meta` 里的全局开关（路径级 schema 不支持，见文件头） */
export interface MvuMeta {
  /** false = 不允许 insert 出新键 / 新元素 */
  extensible?: boolean;
  /** true = 关掉 VWD 特判，`set` 整体替换 */
  strictSet?: boolean;
}

export interface MvuUpdate {
  type: MvuCommand['type'];
  path: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  /** `旧->新 (理由)`，写进 display_data / delta_data */
  display: string;
}

export interface MvuError {
  command: string;
  message: string;
}

export interface MvuRunResult {
  /** 有没有任何一条命令真的改动了变量 */
  changed: boolean;
  /** 应用后的变量表（新对象，入参不会被改） */
  data: MvuData;
  /** 应用前的变量表（`mag_variable_update_ended` 的第二个参数） */
  before: MvuData;
  commands: MvuCommand[];
  updates: MvuUpdate[];
  errors: MvuError[];
}

export interface MvuRunOptions {
  /** InitVar 的 `$meta`；缺省从 `stat_data.$meta` 读 */
  meta?: MvuMeta;
  /** 命令文本里的宏替换（`{{user}}`）。服务端传组装器的宏引擎。 */
  substituteMacros?: (text: string) => string;
}

/** 空变量表 */
export function emptyMvuData(): MvuData {
  return { initialized_lorebooks: {}, stat_data: {} };
}

/** 任意 JSON 值 → MvuData（旧数据、手写数据都可能缺字段） */
export function toMvuData(value: unknown): MvuData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return emptyMvuData();
  const record = value as Record<string, unknown>;
  const stat = record.stat_data;
  const books = record.initialized_lorebooks;
  return {
    ...record,
    initialized_lorebooks:
      typeof books === 'object' && books !== null && !Array.isArray(books)
        ? (books as Record<string, string[]>)
        : {},
    stat_data: typeof stat === 'object' && stat !== null && !Array.isArray(stat) ? { ...(stat as Record<string, unknown>) } : {},
  };
}

/** 变量表里有没有 MVU 的痕迹（用来决定这条消息要不要跑引擎） */
export function hasMvuData(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const stat = (value as Record<string, unknown>).stat_data;
  return typeof stat === 'object' && stat !== null && Object.keys(stat as object).length > 0;
}

function readMeta(data: MvuData, override?: MvuMeta): MvuMeta {
  if (override) return override;
  const meta = data.stat_data.$meta;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return {};
  const record = meta as Record<string, unknown>;
  return {
    ...(typeof record.extensible === 'boolean' ? { extensible: record.extensible } : {}),
    ...(typeof record.strictSet === 'boolean' ? { strictSet: record.strictSet } : {}),
  };
}

/** JSON 化再去掉外层引号（MVU 的 display 文本就是这么拼的） */
function short(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function displayText(oldValue: unknown, newValue: unknown, reason: string): string {
  const suffix = reason ? ` (${reason})` : '';
  return `${short(oldValue)}->${short(newValue)}${suffix}`;
}

/** `[值, "说明"]`：社区 InitVar 最常见的写法，`set`/`add` 只动 `[0]` */
function isValueWithDescription(value: unknown): value is [unknown, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[1] === 'string' &&
    !Array.isArray(value[0])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 应用一串命令。命令来自 `extractCommands`，或调用方自己造（脚本改过的命令）。
 */
export function applyCommands(
  input: MvuData,
  commands: readonly MvuCommand[],
  options: MvuRunOptions = {},
): MvuRunResult {
  const before = clone(toMvuData(input));
  const data = clone(toMvuData(input));
  const meta = readMeta(data, options.meta);
  const updates: MvuUpdate[] = [];
  const errors: MvuError[] = [];

  // display_data = 全表副本（改过的位置替换成文本），delta_data 只留改过的位置
  const display: Record<string, unknown> = clone(data.stat_data);
  delete display.$internal;
  const delta: Record<string, unknown> = {};

  const fail = (command: MvuCommand, message: string) => {
    errors.push({ command: command.full_match, message });
  };

  const record = (update: MvuUpdate) => {
    updates.push(update);
    if (update.path !== '') {
      setPath(display, update.path, update.display);
      setPath(delta, update.path, update.display);
    }
  };

  for (const command of commands) {
    const rawPath = commandPath(command);
    const path = command.reason === 'json_patch' ? rawPath : pathFix(rawPath);
    const reason = command.reason === 'json_patch' ? '' : command.reason;

    switch (command.type) {
      case 'set': {
        const valueLiteral = command.args[command.args.length - 1] ?? '';
        const substituted = options.substituteMacros
          ? options.substituteMacros(valueLiteral)
          : valueLiteral;
        const newValue = parseCommandValue(substituted);

        if (path === '') {
          if (!isRecord(newValue)) {
            fail(command, '整表替换的值必须是对象');
            break;
          }
          const oldValue = clone(data.stat_data);
          data.stat_data = newValue;
          record({
            type: 'set',
            path: '',
            oldValue,
            newValue,
            reason,
            display: displayText('<stat_data>', '<stat_data>', reason),
          });
          break;
        }
        if (!hasPath(data.stat_data, path)) {
          fail(command, `set 的路径不存在：${path}（变量要先由 [InitVar] 定义）`);
          break;
        }
        const current = getPath(data.stat_data, path);
        if (!meta.strictSet && isValueWithDescription(current)) {
          const oldValue = clone(current[0]);
          const coerced =
            typeof oldValue === 'number' && newValue !== null && typeof newValue !== 'object'
              ? Number(newValue)
              : newValue;
          const next: [unknown, string] = [
            Number.isNaN(coerced as number) && typeof oldValue === 'number' ? newValue : coerced,
            current[1],
          ];
          setPath(data.stat_data, path, next);
          record({
            type: 'set',
            path,
            oldValue,
            newValue: next[0],
            reason,
            display: displayText(oldValue, next[0], reason),
          });
          break;
        }
        const oldValue = clone(current);
        // 旧值是数字、新值是数字字符串 → 存成数字（模型经常写 `'35'`）
        const coerced =
          typeof oldValue === 'number' && typeof newValue === 'string' && newValue.trim() !== ''
            ? Number(newValue)
            : newValue;
        const finalValue = typeof coerced === 'number' && Number.isNaN(coerced) ? newValue : coerced;
        setPath(data.stat_data, path, finalValue);
        record({
          type: 'set',
          path,
          oldValue,
          newValue: finalValue,
          reason,
          display: displayText(oldValue, finalValue, reason),
        });
        break;
      }

      case 'add': {
        if (!hasPath(data.stat_data, path)) {
          fail(command, `add 的路径不存在：${path}`);
          break;
        }
        const current = getPath(data.stat_data, path);
        const vwd = !meta.strictSet && isValueWithDescription(current);
        const target = vwd ? (current as [unknown, string])[0] : current;
        const deltaValue = parseCommandValue(command.args[1] ?? '');

        if (typeof target === 'boolean') {
          // `_.add('开关', true);` = 取反（MVU 的 toggle 语义）
          const next = deltaValue === true || deltaValue === 'toggle' ? !target : Boolean(deltaValue);
          const written = vwd ? [next, (current as [unknown, string])[1]] : next;
          setPath(data.stat_data, path, written);
          record({
            type: 'add',
            path,
            oldValue: target,
            newValue: next,
            reason,
            display: displayText(target, next, reason),
          });
          break;
        }
        const base = Number(target);
        const step = Number(deltaValue);
        if (!Number.isFinite(base) || !Number.isFinite(step)) {
          fail(command, `add 只能作用在数字上：${path}`);
          break;
        }
        const next = Number.parseFloat((base + step).toPrecision(12));
        const written = vwd ? [next, (current as [unknown, string])[1]] : next;
        setPath(data.stat_data, path, written);
        record({
          type: 'add',
          path,
          oldValue: base,
          newValue: next,
          reason,
          display: displayText(base, next, reason),
        });
        break;
      }

      case 'insert': {
        const container = path === '' ? data.stat_data : getPath(data.stat_data, path);
        const threeArg = command.args.length >= 3;
        const valueLiteral = command.args[threeArg ? 2 : 1] ?? '';
        const value = parseCommandValue(valueLiteral);
        const key = threeArg ? parseCommandValue(command.args[1] ?? '') : undefined;

        if (container !== undefined && container !== null && !isRecord(container) && !Array.isArray(container)) {
          fail(command, `insert 的目标不是容器：${path}（${typeof container}）`);
          break;
        }
        let target = container;
        if (target === undefined || target === null) {
          if (meta.extensible === false) {
            fail(command, `insert 的路径不存在且变量表不可扩展：${path}`);
            break;
          }
          target = typeof key === 'number' || Array.isArray(value) ? [] : {};
          if (path === '') data.stat_data = target as Record<string, unknown>;
          else setPath(data.stat_data, path, target);
        }

        const oldValue = clone(target);
        if (Array.isArray(target)) {
          const index =
            key === undefined || key === '-' || !Number.isInteger(Number(key))
              ? target.length
              : Math.max(0, Math.min(target.length, Number(key)));
          target.splice(index, 0, value);
          record({
            type: 'insert',
            path,
            oldValue,
            newValue: value,
            reason,
            display: `+${short(value)} @${index}${reason ? ` (${reason})` : ''}`,
          });
          break;
        }
        if (threeArg) {
          const objectKey = String(key);
          if (meta.extensible === false && !Object.hasOwn(target, objectKey)) {
            fail(command, `insert 想加新键但变量表不可扩展：${path}.${objectKey}`);
            break;
          }
          (target as Record<string, unknown>)[objectKey] = value;
          record({
            type: 'insert',
            path: path === '' ? objectKey : `${path}.${objectKey}`,
            oldValue: undefined,
            newValue: value,
            reason,
            display: displayText(undefined, value, reason),
          });
          break;
        }
        if (!isRecord(value)) {
          fail(command, `insert 往对象里合并的值必须是对象：${path}`);
          break;
        }
        if (meta.extensible === false) {
          const unknownKey = Object.keys(value).find((item) => !Object.hasOwn(target as object, item));
          if (unknownKey !== undefined) {
            fail(command, `insert 想加新键但变量表不可扩展：${path}.${unknownKey}`);
            break;
          }
        }
        for (const [itemKey, itemValue] of Object.entries(value)) {
          (target as Record<string, unknown>)[itemKey] = itemValue;
          record({
            type: 'insert',
            path: path === '' ? itemKey : `${path}.${itemKey}`,
            oldValue: undefined,
            newValue: itemValue,
            reason,
            display: displayText(undefined, itemValue, reason),
          });
        }
        break;
      }

      case 'delete': {
        if (command.args.length >= 2) {
          const container = path === '' ? data.stat_data : getPath(data.stat_data, path);
          const key = parseCommandValue(command.args[1] ?? '');
          if (Array.isArray(container)) {
            const index =
              typeof key === 'number' && Number.isInteger(key)
                ? key
                : container.findIndex((item) => item === key || short(item) === short(key));
            if (index < 0 || index >= container.length) {
              fail(command, `remove 找不到要删的元素：${path}[${short(key)}]`);
              break;
            }
            const oldValue = clone(container[index]);
            container.splice(index, 1);
            record({
              type: 'delete',
              path,
              oldValue,
              newValue: undefined,
              reason,
              display: `-${short(oldValue)}${reason ? ` (${reason})` : ''}`,
            });
            break;
          }
          if (isRecord(container)) {
            const objectKey = String(key);
            if (!Object.hasOwn(container, objectKey)) {
              fail(command, `remove 找不到要删的键：${path}.${objectKey}`);
              break;
            }
            const oldValue = clone(container[objectKey]);
            delete container[objectKey];
            record({
              type: 'delete',
              path: path === '' ? objectKey : `${path}.${objectKey}`,
              oldValue,
              newValue: undefined,
              reason,
              display: displayText(oldValue, undefined, reason),
            });
            break;
          }
          fail(command, `remove 的目标不是容器：${path}`);
          break;
        }
        if (path === '' || !hasPath(data.stat_data, path)) {
          fail(command, `remove 的路径不存在：${path}`);
          break;
        }
        const oldValue = clone(getPath(data.stat_data, path));
        unsetPath(data.stat_data, path);
        record({
          type: 'delete',
          path,
          oldValue,
          newValue: undefined,
          reason,
          display: displayText(oldValue, undefined, reason),
        });
        break;
      }

      case 'move': {
        // move 的两个参数都是路径：args[0] = 来源（commandPath 取的就是它），args[1] = 目标
        const from = path;
        const to =
          command.reason === 'json_patch'
            ? (command.args[1] ?? '')
            : pathFix(trimPath(command.args[1]));
        if (!hasPath(data.stat_data, from)) {
          fail(command, `move 的来源不存在：${from}`);
          break;
        }
        const value = clone(getPath(data.stat_data, from));
        unsetPath(data.stat_data, from);
        if (to === '') {
          fail(command, 'move 的目标路径不能为空');
          break;
        }
        setPath(data.stat_data, to, value);
        record({
          type: 'move',
          path: to,
          oldValue: undefined,
          newValue: value,
          reason,
          display: `${from}->${to}${reason ? ` (${reason})` : ''}`,
        });
        break;
      }

      default:
        break;
    }
  }

  const changed = updates.length > 0;
  if (changed) {
    // 两份表只放在**顶层**。MVU 自己在更新过程中临时挂 `stat_data.$internal`，
    // 收尾时 `_.unset` 掉——留着会让前端卡把它当成一个角色 / 一行状态列出来
    // （真卡上验证过：黄金庭院的状态栏会多出一行「$internal」）。
    data.display_data = display;
    data.delta_data = delta;
  }
  return { changed, data, before, commands: [...commands], updates, errors };
}

function trimPath(raw: string | undefined): string {
  if (!raw) return '';
  return raw.replace(/^['"`]|['"`]$/g, '');
}

/**
 * 解析并应用一条消息里的全部变量更新命令。
 * 没有任何命令时 `changed=false`、`data` 与入参等价（调用方据此决定要不要落库）。
 */
export function applyMessage(
  input: MvuData,
  message: string,
  options: MvuRunOptions = {},
): MvuRunResult {
  const text = options.substituteMacros ? options.substituteMacros(message) : message;
  return applyCommands(input, extractCommands(text), options);
}

/** 只读取值（前端卡的 `Mvu.getMvuData(...).stat_data` 路径查询用） */
export function readStat(data: MvuData, path: string): unknown {
  return getPath(data.stat_data, pathFix(path));
}

/** 变量表里所有叶子路径（变量面板列表用；`$` 开头的簿记键不列） */
export function statPaths(data: MvuData): string[] {
  const out: string[] = [];
  const walk = (value: unknown, prefix: string) => {
    if (isValueWithDescription(value)) {
      out.push(prefix);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${prefix}[${index}]`));
      return;
    }
    if (isRecord(value)) {
      for (const [key, item] of Object.entries(value)) {
        if (key.startsWith('$')) continue;
        walk(item, prefix === '' ? key : `${prefix}.${key}`);
      }
      return;
    }
    if (prefix !== '') out.push(prefix);
  };
  walk(data.stat_data, '');
  return out;
}

/** 去掉 `$` 开头的簿记键（MVU 宏就是这么把 `$meta` / `$internal` 挡在提示词外的） */
export function stripInternal<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripInternal(item)) as unknown as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('$')) continue;
      out[key] = stripInternal(item);
    }
    return out as T;
  }
  return value;
}

export { extractCommands, toPath };
