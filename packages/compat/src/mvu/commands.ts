/**
 * 从模型输出里抽出 MVU 变量更新命令（对齐 MagVarUpdate `extractCommands`）。
 *
 * 两种写法都要认：
 *
 * ```text
 * <UpdateVariable>
 * _.set('三月七.好感度', 30, 35);//并肩作战
 * _.add('时间', 30);
 * _.insert('武器栏', '猎枪');
 * _.remove('武器栏', 0);
 * </UpdateVariable>
 * ```
 *
 * ```text
 * <JSONPatch>
 * [{ "op": "replace", "path": "/三月七/好感度", "value": 35 }]
 * </JSONPatch>
 * ```
 *
 * 为什么不用一条正则：`_.set('path', ["里面写了 _.set('x',1);//注释"]);` 这种参数里
 * 带命令片段的输出很常见，非贪婪匹配会在里面提前收尾。所以按括号配对扫（引号内的
 * 括号不算），并且**要求闭括号后紧跟分号**——这是 MVU 区分「真命令」与「正文里
 * 顺手写了个 `_.set(...)`」的办法，必须保持一致，否则同一条消息两边解析结果会不同。
 */

import { segmentsToPath, toPath, trimQuotes } from './path.js';

export type MvuCommandType = 'set' | 'insert' | 'delete' | 'add' | 'move';

export interface MvuCommand {
  type: MvuCommandType;
  /** 原文片段（错误提示与 `COMMAND_PARSED` 事件里要回显） */
  full_match: string;
  /** 参数的**原始字面量**，值的解析留到执行阶段（`parseCommandValue`） */
  args: string[];
  /** `//` 后面的理由 */
  reason: string;
}

/** 命令别名 → 规范类型（MVU 在应用前统一做一遍） */
const ALIAS: Record<string, MvuCommandType> = {
  set: 'set',
  insert: 'insert',
  assign: 'insert',
  remove: 'delete',
  unset: 'delete',
  delete: 'delete',
  add: 'add',
};

const COMMAND_RE = /_\.(set|insert|assign|remove|unset|delete|add)\(/;

const JSON_PATCH_RE =
  /<(json_?patch)>(?:\s*```[^\n]*)?((?:(?!<json_?patch>)[\s\S])*?)(?:```\s*)?<\/\1>/gi;

/** 参数数量下限（MVU 的有效性校验；不够就整条丢掉，不做「猜一个」） */
const MIN_ARGS: Record<MvuCommandType, number> = {
  set: 2,
  insert: 2,
  delete: 1,
  add: 2,
  move: 2,
};

/** 找配对的闭括号；引号（含反引号）里的括号不计数 */
export function findMatchingCloseParen(text: string, startPos: number): number {
  let depth = 1;
  let inQuote = false;
  let quoteChar = '';
  for (let i = startPos; i < text.length; i += 1) {
    const char = text[i] as string;
    if ((char === '"' || char === "'" || char === '`') && text[i - 1] !== '\\') {
      if (!inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuote = false;
      }
      continue;
    }
    if (inQuote) continue;
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 按顶层逗号切参数：引号、`[]`、`{}`、`()` 内部的逗号不算分隔符 */
export function parseParameters(params: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuote = false;
  let quoteChar = '';
  let bracket = 0;
  let brace = 0;
  let paren = 0;

  for (let i = 0; i < params.length; i += 1) {
    const char = params[i] as string;
    if ((char === '"' || char === "'" || char === '`') && params[i - 1] !== '\\') {
      if (!inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar) {
        inQuote = false;
      }
    }
    if (!inQuote) {
      if (char === '(') paren += 1;
      else if (char === ')') paren -= 1;
      else if (char === '[') bracket += 1;
      else if (char === ']') bracket -= 1;
      else if (char === '{') brace += 1;
      else if (char === '}') brace -= 1;
      if (char === ',' && paren === 0 && bracket === 0 && brace === 0) {
        out.push(current.trim());
        current = '';
        continue;
      }
    }
    current += char;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
}

/* ------------------------------------------------------------------ */
/* JSON Patch（RFC 6902 子集）                                         */
/* ------------------------------------------------------------------ */

interface JsonPatchOp {
  op?: unknown;
  path?: unknown;
  from?: unknown;
  to?: unknown;
  value?: unknown;
}

/** JSON Pointer `/a/b~1c/0` → 命令路径（全 bracket，段里的 `.` 不会被误拆） */
function pointerToPath(pointer: unknown): string {
  if (typeof pointer !== 'string' || pointer === '') return '';
  const body = pointer.startsWith('/') ? pointer.slice(1) : pointer;
  const segments = body.split('/').map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  return segmentsToPath(segments);
}

function isJsonPatch(value: unknown): value is JsonPatchOp[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) => typeof item === 'object' && item !== null && typeof (item as JsonPatchOp).op === 'string',
    )
  );
}

function jsonPatchToCommands(patch: readonly JsonPatchOp[]): MvuCommand[] {
  const out: MvuCommand[] = [];
  for (const op of patch) {
    const path = pointerToPath(op.path ?? op.to);
    const full = JSON.stringify(op);
    const value = JSON.stringify(op.value ?? null);
    switch (op.op) {
      case 'replace':
        out.push({ type: 'set', full_match: full, args: [path, value], reason: 'json_patch' });
        break;
      case 'delta':
        out.push({ type: 'add', full_match: full, args: [path, value], reason: 'json_patch' });
        break;
      case 'add':
      case 'insert': {
        // JSON Patch 的 add 是「往容器里放一个键 / 下标」：拆成容器 + 键 + 值
        const segments = toPath(path);
        const last = segments[segments.length - 1] ?? '';
        const container = segmentsToPath(segments.slice(0, -1));
        const key = /^\d+$/.test(last) ? last : JSON.stringify(last);
        out.push({
          type: 'insert',
          full_match: full,
          args: [container, key, value],
          reason: 'json_patch',
        });
        break;
      }
      case 'remove':
        out.push({ type: 'delete', full_match: full, args: [path], reason: 'json_patch' });
        break;
      case 'move':
        out.push({
          type: 'move',
          full_match: full,
          args: [pointerToPath(op.from), path],
          reason: 'json_patch',
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

function parseJsonPatchBody(body: string): JsonPatchOp[] | null {
  const trimmed = body.trim();
  if (trimmed === '') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isJsonPatch(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function extractCommands(text: string): MvuCommand[] {
  if (!text) return [];
  const indexed: { index: number; command: MvuCommand }[] = [];

  JSON_PATCH_RE.lastIndex = 0;
  let patchMatch: RegExpExecArray | null;
  while ((patchMatch = JSON_PATCH_RE.exec(text)) !== null) {
    const patch = parseJsonPatchBody(patchMatch[2] ?? '');
    if (!patch) continue;
    for (const command of jsonPatchToCommands(patch)) {
      indexed.push({ index: patchMatch.index, command });
    }
  }

  let cursor = 0;
  while (cursor < text.length) {
    const match = COMMAND_RE.exec(text.slice(cursor));
    if (!match || match.index === undefined) break;
    const start = cursor + match.index;
    const openParen = start + match[0].length;
    const closeParen = findMatchingCloseParen(text, openParen);
    if (closeParen === -1) {
      cursor = openParen;
      continue;
    }
    // 闭括号后必须紧跟分号，否则不是命令（正文里提到的 `_.set(...)` 不会被误吃）
    let end = closeParen + 1;
    if (text[end] !== ';') {
      cursor = closeParen + 1;
      continue;
    }
    end += 1;

    let reason = '';
    const comment = /^[ \t]*\/\/(.*)/.exec(text.slice(end));
    if (comment) {
      reason = (comment[1] ?? '').trim();
      end += comment[0].length;
    }

    const type = ALIAS[match[1] as string] as MvuCommandType;
    const args = parseParameters(text.slice(openParen, closeParen));
    if (args.length >= MIN_ARGS[type]) {
      indexed.push({
        index: start,
        command: { type, full_match: text.slice(start, end), args, reason },
      });
    }
    cursor = end;
  }

  return indexed.sort((a, b) => a.index - b.index).map((item) => item.command);
}

/** 命令路径：`pathFix` 之前先去引号（MVU `pathFixPass`；JSON Patch 的路径已经是规范形式） */
export function commandPath(command: MvuCommand): string {
  const raw = command.args[0] ?? '';
  return command.reason === 'json_patch' ? raw : trimQuotes(raw);
}
