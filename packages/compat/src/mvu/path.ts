/**
 * MVU 专属的路径处理：`pathFix`（把模型写出来的各种路径写法收敛成一种）与去引号。
 * 通用的 `_.get/_.set/_.has/_.unset` 子集在 core（`variables/path.ts`），两边共用一份。
 */

export {
  clone,
  getPath,
  hasPath,
  segmentsToPath,
  setPath,
  toPath,
  unsetPath,
} from '@newtavern/core';

/**
 * MVU `pathFix`：把模型写出来的各种路径写法收敛成一种。
 *
 * - `[0]` 裸数字 → 数组下标；`["0"]` 带引号 → 字符串键；
 * - `["武器栏"]` 简单标识符 → `[武器栏]`（lodash 两种都认，去引号后续处理更简单）；
 * - `foo."a b".c` → `foo["a b"].c`（含空白 / `.` / `[]` 的键必须走 bracket）。
 */
export function pathFix(path: string): string {
  if (!path) return path;

  const fixedBrackets = path.replace(/\[([^\]]*)\]/g, (_match, rawInner: string) => {
    let inner = rawInner.trim();
    if (inner === '') return '[]';
    let wasQuoted = false;
    const first = inner[0];
    const last = inner[inner.length - 1];
    if (inner.length >= 2 && (first === '"' || first === "'") && first === last) {
      wasQuoted = true;
      inner = inner.slice(1, -1);
    }
    if (/^\d+$/.test(inner)) {
      return wasQuoted ? `["${inner.replace(/"/g, '\\"')}"]` : `[${inner}]`;
    }
    return /\s/.test(inner) ? `["${inner.replace(/"/g, '\\"')}"]` : `[${inner}]`;
  });

  return fixedBrackets.replace(
    /(^|\.)(["'])([^"']*)\2(?=\.|\[|$)/g,
    (_match, prefix: string, _quote: string, name: string) => {
      const simple = !/\s/.test(name) && !/[.[\]]/.test(name);
      if (simple) return prefix + name;
      const escaped = name.replace(/"/g, '\\"');
      return prefix === '.' ? `["${escaped}"]` : `${prefix}["${escaped}"]`;
    },
  );
}

/** 去掉首尾引号与转义反斜杠（MVU `trimQuotesAndBackslashes`） */
export function trimQuotes(value: string): string {
  let out = value.trim();
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length >= 2 && (first === '"' || first === "'" || first === '`') && first === last) {
    out = out.slice(1, -1);
  }
  return out.replace(/\\(["'`\\])/g, '$1');
}
