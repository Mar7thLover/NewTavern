/**
 * slash 命令（STscript 子集）。见 docs/M5-CONTRACT.md 第二部分 §3.1。
 *
 * - `parser.ts`：词法 + 语法（命令、命名参数、引号、管道、闭包、转义）
 * - `executor.ts`：`runSlash`（管道、宏展开、闭包作用域、`/return` `/abort`）
 * - `commands.ts`：命令表与每条命令的语义
 * - `variables.ts`：变量命令的读写语义（点路径、MVU 二元组）
 * - `types.ts`：`SlashHost`（宿主实现一切副作用）
 */

import { commandTable, slashCommandSpecs } from './commands.js';

export { evalBoolean, stringToRange, type SlashCommandSpec } from './commands.js';
export {
  DEFAULT_MAX_ITERATIONS,
  runSlash,
  SlashAbort,
  type SlashRunOptions,
  type SlashRunResult,
  type SlashValue,
} from './executor.js';
export {
  parseClosureText,
  parseSlash,
  SlashError,
  type SlashArgNode,
  type SlashClosureNode,
  type SlashCommandNode,
  type SlashNamedArg,
  type SlashScript,
  type SlashTextNode,
} from './parser.js';
export type { SlashHost, SlashInject, SlashMessage, SlashVarScope } from './types.js';

/** 已知命令名（含别名）清单，自动补全 / 文档用 */
export const SLASH_COMMAND_NAMES: readonly string[] = [...commandTable().keys()];

/** 正式命令名（不含别名） */
export const SLASH_COMMANDS: readonly { name: string; aliases: readonly string[] }[] =
  slashCommandSpecs().map((spec) => ({ name: spec.name, aliases: spec.aliases }));

/** Composer 用：第一个词是不是已知命令（含别名），不执行 */
export function isKnownSlashCommand(input: string): boolean {
  const match = /^\s*\/([^\s|]+)/.exec(input);
  if (!match) return false;
  return commandTable().has((match[1] ?? '').toLowerCase());
}
