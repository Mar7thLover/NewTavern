import { getPath, setPath, unsetPath } from '@newtavern/core';
import type { SandboxVariables } from '@newtavern/sandbox-sdk';

import { replaceChatVariables } from '../../lib/api-cards';
import { mutate } from '../../lib/api';

/**
 * `triggerSlash` 的子集。见 docs/M5-CONTRACT.md §5.4。
 *
 * ST 的 slash 命令有一百多条、还带自己的管道与闭包语法，全实现是另一个里程碑的事。
 * 前端卡真正用到的就那么几条（存取变量、发一条消息、弹个提示），这里只做这些，
 * **不认的命令明确报错**——静默返回空串会让卡作者以为生效了。
 *
 * 支持：`/echo` `/setvar` `/getvar` `/addvar` `/flushvar` `/send` `/sys` `/hide` `/unhide`
 */

export interface SlashContext {
  chatId: string;
  nodeId: string | null;
  variables: SandboxVariables;
  notify: (level: string, message: string, title?: string) => void;
  invalidate: () => void;
  /** 宏替换（宿主给的同步子集） */
  substitute: (text: string) => string;
}

interface ParsedCommand {
  name: string;
  /** `key=value` 形式的命名参数 */
  named: Record<string, string>;
  /** 其余部分（未命名参数） */
  rest: string;
}

/** `/setvar key=好感度 5` → `{ name:'setvar', named:{key:'好感度'}, rest:'5' }` */
export function parseSlashCommand(input: string): ParsedCommand | null {
  const text = input.trim();
  if (!text.startsWith('/')) return null;
  const match = /^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/.exec(text);
  if (!match) return null;
  const name = (match[1] ?? '').toLowerCase();
  let rest = match[2] ?? '';
  const named: Record<string, string> = {};
  const argRe = /(^|\s)([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|\S+)/g;
  rest = rest.replace(argRe, (_full, _space: string, key: string, raw: string, dq?: string, sq?: string) => {
    named[key] = dq ?? sq ?? raw;
    return ' ';
  });
  return { name, named, rest: rest.trim() };
}

/** 变量表的写入目标：`/setvar` 默认写楼层快照（= 新酒馆的聊天变量） */
async function writeVariables(
  context: SlashContext,
  scope: 'message' | 'global',
  table: Record<string, unknown>,
): Promise<void> {
  await replaceChatVariables(context.chatId, {
    scope,
    ...(scope === 'message' ? { nodeId: context.nodeId } : {}),
    variables: table,
  });
  context.invalidate();
}

export async function runSlashCommand(input: string, context: SlashContext): Promise<string> {
  const command = parseSlashCommand(input);
  if (!command) throw new Error(`不是合法的 slash 命令：${input}`);
  const value = context.substitute(command.rest);

  switch (command.name) {
    case 'echo':
      context.notify('info', value);
      return value;

    case 'getvar': {
      const key = command.named.key ?? value;
      const table = context.variables.message;
      const found = getPath(table, key);
      return found === undefined || found === null
        ? ''
        : typeof found === 'string'
          ? found
          : JSON.stringify(found);
    }

    case 'getglobalvar': {
      const key = command.named.key ?? value;
      const found = getPath(context.variables.global, key);
      return found === undefined || found === null
        ? ''
        : typeof found === 'string'
          ? found
          : JSON.stringify(found);
    }

    case 'setvar':
    case 'setglobalvar': {
      const global = command.name === 'setglobalvar';
      const key = command.named.key;
      if (!key) throw new Error('setvar 需要 key= 参数');
      const table = { ...(global ? context.variables.global : context.variables.message) };
      setPath(table, key, value);
      await writeVariables(context, global ? 'global' : 'message', table);
      return value;
    }

    case 'addvar':
    case 'addglobalvar': {
      const global = command.name === 'addglobalvar';
      const key = command.named.key;
      if (!key) throw new Error('addvar 需要 key= 参数');
      const table = { ...(global ? context.variables.global : context.variables.message) };
      const current = Number(getPath(table, key) ?? 0);
      const delta = Number(value);
      if (!Number.isFinite(current) || !Number.isFinite(delta)) {
        throw new Error('addvar 只能加数字');
      }
      const next = current + delta;
      setPath(table, key, next);
      await writeVariables(context, global ? 'global' : 'message', table);
      return String(next);
    }

    case 'flushvar': {
      const key = command.named.key ?? value;
      const table = { ...context.variables.message };
      if (key) unsetPath(table, key);
      await writeVariables(context, 'message', table);
      return '';
    }

    case 'send':
    case 'sys':
    case 'comment': {
      await mutate(`/api/chats/${encodeURIComponent(context.chatId)}/messages`, 'POST', {
        role: command.name === 'send' ? 'user' : 'system',
        text: value,
      });
      context.invalidate();
      return '';
    }

    case 'hide':
    case 'unhide': {
      const target = command.named.at ?? value;
      if (!target) throw new Error(`${command.name} 需要楼层号`);
      throw new Error(`${command.name} 暂不支持按楼层号操作，请用 setChatMessages 改 is_hidden`);
    }

    default:
      throw new Error(`新酒馆还不支持这条 slash 命令：/${command.name}`);
  }
}
