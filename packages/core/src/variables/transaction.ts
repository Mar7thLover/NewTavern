/**
 * 变量事务（M3）。组装期间宏对 chat / global 变量的读写都走这里，
 * 提交时一次性落库（chat 给完整快照写入节点，global 只给变更键）。
 *
 * 值语义对齐 SillyTavern 1.18 `public/scripts/variables.js`：
 * `getLocalVariable` / `setLocalVariable` / `addLocalVariable` /
 * `incrementLocalVariable` / `decrementLocalVariable` 及 global 变体。
 */

export type VariableScope = 'chat' | 'global';

export interface VariableStore {
  get(scope: VariableScope, key: string): unknown;
  set(scope: VariableScope, key: string, value: unknown): void;
  snapshot(scope: VariableScope): Record<string, unknown>;
}

export interface VariableEvent {
  scope: VariableScope;
  op: 'set' | 'delete';
  key: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface VariableBase {
  chat: Record<string, unknown>;
  global: Record<string, unknown>;
}

export interface VariableCommit {
  /** chat 作用域的完整新快照（直接写节点的 `variables` 列） */
  chat: Record<string, unknown>;
  /** global 只给变更过的键；被删除的键值为 `undefined` */
  globalChanges: Record<string, unknown>;
}

/** 变量事务：读写缓冲 + 事件日志 + commit / rollback */
export class VariableTransaction implements VariableStore {
  readonly events: VariableEvent[] = [];

  #base: VariableBase;
  #current: VariableBase;

  constructor(base?: Partial<VariableBase>) {
    this.#base = {
      chat: { ...(base?.chat ?? {}) },
      global: { ...(base?.global ?? {}) },
    };
    this.#current = {
      chat: { ...this.#base.chat },
      global: { ...this.#base.global },
    };
  }

  get(scope: VariableScope, key: string): unknown {
    return this.#current[scope][key];
  }

  set(scope: VariableScope, key: string, value: unknown): void {
    const bucket = this.#current[scope];
    const oldValue = bucket[key];
    bucket[key] = value;
    this.events.push({ scope, op: 'set', key, oldValue, newValue: value });
  }

  /** 删除变量（ST 的 `/flushvar`；宏本身不会触发） */
  delete(scope: VariableScope, key: string): void {
    const bucket = this.#current[scope];
    if (!Object.hasOwn(bucket, key)) return;
    const oldValue = bucket[key];
    delete bucket[key];
    this.events.push({ scope, op: 'delete', key, oldValue, newValue: undefined });
  }

  snapshot(scope: VariableScope): Record<string, unknown> {
    return { ...this.#current[scope] };
  }

  /** 本次事务是否产生过写入 */
  get dirty(): boolean {
    return this.events.length > 0;
  }

  commit(): VariableCommit {
    const globalChanges: Record<string, unknown> = {};
    const base = this.#base.global;
    const current = this.#current.global;

    for (const key of Object.keys(current)) {
      if (!Object.hasOwn(base, key) || base[key] !== current[key]) {
        globalChanges[key] = current[key];
      }
    }
    for (const key of Object.keys(base)) {
      if (!Object.hasOwn(current, key)) {
        globalChanges[key] = undefined;
      }
    }

    return { chat: { ...this.#current.chat }, globalChanges };
  }

  /** 丢弃全部改动与事件，回到构造时的状态 */
  rollback(): void {
    this.#current = {
      chat: { ...this.#base.chat },
      global: { ...this.#base.global },
    };
    this.events.length = 0;
  }
}

/**
 * 把任意变量值变成宏能输出的字符串（ST `MacrosParser.sanitizeMacroValue`）。
 * 与 ST 的唯一差别：对象走 `JSON.stringify` 而不是 `String()`（契约 §2.3 要求）。
 */
export function stringifyVariable(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'function') return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '';
    } catch {
      return '';
    }
  }
  return String(value);
}

/**
 * ST `getLocalVariable` 的读语义：纯数值字符串读成数字，缺失 / 空串读成空串。
 * 返回值仍是 unknown（ST 也可能返回对象），由 `stringifyVariable` 收口。
 */
export function readVariable(store: VariableStore, scope: VariableScope, key: string): unknown {
  const value = store.get(scope, key);
  const trimmed = typeof value === 'string' ? value.trim() : undefined;
  if (trimmed === '' || isNaN(Number(value))) {
    // ST：`localVariable || ''`
    return value ? value : '';
  }
  return Number(value);
}

/** ST `setLocalVariable`（无 index 参数的那一路）：原样存字符串 */
export function writeVariable(
  store: VariableStore,
  scope: VariableScope,
  key: string,
  value: string,
): string {
  if (!key) return value;
  store.set(scope, key, value);
  return value;
}

/**
 * ST `addLocalVariable`：
 * ① 当前值是 JSON 数组 → push 后存回 JSON 字符串；
 * ② 任一侧不是数字 → 字符串拼接；
 * ③ 否则数值相加（**存成 number**，与 ST 一致）。
 */
export function addVariable(
  store: VariableStore,
  scope: VariableScope,
  key: string,
  value: string | number,
): unknown {
  if (!key) return '';
  const currentValue = readVariable(store, scope, key) || 0;

  try {
    const parsed: unknown = JSON.parse(stringifyVariable(currentValue));
    if (Array.isArray(parsed)) {
      parsed.push(value);
      const json = JSON.stringify(parsed);
      store.set(scope, key, json);
      return json;
    }
  } catch {
    // 非 JSON 值，按下面的数值 / 字符串语义处理
  }

  const increment = Number(value);
  if (isNaN(increment) || isNaN(Number(currentValue))) {
    const stringValue = (currentValue ? String(currentValue) : '') + String(value);
    store.set(scope, key, stringValue);
    return stringValue;
  }

  const newValue = Number(currentValue) + increment;
  if (isNaN(newValue)) return '';
  store.set(scope, key, newValue);
  return newValue;
}

/** ST `incrementLocalVariable`：`addVariable(..., 1)`，**返回新值**（宏会输出它） */
export function incrementVariable(
  store: VariableStore,
  scope: VariableScope,
  key: string,
): unknown {
  return addVariable(store, scope, key, 1);
}

/** ST `decrementLocalVariable`：`addVariable(..., -1)`，**返回新值** */
export function decrementVariable(
  store: VariableStore,
  scope: VariableScope,
  key: string,
): unknown {
  return addVariable(store, scope, key, -1);
}
