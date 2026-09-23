/**
 * 变量表的 JSON Schema 校验（M5（三）契约 §1：`registerVariableSchema`）。
 *
 * 酒馆助手的 `registerVariableSchema(zodSchema, { type })` 在卡里给的是 zod schema；
 * guest 用 `z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })` 转成 JSON Schema
 * 交给宿主存进会话（`chats.metadata.variableSchemas[type]`）。宿主两处要用：
 *
 * 1. 变量管理器按 schema 就地标错（不阻止保存，保存前列出错误）；
 * 2. MVU 应用 `<UpdateVariable>` 后校验 message 作用域，失败只记 warning、不回滚。
 *
 * 只实现 zod 4 `toJSONSchema` 实际会产出的那部分关键字（draft 2020-12 子集）：
 * `type` `properties` `required` `additionalProperties` `items` `prefixItems` `enum` `const`
 * `minimum` `maximum` `exclusiveMinimum` `exclusiveMaximum` `minLength` `maxLength` `pattern`
 * `minItems` `maxItems` `anyOf` `oneOf` `allOf` `not`（只判存在）`$ref`（`#/$defs/…`）。
 * 不认识的关键字忽略（宁可漏报，不可误报——误报会让用户以为变量坏了）。
 */

export interface SchemaIssue {
  /** 点路径（数组下标写成 `[0]`），根是 `''` */
  path: string;
  message: string;
}

type JsonSchema = Record<string, unknown>;

const MAX_ISSUES = 50;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  const actual = typeOf(value);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base === '' ? key : `${base}.${key}`;
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let cursor: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return isRecord(cursor) ? cursor : undefined;
}

function preview(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  } catch {
    return String(value);
  }
}

/**
 * 校验一个值。返回问题列表（空 = 通过），最多 50 条。
 * 根路径 `''`；`$` 开头的簿记键（`$meta` / `$internal`）不做 additionalProperties 检查。
 */
export function validateJsonSchema(value: unknown, schema: unknown): SchemaIssue[] {
  if (!isRecord(schema)) return [];
  const issues: SchemaIssue[] = [];
  const root = schema;

  const push = (path: string, message: string) => {
    if (issues.length < MAX_ISSUES) issues.push({ path, message });
  };

  const check = (current: unknown, node: unknown, path: string, depth: number): void => {
    if (issues.length >= MAX_ISSUES || depth > 64) return;
    if (node === true || node === undefined) return;
    if (node === false) {
      push(path, '这里不允许有值');
      return;
    }
    if (!isRecord(node)) return;

    if (typeof node.$ref === 'string') {
      const target = resolveRef(root, node.$ref);
      if (target) check(current, target, path, depth + 1);
    }

    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      // MVU 的 `[值, "说明"]` 二元组（VWD）：schema 描述的是值本身，按 `[0]` 校验
      if (
        Array.isArray(current) &&
        current.length === 2 &&
        typeof current[1] === 'string' &&
        !types.includes('array')
      ) {
        check(current[0], node, joinPath(path, 0), depth + 1);
        return;
      }
      const ok = types.some((type) => typeof type === 'string' && matchesType(current, type));
      if (!ok) {
        push(path, `类型应为 ${types.join(' | ')}，实际是 ${typeOf(current)}`);
        return;
      }
    }

    if (Array.isArray(node.enum) && !node.enum.some((item) => deepEqual(item, current))) {
      push(path, `只能是 ${node.enum.map(preview).join(' / ')} 之一`);
    }
    if ('const' in node && !deepEqual(node.const, current)) {
      push(path, `只能是 ${preview(node.const)}`);
    }

    if (typeof current === 'number') {
      if (typeof node.minimum === 'number' && current < node.minimum) {
        push(path, `不能小于 ${node.minimum}`);
      }
      if (typeof node.maximum === 'number' && current > node.maximum) {
        push(path, `不能大于 ${node.maximum}`);
      }
      if (typeof node.exclusiveMinimum === 'number' && current <= node.exclusiveMinimum) {
        push(path, `必须大于 ${node.exclusiveMinimum}`);
      }
      if (typeof node.exclusiveMaximum === 'number' && current >= node.exclusiveMaximum) {
        push(path, `必须小于 ${node.exclusiveMaximum}`);
      }
    }

    if (typeof current === 'string') {
      const length = [...current].length;
      if (typeof node.minLength === 'number' && length < node.minLength) {
        push(path, `长度不能少于 ${node.minLength}`);
      }
      if (typeof node.maxLength === 'number' && length > node.maxLength) {
        push(path, `长度不能超过 ${node.maxLength}`);
      }
      if (typeof node.pattern === 'string') {
        try {
          if (!new RegExp(node.pattern, 'u').test(current)) push(path, `不符合格式 /${node.pattern}/`);
        } catch {
          /* schema 里的正则不合法就不判 */
        }
      }
    }

    if (Array.isArray(current)) {
      if (typeof node.minItems === 'number' && current.length < node.minItems) {
        push(path, `至少要有 ${node.minItems} 项`);
      }
      if (typeof node.maxItems === 'number' && current.length > node.maxItems) {
        push(path, `最多只能有 ${node.maxItems} 项`);
      }
      const prefix = Array.isArray(node.prefixItems) ? node.prefixItems : [];
      current.forEach((item, index) => {
        const itemSchema = index < prefix.length ? prefix[index] : node.items;
        check(item, itemSchema, joinPath(path, index), depth + 1);
      });
    }

    if (isRecord(current)) {
      const properties = isRecord(node.properties) ? node.properties : {};
      if (Array.isArray(node.required)) {
        for (const key of node.required) {
          if (typeof key === 'string' && !(key in current)) push(joinPath(path, key), '缺少必填项');
        }
      }
      for (const [key, child] of Object.entries(current)) {
        if (key in properties) {
          check(child, properties[key], joinPath(path, key), depth + 1);
          continue;
        }
        if (key.startsWith('$')) continue;
        if (node.additionalProperties === false) {
          push(joinPath(path, key), '不在 schema 里（不允许多余的键）');
        } else if (isRecord(node.additionalProperties)) {
          check(child, node.additionalProperties, joinPath(path, key), depth + 1);
        }
      }
    }

    if (Array.isArray(node.allOf)) {
      for (const part of node.allOf) check(current, part, path, depth + 1);
    }
    const branches = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null;
    if (branches) {
      const ok = branches.some((branch) => validateBranch(current, branch, root) === 0);
      if (!ok) push(path, '不符合任何一种允许的形态');
    }
  };

  check(value, schema, '', 0);
  return issues;
}

/** 分支判定：只数问题条数，不把分支内的问题报出来（报出来反而看不懂） */
function validateBranch(value: unknown, branch: unknown, root: JsonSchema): number {
  if (!isRecord(branch)) return branch === false ? 1 : 0;
  // 分支里的 $ref 要在根上解析
  const merged = isRecord(root.$defs) && !('$defs' in branch) ? { ...branch, $defs: root.$defs } : branch;
  return validateJsonSchema(value, merged).length;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => deepEqual(left[key], right[key]));
}
