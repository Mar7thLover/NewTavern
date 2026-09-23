import { isKnownSlashCommand, runSlash, SlashError, type SlashHost } from '@newtavern/core';

/**
 * slash 命令入口（M5（三）契约 §3.1）。解析与执行在 core（`packages/core/src/slash`），
 * 宿主动作在 `slash-host.ts`；这里只剩两个调用方共用的小封装：
 *
 * - 前端卡的 `triggerSlash(command)`：返回管道结果，出错抛给卡（`errorCatched` 接得住）；
 * - Composer：输入以 `/` 开头且第一个词是已知命令时执行而不发送。
 *
 * 未知命令一律明确报错（`SlashError('unknown command /xxx')`），不静默。
 */

export { isKnownSlashCommand, SlashError };

/** 执行一段 slash 脚本，返回最后的管道值；`/abort` 返回空串 */
export async function runSlashCommand(input: string, host: SlashHost): Promise<string> {
  const result = await runSlash(input, host, { maxIterations: 100 });
  return result.aborted ? '' : result.pipe;
}

/**
 * Composer 判定：以 `/` 开头的输入里，第一个词是已知命令 → 当 slash 执行；
 * `//` 开头（注释）或 `/` 后面不是字母（比如路径、表情）不算。
 */
export function composerSlashKind(text: string): 'command' | 'unknown' | 'text' {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/') || trimmed.startsWith('//')) return 'text';
  const match = /^\/([A-Za-z][\w-]*)/.exec(trimmed);
  if (!match) return 'text';
  return isKnownSlashCommand(trimmed) ? 'command' : 'unknown';
}
