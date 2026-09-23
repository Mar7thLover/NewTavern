/**
 * slash 脚本执行器。见 docs/M5-CONTRACT.md 第二部分 §3.1。
 *
 * 执行模型照 ST `SlashCommandClosure.executeStep`：
 *
 * - 每条命令先展开命名参数（闭包原样传给命令），再展开无名参数；
 * - 无名参数为空、且不是闭包里的第一条、且前面不是 `||` 时，**上一条的结果**就是它的无名参数；
 * - 宏在执行时展开：`{{pipe}}`、`{{var::名}}`（闭包参数 → 本会话变量 → 全局变量）、
 *   `{{getvar::名}}`、`{{getglobalvar::名}}`、`{{timesIndex}}`；其余宏交给 `host.substitute`（可选）；
 * - 展开之后才把 `\{` `\}` 还原成 `{` `}`；
 * - 命令返回值成为新的管道值：字符串 / 闭包原样，其他值 `JSON.stringify`（ST `#lintPipe`）。
 *
 * 与 ST 的差异：
 * - `/return` 结束**当前闭包**并把值交出去（ST 里 `/return` 是 `/pass` 的别名、结束闭包的是 `/break`；
 *   契约把它定为「结束当前闭包/脚本」）；
 * - 循环超过上限时抛 `SlashError`，而不是 ST 那样静默停在第 100 次（静默截断让人以为跑完了）；
 *   `guard=off` 不解除上限。
 */

import { commandTable, type SlashCommandSpec } from './commands.js';
import {
  parseSlash,
  SlashError,
  type SlashArgNode,
  type SlashClosureNode,
  type SlashCommandNode,
} from './parser.js';
import type { SlashHost } from './types.js';
import { displayValue, readVar } from './variables.js';

/** `/abort` 抛出的；`runSlash` 在顶层接住并返回 `{ aborted: true }` */
export class SlashAbort extends Error {
  constructor(message = '/abort') {
    super(message);
    this.name = 'SlashAbort';
  }
}

/** `/return` 用：沿调用栈退到最近的闭包 */
export class SlashReturnSignal {
  constructor(readonly value: SlashValue) {}
}

/** 运行时的值：字符串，或尚未执行的闭包 */
export type SlashValue = string | SlashClosureValue;

export interface SlashClosureValue {
  kind: 'closure';
  node: SlashClosureNode;
  /** 定义它的作用域（闭包参数 / timesIndex 的查找链） */
  scope: SlashScope;
}

export interface SlashScope {
  parent: SlashScope | null;
  /** 闭包参数与 `/run` 传入的命名参数（`{{var::名}}` 先查这里） */
  vars: Map<string, SlashValue>;
  /** 执行期宏（`{{timesIndex}}`） */
  macros: Map<string, string>;
  pipe: SlashValue;
}

export interface SlashRunOptions {
  /** `/times` `/while` 的迭代上限（每个循环各自计数），缺省 100 */
  maxIterations?: number;
  signal?: AbortSignal;
  /** `/rand` 与 `/inject` 自动 id 的随机源（测试注入） */
  random?: () => number;
}

export interface SlashRunResult {
  pipe: string;
  aborted: boolean;
}

export const DEFAULT_MAX_ITERATIONS = 100;

export function isClosureValue(value: unknown): value is SlashClosureValue {
  return (
    typeof value === 'object' && value !== null && (value as { kind?: unknown }).kind === 'closure'
  );
}

/** 值 → 文本（闭包给源码原文） */
export function valueToText(value: SlashValue | SlashValue[] | undefined | null): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((item) => valueToText(item)).join('');
  return typeof value === 'string' ? value : value.node.raw;
}

/** 命令处理器拿到的上下文 */
export interface SlashContext {
  host: SlashHost;
  scope: SlashScope;
  options: Required<Pick<SlashRunOptions, 'maxIterations'>> & SlashRunOptions;
  random: () => number;
  /** 执行一个闭包（`extraVars` 作为闭包参数，`macros` 作为执行期宏） */
  runClosure: (
    closure: SlashClosureValue,
    extra?: { vars?: Map<string, SlashValue>; macros?: Map<string, string> },
  ) => Promise<SlashValue>;
  /** 执行一段脚本文本（`/if` 等收到的是命令文本而不是闭包时） */
  runText: (text: string, extra?: { macros?: Map<string, string> }) => Promise<SlashValue>;
  /** 展开一段文本里的宏 */
  substitute: (text: string) => Promise<string>;
  /** `{{var::名}}` 的查找：闭包参数链 → 本会话变量 → 全局变量；找不到返回 undefined */
  lookup: (name: string) => Promise<unknown>;
}

export interface SlashInvocation {
  name: string;
  /** 命名参数：闭包原样，文本已展开 */
  named: Record<string, SlashValue>;
  /** 无名参数：单个值，或「文本 + 闭包」片段数组（有闭包时才是数组） */
  value: SlashValue | SlashValue[];
  /** 有没有无名参数（显式给了，或接了管道） */
  hasValue: boolean;
}

function newScope(parent: SlashScope | null, pipe: SlashValue = ''): SlashScope {
  return { parent, vars: new Map(), macros: new Map(), pipe };
}

function findVar(scope: SlashScope | null, name: string): SlashValue | undefined {
  for (let cursor = scope; cursor; cursor = cursor.parent) {
    if (cursor.vars.has(name)) return cursor.vars.get(name);
  }
  return undefined;
}

function findMacro(scope: SlashScope | null, name: string): string | undefined {
  for (let cursor = scope; cursor; cursor = cursor.parent) {
    if (cursor.macros.has(name)) return cursor.macros.get(name);
  }
  return undefined;
}

/** 执行期宏：{{pipe}} / {{var::x}} / {{var::x::index}} / {{getvar::x}} / {{getglobalvar::x}} / {{timesIndex}} */
const RUNTIME_MACRO_RE =
  /{{(pipe|timesIndex)}}|{{var::([^\s}]+?)(?:::((?:(?!}}).)+))?}}|{{(getvar|getglobalvar)::([^}]+)}}/gi;

function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (isClosureValue(value)) return value.node.raw;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function unescapeBraces(text: string): string {
  return text.replace(/\\([{}:])/g, '$1');
}

class Runtime {
  private readonly commands: Map<string, SlashCommandSpec>;
  readonly options: SlashContext['options'];
  readonly random: () => number;

  constructor(
    readonly host: SlashHost,
    options: SlashRunOptions,
  ) {
    this.commands = commandTable();
    this.options = { ...options, maxIterations: options.maxIterations ?? DEFAULT_MAX_ITERATIONS };
    this.random = options.random ?? Math.random;
  }

  async lookup(scope: SlashScope, name: string): Promise<unknown> {
    const scoped = findVar(scope, name);
    if (scoped !== undefined) return scoped;
    const local = await readVar(this.host, 'local', name);
    if (local !== undefined) return local;
    return readVar(this.host, 'global', name);
  }

  async substitute(scope: SlashScope, text: string): Promise<string> {
    if (!text.includes('{{')) return unescapeBraces(text);
    const matches = [...text.matchAll(RUNTIME_MACRO_RE)];
    let out = '';
    let last = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      // 被 `\{` 转义的宏不展开
      if (index > 0 && text[index - 1] === '\\') continue;
      out += text.slice(last, index);
      last = index + match[0].length;
      const [, special, varName, varIndex, getter, getterName] = match;
      if (special !== undefined) {
        out +=
          special.toLowerCase() === 'pipe'
            ? stringify(scope.pipe)
            : (findMacro(scope, 'timesIndex') ?? match[0]);
      } else if (varName !== undefined) {
        let value = await this.lookup(scope, varName);
        if (varIndex !== undefined) {
          let container: unknown = value;
          if (typeof container === 'string') {
            try {
              container = JSON.parse(container);
            } catch {
              container = undefined;
            }
          }
          value =
            typeof container === 'object' && container !== null
              ? (container as Record<string, unknown>)[varIndex]
              : undefined;
        }
        out += displayValue(value);
      } else if (getter !== undefined && getterName !== undefined) {
        const value = await readVar(
          this.host,
          getter.toLowerCase() === 'getvar' ? 'local' : 'global',
          getterName.trim(),
        );
        out += displayValue(value);
      }
    }
    out += text.slice(last);
    const hosted = this.host.substitute ? this.host.substitute(out) : out;
    return unescapeBraces(hosted);
  }

  private async resolveArg(scope: SlashScope, node: SlashArgNode): Promise<SlashValue> {
    if (node.kind === 'closure') return { kind: 'closure', node, scope };
    return this.substitute(scope, node.text);
  }

  private context(scope: SlashScope): SlashContext {
    return {
      host: this.host,
      scope,
      options: this.options,
      random: this.random,
      runClosure: (closure, extra) => this.runClosure(closure, extra),
      runText: (text, extra) => this.runText(scope, text, extra),
      substitute: (text) => this.substitute(scope, text),
      lookup: (name) => this.lookup(scope, name),
    };
  }

  private checkSignal(): void {
    if (this.options.signal?.aborted) throw new SlashAbort('执行被取消');
  }

  async runCommand(
    scope: SlashScope,
    command: SlashCommandNode,
    isFirst: boolean,
  ): Promise<SlashValue> {
    this.checkSignal();
    const spec = this.commands.get(command.name);
    if (!spec) throw new SlashError(`unknown command /${command.name}`);

    const named: Record<string, SlashValue> = {};
    for (const arg of command.named) named[arg.name] = await this.resolveArg(scope, arg.value);

    let value: SlashValue | SlashValue[] = '';
    let hasValue = false;
    if (command.unnamed.length === 0) {
      if (!isFirst && command.injectPipe) {
        value = scope.pipe;
        hasValue = true;
      }
    } else {
      hasValue = true;
      const parts: SlashValue[] = [];
      for (const piece of command.unnamed) parts.push(await this.resolveArg(scope, piece));
      if (parts.length === 1) value = parts[0] ?? '';
      else if (parts.some((part) => isClosureValue(part))) value = parts;
      else value = parts.map((part) => valueToText(part)).join('');
    }

    try {
      const result = await spec.handler(this.context(scope), {
        name: command.name,
        named,
        value,
        hasValue,
      });
      if (result === undefined || result === null) return '';
      if (typeof result === 'string' || isClosureValue(result)) return result;
      return stringify(result);
    } catch (error) {
      if (
        error instanceof SlashAbort ||
        error instanceof SlashReturnSignal ||
        error instanceof SlashError
      ) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new SlashError(`/${command.name}：${message}`);
    }
  }

  /** 按顺序执行一串命令；`/return` 在这里被接住 */
  async runCommands(scope: SlashScope, commands: readonly SlashCommandNode[]): Promise<SlashValue> {
    try {
      let isFirst = true;
      for (const command of commands) {
        scope.pipe = await this.runCommand(scope, command, isFirst);
        isFirst = false;
      }
      return scope.pipe;
    } catch (error) {
      if (error instanceof SlashReturnSignal) {
        scope.pipe = error.value;
        return error.value;
      }
      throw error;
    }
  }

  async runClosure(
    closure: SlashClosureValue,
    extra: { vars?: Map<string, SlashValue>; macros?: Map<string, string> } = {},
  ): Promise<SlashValue> {
    const scope = newScope(closure.scope, closure.scope.pipe);
    // 闭包参数的缺省值在定义处的作用域里展开，调用方给的覆盖它
    for (const arg of closure.node.args)
      scope.vars.set(arg.name, await this.resolveArg(closure.scope, arg.value));
    for (const [key, value] of extra.vars ?? []) scope.vars.set(key, value);
    for (const [key, value] of extra.macros ?? []) scope.macros.set(key, value);
    return this.runCommands(scope, closure.node.commands);
  }

  async runText(
    parent: SlashScope,
    text: string,
    extra: { macros?: Map<string, string> } = {},
  ): Promise<SlashValue> {
    let source = text.trim();
    // ST executeSubCommands：整段被引号包着时去掉引号
    if (source.length >= 2 && source.startsWith('"') && source.endsWith('"'))
      source = source.slice(1, -1);
    const script = parseSlash(source);
    const scope = newScope(parent, parent.pipe);
    for (const [key, value] of extra.macros ?? []) scope.macros.set(key, value);
    return this.runCommands(scope, script.commands);
  }
}

/** 执行一段 slash 脚本 */
export async function runSlash(
  script: string,
  host: SlashHost,
  opts: SlashRunOptions = {},
): Promise<SlashRunResult> {
  const parsed = parseSlash(script);
  const runtime = new Runtime(host, opts);
  const root = newScope(null, '');
  try {
    const pipe = await runtime.runCommands(root, parsed.commands);
    return { pipe: valueToText(pipe), aborted: false };
  } catch (error) {
    if (error instanceof SlashAbort) return { pipe: '', aborted: true };
    throw error;
  }
}
