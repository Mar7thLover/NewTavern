/**
 * EJS 宿主侧：变量读写与 `getwi` 条目查找（M5（三）契约 §4.1）。
 *
 * 这里全是**同步**的普通函数，沙箱通过字符串协议调用（见 `prelude.ts` / `renderer.ts`）；
 * 模板代码本身从不在宿主执行。
 *
 * 语义照 ST-Prompt-Template `src/function/variables.ts` / `worldinfo.ts`：
 * - `getvar(key, { scope, defaults })`：scope 缺省 = `cache`（全局 ∪ 聊天 ∪ 消息的浅合并视图）；
 *   值原样返回（MVU 的 `[值, 说明]` 二元组也原样返回，要取值自己写 `…好感度[0]`）。
 * - `setvar(key, value, { scope })`：scope 缺省 = `message`。新酒馆的 chat 变量本来就按消息节点存
 *   （M3 契约 §3.5），所以 `message` 与 `local` 都写本次组装的 chat 工作副本。
 * - `getwi(book, title)`：先在主书里找（ST-PT：角色卡绑定的书，其次 persona / 聊天书），
 *   按 comment 全等 / uid 全等 / comment 正则匹配；book 为空且标题不是数字时再模糊搜其余可见的书。
 *   **禁用的条目也找**（ST-PT 直接读书文件；卡作者常把阶段人设设为禁用，专供 getwi 取用）。
 */

import {
  clone,
  getPath,
  hasPath,
  setPath,
  toPath,
  unsetPath,
  type WIBook,
  type WIEntry,
} from '@newtavern/core';

export type EjsScope = 'global' | 'local' | 'message' | 'cache' | 'initial';

export interface EjsVars {
  chat: Record<string, unknown>;
  global: Record<string, unknown>;
}

export interface EjsVarOptions {
  scope?: EjsScope;
  inscope?: EjsScope;
  outscope?: EjsScope;
  defaults?: unknown;
  flags?: 'nx' | 'xx' | 'n' | 'nxs' | 'xxs';
  results?: 'old' | 'new' | 'fullcache';
  merge?: boolean;
  index?: unknown;
  withMsg?: unknown;
  dryRun?: boolean;
  noCache?: boolean;
  clone?: boolean;
  min?: number;
  max?: number;
}

/** ST-PT `optionsConverter`：字符串 / 布尔简写 → 选项对象 */
export function normalizeVarOptions(options: unknown): EjsVarOptions {
  if (typeof options === 'string') {
    switch (options) {
      case 'old':
      case 'new':
      case 'fullcache':
        return { results: options };
      case 'nx':
      case 'xx':
      case 'nxs':
      case 'xxs':
      case 'n':
        return { flags: options };
      case 'cache':
      case 'global':
      case 'local':
      case 'message':
      case 'initial':
        return { scope: options, inscope: options, outscope: options };
      default:
        return {};
    }
  }
  if (typeof options === 'boolean') return { dryRun: options };
  if (typeof options === 'object' && options !== null) return options as EjsVarOptions;
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** lodash `_.mergeWith(clone(old), value, 数组直接替换)` 的最小实现 */
function mergeValues(target: unknown, source: unknown): unknown {
  if (Array.isArray(source)) return clone(source);
  if (!isPlainObject(source)) return source;
  const out: Record<string, unknown> = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = isPlainObject(value) || Array.isArray(value) ? mergeValues(out[key], value) : value;
  }
  return out;
}

/**
 * 一次渲染（含其中的 getwi 递归）的变量视图。写入按顶层键**写时复制**：
 * 调用方传进来的对象（可能直接来自节点快照 / 组装输入）绝不被原地修改。
 */
export class EjsVariableStore {
  readonly #vars: EjsVars;
  /** `scope: 'cache'` 的临时写入：只在本次组装内可见，不落库 */
  readonly #overlay: Record<string, unknown>;
  readonly #owned = new Set<string>();

  constructor(vars: EjsVars, overlay: Record<string, unknown>) {
    this.#vars = vars;
    this.#overlay = overlay;
  }

  /** ST-PT `STATE.cacheVars`：全局 → 聊天(=消息) → 临时写入，浅合并 */
  merged(): Record<string, unknown> {
    return { ...this.#vars.global, ...this.#vars.chat, ...this.#overlay };
  }

  #bucket(scope: EjsScope | undefined): Record<string, unknown> | null {
    switch (scope ?? 'cache') {
      case 'global':
        return this.#vars.global;
      case 'local':
      case 'message':
        return this.#vars.chat;
      case 'cache':
        return this.merged();
      default:
        return null;
    }
  }

  get(key: string | null, options: EjsVarOptions = {}): unknown {
    if (options.index !== undefined && options.index !== null) {
      throw new Error('getvar 的 index 选项未实现');
    }
    const bucket = this.#bucket(options.scope);
    if (bucket === null) return options.defaults;
    if (key === null || key === undefined || key === '') return bucket;
    const value = getPath(bucket, key);
    return value === undefined ? options.defaults : value;
  }

  has(key: string, scope?: EjsScope): boolean {
    const bucket = this.#bucket(scope);
    return bucket !== null && hasPath(bucket, key);
  }

  /** 写时复制：第一次改某个顶层键时先深拷贝它 */
  #own(target: Record<string, unknown>, tag: string, top: string): void {
    const id = `${tag}:${top}`;
    if (this.#owned.has(id)) return;
    this.#owned.add(id);
    const current = target[top];
    if (typeof current === 'object' && current !== null) target[top] = clone(current);
  }

  #write(target: Record<string, unknown>, tag: string, key: string, value: unknown): void {
    const segments = toPath(key);
    const top = segments[0];
    if (top === undefined) return;
    if (segments.length === 1) {
      if (value === undefined) delete target[top];
      else target[top] = value;
      this.#owned.add(`${tag}:${top}`);
      return;
    }
    this.#own(target, tag, top);
    if (value === undefined) unsetPath(target, segments);
    else setPath(target, segments, value);
  }

  set(key: string | null, value: unknown, options: EjsVarOptions = {}): unknown {
    if (options.index !== undefined && options.index !== null) {
      throw new Error('setvar 的 index 选项未实现');
    }
    if (options.withMsg !== undefined) throw new Error('setvar 的 withMsg 选项未实现');
    const scope = options.scope ?? 'message';
    const path = key ?? '';
    const flags = options.flags;
    if (flags === 'nx' && path !== '' && this.has(path)) return undefined;
    if (flags === 'xx' && path !== '' && !this.has(path)) return undefined;
    if (flags === 'nxs' && this.get(path, options) !== undefined) return undefined;
    if (flags === 'xxs' && this.get(path, options) === undefined) return undefined;

    const oldValue = options.results === 'old' || options.merge ? this.get(path) : undefined;
    let newValue = value;
    if (options.merge) {
      newValue =
        (oldValue === undefined || Array.isArray(oldValue)) && Array.isArray(value)
          ? [...((oldValue as unknown[] | undefined) ?? []), ...value]
          : mergeValues(clone(oldValue ?? {}), value);
    }

    if (path === '') {
      // key 为 null：整表合并写入（ST-PT `Object.assign`）
      if (!isPlainObject(newValue)) return undefined;
      for (const [k, v] of Object.entries(newValue)) this.set(k, v, { scope });
      return newValue;
    }

    const top = toPath(path)[0];
    switch (scope) {
      case 'global':
        this.#write(this.#vars.global, 'global', path, newValue);
        break;
      case 'local':
      case 'message':
        this.#write(this.#vars.chat, 'chat', path, newValue);
        break;
      case 'cache':
        break;
      default:
        throw new Error(`setvar 不支持 scope「${String(scope)}」`);
    }
    // ST-PT 同时改 cacheVars：临时写入里已有这个顶层键时同步，否则合并视图自然能看到
    if (scope === 'cache' || (top !== undefined && Object.hasOwn(this.#overlay, top))) {
      this.#write(this.#overlay, 'overlay', path, newValue);
    }

    if (options.results === 'old') return oldValue;
    if (options.results === 'fullcache') return this.merged();
    return newValue;
  }

  /** ST-PT `increaseVariable`：读 inscope（缺省 cache），写 outscope（缺省 message） */
  increase(key: string, delta: number, options: EjsVarOptions = {}): unknown {
    const { flags } = options;
    const readOptions: EjsVarOptions = {
      ...(options.inscope ? { scope: options.inscope } : {}),
    };
    const exists = this.get(key, readOptions) !== undefined;
    const go =
      flags === undefined ||
      flags === 'n' ||
      (flags === 'nx' && !this.has(key)) ||
      (flags === 'xx' && this.has(key)) ||
      (flags === 'nxs' && !exists) ||
      (flags === 'xxs' && exists);
    if (!go) return undefined;
    const base = this.get(key, { ...readOptions, defaults: options.defaults || 0 });
    let value = (base as number) + delta;
    if (options.min !== undefined && options.min !== null) value = Math.max(value, options.min);
    if (options.max !== undefined && options.max !== null) value = Math.min(value, options.max);
    return this.set(key, value, {
      ...(options.outscope ? { scope: options.outscope } : {}),
      ...(options.results ? { results: options.results } : {}),
    });
  }

  /** ST-PT `removeVariable`：无 index = 删除键；有 index = 从数组 / 对象 / 字符串里去掉一项 */
  remove(key: string, index: unknown, options: EjsVarOptions = {}): unknown {
    if (index === undefined || index === null) return this.set(key, undefined, options);
    const current = clone(this.get(key, options));
    if (Array.isArray(current)) {
      const at = current.indexOf(index);
      if (at === -1) return undefined;
      current.splice(at, 1);
      return this.set(key, current, options);
    }
    if (isPlainObject(current)) {
      delete current[String(index)];
      return this.set(key, current, options);
    }
    if (typeof current === 'string' && typeof index === 'string') {
      const at = current.indexOf(index);
      if (at === -1) return undefined;
      return this.set(key, current.slice(0, at) + current.slice(at + index.length), options);
    }
    return undefined;
  }
}

// ───────────────────────── getwi ─────────────────────────

/** 沙箱传来的标题：字符串 / 数字（uid）/ 正则 */
export type EjsWiTitle = string | number | { regex: string; flags: string };

export interface EjsWiHit {
  book: WIBook;
  entry: WIEntry;
}

function titleRegex(title: string | { regex: string; flags: string }): RegExp | null {
  try {
    return typeof title === 'string' ? new RegExp(title) : new RegExp(title.regex, title.flags);
  } catch {
    return null;
  }
}

/**
 * 在一本书里找条目。ST-PT 对每个条目依次判 `comment === title || uid === title || comment.match(title)`，
 * 按它的排序取第一个；这里改为「先全等（comment / uid），再正则」两轮，免得
 * 「昔涟_阶段01」这种标题被排在前面、名字恰好包含它的条目抢走（见 M5 契约第二部分 §5）。
 */
function findInBook(book: WIBook, title: EjsWiTitle, allowUid: boolean): WIEntry | null {
  if (typeof title === 'number') {
    if (allowUid) {
      const byUid = book.entries.find((entry) => entry.uid === title);
      if (byUid) return byUid;
    }
    const text = String(title);
    return book.entries.find((entry) => (entry.comment ?? '').includes(text)) ?? null;
  }
  if (typeof title === 'string') {
    const exact = book.entries.find((entry) => (entry.comment ?? '') === title);
    if (exact) return exact;
  }
  const regex = titleRegex(title);
  if (regex === null) return null;
  return book.entries.find((entry) => regex.test(entry.comment ?? '')) ?? null;
}

/** 主书：角色卡绑定的书 → persona 书 → 聊天书（ST-PT `getWorldInfoEntries()` 的回退次序） */
function primaryBook(books: readonly WIBook[]): WIBook | undefined {
  return (
    books.find((book) => book.scope === 'char') ??
    books.find((book) => book.scope === 'persona') ??
    books.find((book) => book.scope === 'chat')
  );
}

export function findWorldInfoEntry(
  books: readonly WIBook[],
  bookName: string | null | undefined,
  title: EjsWiTitle,
): EjsWiHit | null {
  if (bookName) {
    const book = books.find((item) => item.name === bookName);
    if (!book) return null;
    const entry = findInBook(book, title, true);
    return entry ? { book, entry } : null;
  }
  const primary = primaryBook(books);
  if (primary) {
    const entry = findInBook(primary, title, true);
    if (entry) return { book: primary, entry };
  }
  if (typeof title === 'number') return null;
  for (const book of books) {
    if (book === primary) continue;
    const entry = findInBook(book, title, false);
    if (entry) return { book, entry };
  }
  return null;
}
