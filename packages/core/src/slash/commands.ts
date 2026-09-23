/**
 * slash 命令表。见 docs/M5-CONTRACT.md 第二部分 §3.1（命令清单）。
 *
 * 每条命令的语义照 ST 源码核对（`public/scripts/slash-commands.js`、`variables.js`、`power-user.js`、
 * `extensions/{expressions,stable-diffusion}/index.js`），与 ST 的差异写在各命令旁边，汇总如下：
 *
 * - `/narrate` 在 ST 里是 TTS 扩展的命令；契约把它定为 `/sys` 的别名（ST 里 `/sys` 的别名是 `/nar`，两个都认）。
 * - `/return` 结束当前闭包（见 executor.ts 文件头）。
 * - `/listvar` `/listinjects` 不弹窗：`/listvar` 返回与 ST 弹窗同样的文本，`return=object` 时返回 JSON；
 *   `/listinjects` 返回 JSON 列表。
 * - `/messages` 不给范围时取全部楼层（ST 返回空串）；`names` 缺省开、`hidden` 缺省关，照 ST 回调的实际行为
 *   （ST 帮助文本写的缺省值与回调不一致，以回调为准）。
 * - `/inject` 的 `position=before|after`（相对主提示词）新酒馆没有对应位置，按 `chat` 注入并提示一句；
 *   缺省位置因此是 `chat`（ST 缺省 `after`）；`ephemeral` 与 `filter` 不支持（给提示，不报错）。
 * - `/gen` `/genraw` 的 `lock` `trim` `as` `length` `stop` `instruct` 等参数忽略。
 * - `/del` 不带数字时 ST 进入「删除模式」界面，这里提示用法后返回空串。
 * - `/emote` 是 ST `/expression-set` 的别名（ST 名字是 `expression-set`，别名 `sprite` `emote`）。
 * - `/hide` `/unhide` 的 `name=` 过滤不支持。
 */

import {
  isClosureValue,
  SlashAbort,
  SlashReturnSignal,
  valueToText,
  type SlashContext,
  type SlashInvocation,
  type SlashValue,
} from './executor.js';
import { parseClosureText, SlashError } from './parser.js';
import type { SlashInject, SlashMessage } from './types.js';
import { addVar, deleteVar, displayValue, readVar, writeVar } from './variables.js';

export interface SlashCommandSpec {
  name: string;
  aliases: readonly string[];
  handler: (ctx: SlashContext, inv: SlashInvocation) => Promise<unknown> | unknown;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function text(value: SlashValue | SlashValue[] | undefined): string {
  return valueToText(value);
}

function named(inv: SlashInvocation, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = inv.named[name];
    if (value !== undefined) return valueToText(value);
  }
  return undefined;
}

function isTrueBoolean(value: string | undefined): boolean {
  return ['on', 'true', '1', 'yes'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
}

function isFalseBoolean(value: string | undefined): boolean {
  return ['off', 'false', '0', 'no'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
}

/** 无名参数里的第一个闭包 */
function closureIn(value: SlashValue | SlashValue[]): SlashValue | undefined {
  if (Array.isArray(value)) return value.find((item) => isClosureValue(item));
  return isClosureValue(value) ? value : undefined;
}

/** 执行「闭包或命令文本」（`/if` `/while` 的主体、`else=`） */
async function runBody(
  ctx: SlashContext,
  body: SlashValue | SlashValue[] | undefined,
  macros?: Map<string, string>,
): Promise<SlashValue> {
  if (body === undefined) return '';
  const closure = Array.isArray(body) ? closureIn(body) : body;
  if (closure !== undefined && isClosureValue(closure)) {
    return ctx.runClosure(closure, macros ? { macros } : {});
  }
  const source = text(body).trim();
  if (source === '') return '';
  return ctx.runText(source, macros ? { macros } : {});
}

/** ST `stringToRange`：`3` / `2-5`，越界或倒序返回 null */
export function stringToRange(
  input: string,
  min: number,
  max: number,
): { start: number; end: number } | null {
  let start: number;
  let end: number;
  if (input.includes('-')) {
    const [a, b] = input.split('-');
    start = a ? Number.parseInt(a, 10) : Number.NaN;
    end = b ? Number.parseInt(b, 10) : Number.NaN;
  } else {
    start = end = Number.parseInt(input, 10);
  }
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < min || end > max)
    return null;
  return { start, end };
}

/* ------------------------------------------------------------------ */
/* /if /while 的比较（ST parseBooleanOperands / evalBoolean）            */
/* ------------------------------------------------------------------ */

async function operand(
  ctx: SlashContext,
  raw: string | undefined,
): Promise<string | number | undefined> {
  if (raw === undefined) return undefined;
  if (raw === '') return '';
  const number = raw.trim().length > 0 ? Number(raw) : Number.NaN;
  if (!Number.isNaN(number)) return number;
  const found = await ctx.lookup(raw);
  if (found !== undefined) {
    if (typeof found === 'number') return found;
    const shown = displayValue(found);
    // ST 的 getLocalVariable 会把数字样的字符串读成数字
    const asNumber = shown.trim() === '' ? Number.NaN : Number(shown);
    return Number.isNaN(asNumber) ? shown : asNumber;
  }
  return raw;
}

export function evalBoolean(
  rule: string | undefined,
  a: string | number | undefined,
  b: string | number | undefined,
): boolean {
  if (a === undefined) throw new Error('缺少左操作数（left=）');
  if (b === undefined) {
    if (rule === undefined || rule === 'not') {
      const onTruthy = rule !== 'not';
      if (isTrueBoolean(String(a))) return onTruthy;
      if (isFalseBoolean(String(a))) return !onTruthy;
      return a ? onTruthy : !onTruthy;
    }
    throw new Error(`没有右操作数时 rule 只能不写或为 not，收到：${rule}`);
  }
  const effective = rule ?? 'eq';
  if (typeof a === 'number' && typeof b === 'number') {
    switch (effective) {
      case 'gt':
        return a > b;
      case 'gte':
        return a >= b;
      case 'lt':
        return a < b;
      case 'lte':
        return a <= b;
      case 'eq':
        return a === b;
      case 'neq':
        return a !== b;
      case 'in':
      case 'nin':
        break;
      default:
        throw new Error(`未知的比较规则：${effective}（数字可用 gt gte lt lte eq neq）`);
    }
  }
  const left = typeof a === 'string' ? a.toLowerCase() : JSON.stringify(a).toLowerCase();
  const right = typeof b === 'string' ? b.toLowerCase() : JSON.stringify(b).toLowerCase();
  switch (effective) {
    case 'in':
      return left.includes(right);
    case 'nin':
      return !left.includes(right);
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    default:
      throw new Error(`未知的比较规则：${effective}（字符串可用 in nin eq neq）`);
  }
}

async function condition(ctx: SlashContext, inv: SlashInvocation): Promise<boolean> {
  const left = await operand(ctx, named(inv, 'a', 'left', 'first', 'x'));
  const right = await operand(ctx, named(inv, 'b', 'right', 'second', 'y'));
  return evalBoolean(named(inv, 'rule'), left, right);
}

/* ------------------------------------------------------------------ */
/* 数学（ST parseNumericSeries / performOperation）                     */
/* ------------------------------------------------------------------ */

async function numericSeries(ctx: SlashContext, value: string): Promise<number[]> {
  let tokens: unknown[];
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      tokens = Array.isArray(parsed) ? parsed : [trimmed];
    } catch {
      tokens = trimmed.split(' ');
    }
  } else {
    tokens = trimmed.split(' ');
  }
  const out: number[] = [];
  for (const token of tokens) {
    const raw = typeof token === 'string' ? token.trim() : token;
    if (raw === '') continue;
    let number = Number(raw);
    if (Number.isNaN(number) && typeof raw === 'string') {
      const found = await ctx.lookup(raw);
      number = Number(found === undefined ? raw : displayValue(found));
    }
    if (!Number.isNaN(number)) out.push(number);
  }
  return out;
}

function mathCommand(name: string, operation: (values: number[]) => number): SlashCommandSpec {
  return {
    name,
    aliases: [],
    handler: async (ctx, inv) => {
      const source = text(inv.value);
      if (source.trim() === '') return '0';
      const values = await numericSeries(ctx, source);
      if (values.length === 0) return '0';
      const result = operation(values);
      return String(Number.isNaN(result) ? 0 : result);
    },
  };
}

/* ------------------------------------------------------------------ */
/* 变量命令                                                            */
/* ------------------------------------------------------------------ */

function variableCommands(scope: 'local' | 'global'): SlashCommandSpec[] {
  const prefix = scope === 'local' ? '' : 'global';
  const alias = (base: string) => (scope === 'local' ? [`${base}chatvar`] : []);
  return [
    {
      name: `set${prefix}var`,
      aliases: alias('set'),
      handler: async (ctx, inv) => {
        const key = named(inv, 'key', 'name') ?? '';
        if (key === '') throw new Error('需要 key= 参数');
        const value = text(inv.value);
        const index = named(inv, 'index');
        const as = named(inv, 'as');
        await writeVar(ctx.host, scope, key, value, {
          ...(index === undefined ? {} : { index }),
          ...(as === undefined ? {} : { as }),
        });
        return value;
      },
    },
    {
      name: `get${prefix}var`,
      aliases: alias('get'),
      handler: async (ctx, inv) => {
        const key = named(inv, 'key', 'name') ?? text(inv.value).trim();
        if (key === '') return '';
        return displayValue(await readVar(ctx.host, scope, key, named(inv, 'index')));
      },
    },
    {
      name: `add${prefix}var`,
      aliases: alias('add'),
      handler: async (ctx, inv) => {
        const key = named(inv, 'key', 'name') ?? '';
        if (key === '') throw new Error('需要 key= 参数');
        return displayValue(await addVar(ctx.host, scope, key, text(inv.value)));
      },
    },
    {
      name: `inc${prefix}var`,
      aliases: alias('inc'),
      handler: async (ctx, inv) => {
        const key = named(inv, 'key', 'name') ?? text(inv.value).trim();
        return displayValue(await addVar(ctx.host, scope, key, '1'));
      },
    },
    {
      name: `dec${prefix}var`,
      aliases: alias('dec'),
      handler: async (ctx, inv) => {
        const key = named(inv, 'key', 'name') ?? text(inv.value).trim();
        return displayValue(await addVar(ctx.host, scope, key, '-1'));
      },
    },
    {
      name: `flush${prefix}var`,
      aliases: alias('flush'),
      handler: async (ctx, inv) => {
        // ST：无名参数可以是闭包，先执行拿结果当名字
        const closure = closureIn(inv.value);
        const key =
          closure !== undefined && isClosureValue(closure)
            ? valueToText(await ctx.runClosure(closure))
            : (named(inv, 'key', 'name') ?? text(inv.value)).trim();
        if (key !== '') await deleteVar(ctx.host, scope, key);
        return '';
      },
    },
  ];
}

async function listVariables(ctx: SlashContext, inv: SlashInvocation): Promise<string> {
  const which = (named(inv, 'scope') ?? 'all').trim().toLowerCase() || 'all';
  const includeLocal = which === 'all' || which === 'local';
  const includeGlobal = which === 'all' || which === 'global';
  const local = includeLocal ? await ctx.host.readVariables('local') : {};
  const global = includeGlobal ? await ctx.host.readVariables('global') : {};
  if (named(inv, 'return') === 'object') {
    return JSON.stringify([
      ...Object.entries(local).map(([key, value]) => ({ key, value, scope: 'local' })),
      ...Object.entries(global).map(([key, value]) => ({ key, value, scope: 'global' })),
    ]);
  }
  const lines = (table: Record<string, unknown>) =>
    Object.entries(table).map(([key, value]) => `${key}: ${displayValue(value)}`);
  const localLines = lines(local);
  const globalLines = lines(global);
  return [
    includeLocal
      ? `### Local variables:\n${localLines.length > 0 ? localLines.join('\n\n') : 'No local variables'}`
      : '',
    includeGlobal
      ? `### Global variables:\n${globalLines.length > 0 ? globalLines.join('\n\n') : 'No global variables'}`
      : '',
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

function severityOf(value: string | undefined): 'info' | 'success' | 'warning' | 'error' {
  if (value === 'success' || value === 'warning' || value === 'error') return value;
  return 'info';
}

async function hideCommand(
  ctx: SlashContext,
  inv: SlashInvocation,
  hidden: boolean,
): Promise<string> {
  const messages = await ctx.host.getMessages();
  const source = text(inv.value).trim();
  const last = messages.length - 1;
  const range = source
    ? stringToRange(source, 0, last)
    : last >= 0
      ? { start: last, end: last }
      : null;
  if (!range) {
    ctx.host.echo(`/${inv.name}：楼层范围无效（${source || '空'}）`, { severity: 'warning' });
    return '';
  }
  await ctx.host.setHidden(range.start, range.end, hidden);
  return '';
}

async function cutRange(
  ctx: SlashContext,
  messages: SlashMessage[],
  start: number,
  end: number,
): Promise<string> {
  const indices: number[] = [];
  let cut = '';
  for (let index = start; index <= end; index += 1) {
    indices.push(index);
    cut += `${messages[index]?.text ?? ''}\n`;
  }
  await ctx.host.deleteMessages(indices);
  return cut;
}

/* ------------------------------------------------------------------ */
/* 注入                                                                */
/* ------------------------------------------------------------------ */

function randomId(random: () => number): string {
  let out = '';
  while (out.length < 10) out += Math.floor(random() * 36).toString(36);
  return out;
}

async function injectCommand(ctx: SlashContext, inv: SlashInvocation): Promise<string> {
  const id = named(inv, 'id')?.trim() || randomId(ctx.random);
  const content = text(inv.value);
  const positionRaw = (named(inv, 'position') ?? 'chat').trim().toLowerCase();
  let position: SlashInject['position'] = 'in_chat';
  if (positionRaw === 'none') position = 'none';
  else if (positionRaw === 'before' || positionRaw === 'after') {
    ctx.host.echo(`/inject：新酒馆没有「${positionRaw}」位置，已按 chat 注入`, {
      severity: 'warning',
    });
  } else if (positionRaw !== 'chat' && positionRaw !== 'in_chat') {
    ctx.host.echo(`/inject：未知位置「${positionRaw}」，已按 chat 注入`, { severity: 'warning' });
  }
  const depthValue = Number(named(inv, 'depth') ?? 4);
  const depth = Number.isNaN(depthValue) ? 4 : depthValue;
  const roleRaw = (named(inv, 'role') ?? 'system').trim().toLowerCase();
  const role: SlashInject['role'] =
    roleRaw === 'user' || roleRaw === '1'
      ? 'user'
      : roleRaw === 'assistant' || roleRaw === '2'
        ? 'assistant'
        : 'system';
  const scan = isTrueBoolean(named(inv, 'scan'));
  if (inv.named.ephemeral !== undefined || inv.named.filter !== undefined) {
    ctx.host.echo('/inject：ephemeral / filter 参数暂不支持，已忽略', { severity: 'warning' });
  }

  if (content === '') {
    // ST：空内容 = 删除这个 id 的注入
    const rest = (await ctx.host.listInjects()).filter((item) => item.id !== id);
    await ctx.host.flushInjects();
    for (const item of rest) await ctx.host.inject(item);
    return id;
  }
  await ctx.host.inject({ id, content, position, depth, role, scan });
  return id;
}

/* ------------------------------------------------------------------ */
/* 命令表                                                              */
/* ------------------------------------------------------------------ */

function buildCommands(): SlashCommandSpec[] {
  return [
    /* ---------- 输出与流程 ---------- */
    {
      name: 'echo',
      aliases: [],
      handler: (ctx, inv) => {
        const value = text(inv.value);
        ctx.host.echo(value, { severity: severityOf(named(inv, 'severity')) });
        return value;
      },
    },
    {
      name: 'pass',
      aliases: [],
      handler: (_ctx, inv) => {
        if (Array.isArray(inv.value)) {
          if (inv.value.some((item) => isClosureValue(item)))
            throw new Error('/pass 不支持多个闭包');
          return JSON.stringify(inv.value);
        }
        return inv.value;
      },
    },
    {
      name: 'return',
      aliases: [],
      handler: (_ctx, inv) => {
        const value: SlashValue = Array.isArray(inv.value) ? text(inv.value) : inv.value;
        throw new SlashReturnSignal(value);
      },
    },
    {
      name: 'abort',
      aliases: [],
      handler: (ctx, inv) => {
        const reason = text(inv.value);
        if (isFalseBoolean(named(inv, 'quiet'))) {
          ctx.host.echo(reason || '/abort', { severity: 'warning' });
        }
        throw new SlashAbort(reason || '/abort');
      },
    },
    {
      name: 'run',
      aliases: ['call', 'exec'],
      handler: async (ctx, inv) => {
        // 除了 args 以外的命名参数作为闭包参数传进去（ST 同样把 /run 的命名参数交给闭包）
        const vars = new Map<string, SlashValue>();
        for (const [key, value] of Object.entries(inv.named)) vars.set(key, value);
        const closure = closureIn(inv.value);
        if (closure !== undefined && isClosureValue(closure))
          return ctx.runClosure(closure, { vars });

        const name = text(inv.value).trim();
        if (name === '') throw new Error('需要要执行的闭包或变量名');
        const found = await ctx.lookup(name);
        if (found === undefined) throw new Error(`「${name}」不存在，无法执行`);
        if (isClosureValue(found)) return ctx.runClosure(found, { vars });
        const source = displayValue(found).trim();
        const node = parseClosureText(source);
        if (node) return ctx.runClosure({ kind: 'closure', node, scope: ctx.scope }, { vars });
        if (!source.startsWith('/')) throw new Error(`「${name}」不是可执行的闭包`);
        return ctx.runText(source);
      },
    },
    {
      name: 'if',
      aliases: [],
      handler: async (ctx, inv) => {
        const result = await condition(ctx, inv);
        if (result) return runBody(ctx, inv.hasValue ? inv.value : undefined);
        const otherwise = inv.named.else;
        if (otherwise !== undefined && (isClosureValue(otherwise) || otherwise !== '')) {
          return runBody(ctx, otherwise);
        }
        return '';
      },
    },
    {
      name: 'times',
      aliases: [],
      handler: async (ctx, inv) => {
        let repeats: string;
        let body: SlashValue | SlashValue[] | undefined;
        if (Array.isArray(inv.value)) {
          const [first, ...rest] = inv.value;
          repeats = typeof first === 'string' ? first.trim() : '';
          body = rest.length === 1 ? rest[0] : rest;
        } else {
          const [first = '', ...rest] = text(inv.value).trim().split(' ');
          repeats = first;
          body = rest.join(' ');
        }
        const count = Number(repeats);
        if (!Number.isFinite(count) || count < 0) throw new Error(`次数无效：${repeats}`);
        if (count > ctx.options.maxIterations) {
          throw new SlashError(`循环超过 ${ctx.options.maxIterations} 次上限（/times ${count}）`);
        }
        let result: SlashValue = '';
        for (let index = 0; index < count; index += 1) {
          if (ctx.options.signal?.aborted) throw new SlashAbort('执行被取消');
          const macros = new Map([['timesIndex', String(index)]]);
          if (body !== undefined && !Array.isArray(body) && isClosureValue(body)) {
            result = await ctx.runClosure(body, { macros });
          } else {
            const source = text(body).replace(/\{\{timesIndex\}\}/g, String(index));
            result = source.trim() === '' ? '' : await ctx.runText(source, { macros });
          }
        }
        return result;
      },
    },
    {
      name: 'while',
      aliases: [],
      handler: async (ctx, inv) => {
        let result: SlashValue = '';
        for (let iteration = 0; ; iteration += 1) {
          if (!(await condition(ctx, inv))) break;
          if (iteration >= ctx.options.maxIterations) {
            throw new SlashError(`循环超过 ${ctx.options.maxIterations} 次上限（/while）`);
          }
          if (ctx.options.signal?.aborted) throw new SlashAbort('执行被取消');
          if (!inv.hasValue) break;
          result = await runBody(ctx, inv.value);
        }
        return result;
      },
    },

    /* ---------- 变量 ---------- */
    ...variableCommands('local'),
    { name: 'listvar', aliases: ['listchatvar'], handler: listVariables },
    ...variableCommands('global'),

    /* ---------- 数学与字符串 ---------- */
    mathCommand('add', (values) => values.reduce((a, b) => a + b, 0)),
    mathCommand('sub', (values) => {
      const [first = 0, ...rest] = values;
      return rest.reduce((a, b) => a - b, first);
    }),
    mathCommand('mul', (values) => values.reduce((a, b) => a * b, 1)),
    mathCommand('div', (values) =>
      (values[1] ?? 0) === 0 ? 0 : (values[0] ?? 0) / (values[1] ?? 1),
    ),
    mathCommand('mod', (values) =>
      (values[1] ?? 0) === 0 ? 0 : (values[0] ?? 0) % (values[1] ?? 1),
    ),
    {
      name: 'rand',
      aliases: [],
      handler: (ctx, inv) => {
        const from = Number(named(inv, 'from') ?? 0);
        const toSource = named(inv, 'to') ?? (text(inv.value).trim() || '1');
        const to = Number(toSource);
        const value = from + ctx.random() * (to - from);
        const round = named(inv, 'round');
        if (round === 'round') return String(Math.round(value));
        if (round === 'ceil') return String(Math.ceil(value));
        if (round === 'floor') return String(Math.floor(value));
        return String(value);
      },
    },
    {
      name: 'len',
      aliases: ['length'],
      handler: (_ctx, inv) => {
        const source = text(inv.value);
        let parsed: unknown = source;
        try {
          parsed = JSON.parse(source);
        } catch {
          /* 不是 JSON 就按字符串算 */
        }
        if (Array.isArray(parsed)) return String(parsed.length);
        if (typeof parsed === 'string') return String(parsed.length);
        if (typeof parsed === 'number') return String(String(parsed).length);
        if (typeof parsed === 'object' && parsed !== null)
          return String(Object.keys(parsed).length);
        return '0';
      },
    },

    /* ---------- 消息 ---------- */
    {
      name: 'send',
      aliases: [],
      handler: async (ctx, inv) => {
        await ctx.host.sendMessage({ role: 'user', text: text(inv.value) });
        return '';
      },
    },
    {
      name: 'sendas',
      aliases: [],
      handler: async (ctx, inv) => {
        const name = named(inv, 'name')?.trim();
        if (!name) throw new Error('需要 name= 参数');
        await ctx.host.sendMessage({ role: 'assistant', text: text(inv.value), name });
        return '';
      },
    },
    {
      name: 'sys',
      aliases: ['nar', 'narrate'],
      handler: async (ctx, inv) => {
        const name = named(inv, 'name')?.trim();
        await ctx.host.sendMessage({
          role: 'system',
          text: text(inv.value),
          ...(name ? { name } : {}),
        });
        return '';
      },
    },
    {
      name: 'comment',
      aliases: [],
      handler: async (ctx, inv) => {
        await ctx.host.sendMessage({ role: 'system', text: text(inv.value), comment: true });
        return '';
      },
    },
    { name: 'hide', aliases: [], handler: (ctx, inv) => hideCommand(ctx, inv, true) },
    { name: 'unhide', aliases: [], handler: (ctx, inv) => hideCommand(ctx, inv, false) },
    {
      name: 'cut',
      aliases: [],
      handler: async (ctx, inv) => {
        const messages = await ctx.host.getMessages();
        const range = stringToRange(text(inv.value).trim(), 0, messages.length - 1);
        if (!range) {
          ctx.host.echo('/cut：需要楼层号或范围（如 3 或 2-5）', { severity: 'warning' });
          return '';
        }
        return cutRange(ctx, messages, range.start, range.end);
      },
    },
    {
      name: 'del',
      aliases: ['delete', 'delmode'],
      handler: async (ctx, inv) => {
        const source = text(inv.value).trim();
        if (source === '' || Number.isNaN(Number(source))) {
          ctx.host.echo('/del：需要一个数字（删掉最后 N 条）', { severity: 'warning' });
          return '';
        }
        const count = Number(source);
        if (count < 1) return '';
        const messages = await ctx.host.getMessages();
        if (count > messages.length) {
          ctx.host.echo(`/del：最多只能删 ${messages.length} 条`, { severity: 'warning' });
          return '';
        }
        return cutRange(ctx, messages, messages.length - count, messages.length - 1);
      },
    },
    {
      name: 'messages',
      aliases: ['message'],
      handler: async (ctx, inv) => {
        const messages = await ctx.host.getMessages();
        const includeNames = !isFalseBoolean(named(inv, 'names'));
        const includeHidden = isTrueBoolean(named(inv, 'hidden'));
        const role = named(inv, 'role')?.trim().toLowerCase();
        if (role && role !== 'system' && role !== 'assistant' && role !== 'user') {
          throw new Error(`role 只能是 system / assistant / user，收到：${role}`);
        }
        const source = text(inv.value).trim();
        const range =
          source === ''
            ? { start: 0, end: messages.length - 1 }
            : stringToRange(source, 0, messages.length - 1);
        if (!range) return '';
        const out: string[] = [];
        for (let index = range.start; index <= range.end; index += 1) {
          const message = messages[index];
          if (!message) continue;
          if (role && message.role !== role) continue;
          if (!includeHidden && message.hidden) continue;
          out.push(includeNames ? `${message.name}: ${message.text}` : message.text);
        }
        return out.join('\n\n');
      },
    },
    {
      name: 'setinput',
      aliases: [],
      handler: (ctx, inv) => {
        ctx.host.setInput(text(inv.value));
        return '';
      },
    },

    /* ---------- 生成 ---------- */
    {
      name: 'gen',
      aliases: [],
      handler: (ctx, inv) => ctx.host.generate(text(inv.value), { raw: false }),
    },
    {
      name: 'genraw',
      aliases: [],
      handler: (ctx, inv) => ctx.host.generate(text(inv.value), { raw: true }),
    },
    {
      name: 'trigger',
      aliases: [],
      handler: async (ctx) => {
        await ctx.host.trigger();
        return '';
      },
    },
    {
      name: 'continue',
      aliases: ['cont'],
      handler: async (ctx) => {
        await ctx.host.continueGeneration();
        return '';
      },
    },
    {
      name: 'regenerate',
      aliases: ['regen'],
      handler: async (ctx) => {
        await ctx.host.regenerate();
        return '';
      },
    },

    /* ---------- 注入 ---------- */
    { name: 'inject', aliases: [], handler: injectCommand },
    {
      name: 'listinjects',
      aliases: [],
      handler: async (ctx) => JSON.stringify(await ctx.host.listInjects()),
    },
    {
      name: 'flushinjects',
      aliases: ['flushinject'],
      handler: async (ctx) => {
        await ctx.host.flushInjects();
        return '';
      },
    },

    /* ---------- 其他模块 ---------- */
    {
      name: 'bg',
      aliases: ['background'],
      handler: async (ctx, inv) => {
        const target = text(inv.value).trim();
        if (target === '') throw new Error('需要背景名或资源 id');
        await ctx.host.setBackground(target);
        return '';
      },
    },
    {
      name: 'emote',
      aliases: ['sprite', 'expression-set'],
      handler: async (ctx, inv) => {
        const label = text(inv.value).trim();
        if (label === '') throw new Error('需要表情标签');
        await ctx.host.emote(label);
        return '';
      },
    },
    {
      name: 'imagine',
      aliases: ['sd', 'img', 'image'],
      handler: async (ctx, inv) => {
        await ctx.host.imagine(text(inv.value).trim());
        return '';
      },
    },
  ];
}

let table: Map<string, SlashCommandSpec> | null = null;
let specs: SlashCommandSpec[] | null = null;

/** 正式命令（不含别名） */
export function slashCommandSpecs(): readonly SlashCommandSpec[] {
  specs ??= buildCommands();
  return specs;
}

/** 名字（含别名，小写）→ 命令 */
export function commandTable(): Map<string, SlashCommandSpec> {
  if (table) return table;
  table = new Map();
  for (const spec of slashCommandSpecs()) {
    table.set(spec.name, spec);
    for (const alias of spec.aliases) table.set(alias, spec);
  }
  return table;
}
