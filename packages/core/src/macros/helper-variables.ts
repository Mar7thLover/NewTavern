/**
 * 酒馆助手的变量宏：`{{get_<表>_variable::路径}}` 与 `{{format_<表>_variable::路径}}`。
 *
 * 为什么 core 必须认它们：MVU 卡的提示词里就写着
 *
 * ```text
 * <status_current_variables>
 * {{get_message_variable::stat_data}}
 * </status_current_variables>
 * ```
 *
 * 不展开的话模型看不到当前变量，整张卡的状态栏就是瞎写。行为对齐
 * JS-Slash-Runner `src/function/macro_like.ts`：
 *
 * - 表名：`message` / `chat` / `character` / `preset` / `global`；
 * - 路径按 lodash 语义取（`stat_data.三月七.好感度`、`武器栏[0]`）；
 * - **`$` 开头的键整棵子树剥掉**（MVU 把 `$meta` / `$internal` 放在变量表里，
 *   它们是簿记数据，不该进提示词）；
 * - `get_`：字符串原样、其余 `JSON.stringify`；
 * - `format_`：YAML，并且**续行按宏前面的缩进对齐**——这样把宏写在
 *   `  当前状态: {{format_message_variable::stat_data}}` 这种位置时不会破坏 YAML 结构。
 */

import { getPath } from '../variables/path.js';

/** 五张变量表。缺的表当空表，宏输出空串（与酒馆助手一致，不报错）。 */
export interface HelperVariableTables {
  message?: Record<string, unknown>;
  chat?: Record<string, unknown>;
  character?: Record<string, unknown>;
  preset?: Record<string, unknown>;
  global?: Record<string, unknown>;
}

export type HelperVariableScope = keyof HelperVariableTables;

/** 去掉 `$` 开头的键（递归）。数组原样递归，标量原样返回。 */
export function stripBookkeeping(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => stripBookkeeping(item));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('$')) continue;
      out[key] = stripBookkeeping(item);
    }
    return out;
  }
  return value;
}

/** 变量值 → 提示词里的一行（`get_` 宏） */
export function helperVariableText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* YAML 输出（`format_` 宏）                                            */
/* ------------------------------------------------------------------ */

/** 需要引号的标量：空串、首尾空白、YAML 会读成别的类型、或含结构字符 */
function needsQuotes(text: string): boolean {
  if (text === '') return true;
  if (text !== text.trim()) return true;
  if (/^(?:true|false|null|~|yes|no|on|off)$/i.test(text)) return true;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(text)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(text)) return true;
  return /: |\s#|\n/.test(text);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  if (!needsQuotes(text)) return text;
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object' && value !== null) return Object.keys(value).length === 0;
  return false;
}

/** 极简 YAML 输出：只处理 JSON 能表达的形状，够状态栏用。 */
export function formatYaml(value: unknown, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value
      .map((item) => {
        if (typeof item === 'object' && item !== null && !isEmptyContainer(item)) {
          const body = formatYaml(item, indent + 2);
          // 容器元素：`- ` 后面接第一行，其余行跟着缩进
          return `${pad}- ${body.slice(indent + 2)}`;
        }
        return `${pad}- ${isEmptyContainer(item) ? formatYaml(item) : scalar(item)}`;
      })
      .join('\n');
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries
      .map(([key, item]) => {
        if (typeof item === 'object' && item !== null && !isEmptyContainer(item)) {
          return `${pad}${scalar(key)}:\n${formatYaml(item, indent + 2)}`;
        }
        return `${pad}${scalar(key)}: ${isEmptyContainer(item) ? formatYaml(item) : scalar(item)}`;
      })
      .join('\n');
  }
  return `${pad}${scalar(value)}`;
}

/** 首行不缩进、续行按 `prefix` 的长度对齐（酒馆助手 `applyFormatVariable` 的做法） */
export function alignContinuationLines(text: string, prefixLength: number): string {
  if (prefixLength <= 0 || !text.includes('\n')) return text;
  return text.replaceAll('\n', `\n${' '.repeat(prefixLength)}`);
}

/* ------------------------------------------------------------------ */
/* 宏                                                                  */
/* ------------------------------------------------------------------ */

const SCOPES = 'message|chat|character|preset|global';

export const HELPER_GET_RE = new RegExp(`\\{\\{get_(${SCOPES})_variable::(.*?)\\}\\}`, 'gi');
export const HELPER_FORMAT_RE = new RegExp(
  `^(.*)\\{\\{format_(${SCOPES})_variable::(.*?)\\}\\}`,
  'gim',
);

function readValue(
  tables: HelperVariableTables,
  scope: string,
  path: string,
): unknown {
  const table = tables[scope.toLowerCase() as HelperVariableScope];
  if (!table) return undefined;
  const trimmed = path.trim();
  return stripBookkeeping(trimmed === '' ? table : getPath(table, trimmed));
}

/** `{{get_…_variable::path}}` 的展开 */
export function expandHelperGet(tables: HelperVariableTables, scope: string, path: string): string {
  return helperVariableText(readValue(tables, scope, path));
}

/** 同一行里写了多个 `format_` 宏时，贪婪的 `^(.*)` 会把前面的宏留在 prefix 里 */
const NESTED_FORMAT_RE = new RegExp(`^(.*)\\{\\{format_(${SCOPES})_variable::(.*?)\\}\\}`, 'i');

/** `{{format_…_variable::path}}` 的展开（返回「宏前缀 + YAML」整段） */
export function expandHelperFormat(
  tables: HelperVariableTables,
  rawPrefix: string,
  scope: string,
  path: string,
): string {
  // 先把 prefix 里可能还剩的同类宏展开（酒馆助手 `applyFormatVariable` 的递归）
  const nested = NESTED_FORMAT_RE.exec(rawPrefix);
  const prefix = nested
    ? expandHelperFormat(tables, nested[1] ?? '', nested[2] ?? '', nested[3] ?? '') +
      rawPrefix.slice(nested[0].length)
    : rawPrefix;
  const value = readValue(tables, scope, path);
  const text =
    value === undefined || value === null
      ? ''
      : typeof value === 'string'
        ? value
        : formatYaml(value).trimEnd();
  return prefix + alignContinuationLines(text, prefix.length);
}
