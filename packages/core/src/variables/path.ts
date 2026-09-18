/**
 * 变量路径工具：lodash `_.get/_.set/_.has/_.unset` 的最小子集。
 *
 * 为什么自己写：MVU 变量路径全是模型现编的（`角色.络络.好感度`、`武器栏[0]`、
 * `"字段 名".子`），行为必须和 lodash 一致才能对上社区卡；但为此把 lodash 拖进
 * 服务端与浏览器包不值得——真正用到的只有这四个函数。宏（`{{get_message_variable::}}`）
 * 与 MVU 引擎共用这一份。
 *
 * 与 lodash 的差异只有一条：`set` 不支持稀疏数组的洞（中间索引会填 `undefined`，
 * 和 lodash 一样），其余（数字段建数组、非数字段建对象、`[]` 括号段）保持一致。
 */
/** `a.b[0]["c d"]` → `['a','b','0','c d']`（与 `_.toPath` 同语义） */
export function toPath(path: string): string[] {
  if (path === '') return [];
  const segments: string[] = [];
  let current = '';
  let index = 0;

  const push = () => {
    if (current !== '') segments.push(current);
    current = '';
  };

  while (index < path.length) {
    const char = path[index];
    if (char === '.') {
      push();
      index += 1;
      continue;
    }
    if (char === '[') {
      push();
      index += 1;
      const quote = path[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        let literal = '';
        while (index < path.length && path[index] !== quote) {
          // 引号内的 \" 是转义
          if (path[index] === '\\' && index + 1 < path.length) {
            literal += path[index + 1];
            index += 2;
            continue;
          }
          literal += path[index];
          index += 1;
        }
        index += 1; // 收尾引号
        segments.push(literal);
        // 跳过 ]
        if (path[index] === ']') index += 1;
        continue;
      }
      let literal = '';
      while (index < path.length && path[index] !== ']') {
        literal += path[index];
        index += 1;
      }
      index += 1; // ]
      segments.push(literal.trim());
      continue;
    }
    current += char;
    index += 1;
  }
  push();
  return segments;
}

function isIndex(segment: string): boolean {
  return /^\d+$/.test(segment);
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

export function getPath(target: unknown, path: string | readonly string[]): unknown {
  const segments = typeof path === 'string' ? toPath(path) : path;
  let cursor: unknown = target;
  for (const segment of segments) {
    if (!isContainer(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

export function hasPath(target: unknown, path: string | readonly string[]): boolean {
  const segments = typeof path === 'string' ? toPath(path) : path;
  if (segments.length === 0) return true;
  let cursor: unknown = target;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string;
    if (!isContainer(cursor)) return false;
    if (Array.isArray(cursor)) {
      if (!isIndex(segment) || Number(segment) >= cursor.length) return false;
    } else if (!Object.hasOwn(cursor, segment)) {
      return false;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return true;
}

/** 写入并按需建中间容器：下一段是纯数字就建数组，否则建对象（同 lodash） */
export function setPath(target: unknown, path: string | readonly string[], value: unknown): void {
  const segments = typeof path === 'string' ? toPath(path) : path;
  if (segments.length === 0 || !isContainer(target)) return;
  let cursor = target as Record<string, unknown>;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    const next = cursor[segment];
    if (!isContainer(next)) {
      cursor[segment] = isIndex(segments[i + 1] as string) ? [] : {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1] as string] = value;
}

/** 删除一个键；数组元素用 splice（MVU 的 `_.remove` 依赖它不留洞） */
export function unsetPath(target: unknown, path: string | readonly string[]): boolean {
  const segments = typeof path === 'string' ? toPath(path) : path;
  if (segments.length === 0) return false;
  const parent = getPath(target, segments.slice(0, -1));
  if (!isContainer(parent)) return false;
  const last = segments[segments.length - 1] as string;
  if (Array.isArray(parent)) {
    if (!isIndex(last)) return false;
    const index = Number(last);
    if (index >= parent.length) return false;
    parent.splice(index, 1);
    return true;
  }
  if (!Object.hasOwn(parent, last)) return false;
  delete (parent as Record<string, unknown>)[last];
  return true;
}

/** 深拷贝（结构化数据，函数 / Date 之外没别的） */
export function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = clone(item);
  }
  return out as T;
}

/** 路径段数组 → 全 bracket 形式（JSON Patch 转命令时用，段里的 `.` 不会被误当分隔符） */
export function segmentsToPath(segments: readonly string[]): string {
  return segments
    .map((segment) => `["${segment.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`)
    .join('');
}

