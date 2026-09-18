/**
 * `[InitVar]` 初始化：从世界书条目里读出变量表的初始形态。
 *
 * 社区约定（MagVarUpdate `loadInitVarData`）：
 *
 * - 条目的**备注**里包含 `[InitVar]`（大小写不论）就是初始化条目，
 *   条目本身通常是禁用的（它不该进提示词），所以这里**不看 disabled**。
 * - 内容可以裹在 `<InitVar>…</InitVar>` 或 ``` 围栏里，先拆掉；
 *   宏（`{{user}}`）先替换，再按 YAML 解析（JSON 是 YAML 的子集，两种写法都能过）。
 * - 同一本书里多个 `[InitVar]` 条目深合并；**已有的变量优先**
 *   （`{ ...初始值, ...当前值 }`），这样中途加字段不会把玩家的进度冲掉。
 * - 吃过的书记在 `initialized_lorebooks`，同一本不会初始化两次。
 *
 * 两种真实写法都支持：
 *
 * ```yaml
 * 时间: 光历3960年·3月·21日
 * 三月七:
 *   好感度: 30
 * ```
 *
 * ```json
 * { "$meta": { "extensible": false, "strictSet": true },
 *   "昔涟": { "好感度": [0, "[0,100]对 user 的好感度"] } }
 * ```
 */

import { parse as parseYaml } from 'yaml';

import { toMvuData, type MvuData } from './engine.js';

/** 世界书条目里 MVU 关心的两个字段 */
export interface InitVarEntry {
  /** ST 的 `comment`（条目备注） */
  comment?: string | null;
  content?: string | null;
}

export interface InitVarBook {
  /** 书的标识：写进 `initialized_lorebooks`，同名视为同一本 */
  name: string;
  entries: readonly InitVarEntry[];
}

export interface InitVarResult {
  data: MvuData;
  /** 这次真的吃进去的书 */
  initialized: string[];
  errors: { book: string; comment: string; message: string }[];
}

const INITVAR_MARK = '[initvar]';

/** 备注里带 `[InitVar]` 即是初始化条目 */
export function isInitVarEntry(entry: InitVarEntry): boolean {
  return (entry.comment ?? '').toLowerCase().includes(INITVAR_MARK);
}

/** 拆掉 `<InitVar>` 包裹与 ``` 围栏，留下真正的 YAML / JSON */
export function unwrapInitVarContent(content: string): string {
  let text = content.trim();
  const xml = /<initvar>[^\n]*\n([\s\S]*)\n[^\n]*<\/initvar>/i.exec(text);
  if (xml?.[1] !== undefined) text = xml[1].trim();
  const fence = /```[^\n]*\n([\s\S]*)\n\s*```/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();
  // 开头的 `---` 是 YAML 文档分隔符，社区卡爱写；留着也能解析，去掉更稳
  return text.replace(/^---\s*\n/, '');
}

/** 深合并：对象逐键合并，数组与标量整体替换（`[值, "说明"]` 不能被逐元素合并掉） */
export function mergeInitVar(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current)
    ) {
      mergeInitVar(current as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }
    target[key] = value;
  }
  return target;
}

/**
 * 把若干本世界书里的 `[InitVar]` 应用到变量表上。
 * `substituteMacros` 由调用方给（服务端传组装器的宏引擎）。
 */
export function initializeMvu(
  input: MvuData | unknown,
  books: readonly InitVarBook[],
  options: { substituteMacros?: (text: string) => string } = {},
): InitVarResult {
  const data = toMvuData(input);
  const initialized: string[] = [];
  const errors: InitVarResult['errors'] = [];

  for (const book of books) {
    if (Object.hasOwn(data.initialized_lorebooks, book.name)) continue;
    const merged: Record<string, unknown> = {};
    const comments: string[] = [];
    let found = false;

    for (const entry of book.entries) {
      if (!isInitVarEntry(entry)) continue;
      found = true;
      const raw = unwrapInitVarContent(entry.content ?? '');
      const text = options.substituteMacros ? options.substituteMacros(raw) : raw;
      if (text.trim() === '') continue;
      try {
        const parsed: unknown = parseYaml(text, { merge: false });
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          errors.push({
            book: book.name,
            comment: entry.comment ?? '',
            message: 'InitVar 的内容必须是一个对象（YAML 映射或 JSON 对象）',
          });
          continue;
        }
        mergeInitVar(merged, parsed as Record<string, unknown>);
        comments.push(entry.comment ?? '');
      } catch (error) {
        errors.push({
          book: book.name,
          comment: entry.comment ?? '',
          message: (error as Error).message,
        });
      }
    }

    if (!found) continue;
    // 已有变量优先：新加的字段补进来，玩过的值不动
    data.stat_data = { ...merged, ...data.stat_data };
    data.initialized_lorebooks[book.name] = comments;
    initialized.push(book.name);
  }

  return { data, initialized, errors };
}

/** 有没有哪本书带 `[InitVar]`（决定这个会话要不要开 MVU） */
export function hasInitVar(books: readonly InitVarBook[]): boolean {
  return books.some((book) => book.entries.some((entry) => isInitVarEntry(entry)));
}
