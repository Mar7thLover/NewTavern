/**
 * CCv3 / ST 装饰器：从 content 头部解析 `@@name value` 行，归一化到 WIEntry 字段。
 *
 * 解析算法逐行照搬 ST 1.18 `world-info.js` 的 `parseDecorators`：
 * - 仅当 content 以 `@@` 开头才解析；
 * - `@@@x` 是「回退装饰器」，只有在上一行是**未知**装饰器时才生效（fallbacked）；
 * - 未知装饰器行同样会被从 content 中剥离（ST 的行为：newContent 只在遇到首个非 `@@` 行时确定）；
 * - 若所有行都以 `@@` 开头，content 原样保留（ST 同样如此）。
 *
 * **与 ST 的差异**：ST 1.18 的 `KNOWN_DECORATORS` 只有 `@@activate` / `@@dont_activate`，
 * 其余 CCv3 装饰器在 ST 里是「未知装饰器」（被剥离但不生效）。本引擎按 M3 契约 §1.2 支持完整集合，
 * 因此 `@@@` 回退链的判定范围比 ST 更宽（已知装饰器更多 ⇒ 更少 fallback）。
 */

import { type WIEntry, type WILogic, type WIPosition, type WIRole } from './types.js';

/**
 * 已知装饰器；判定用前缀匹配（与 ST 的 `startsWith` 一致，所以 `@@activate` 也会让
 * `@@activate_only_after` 被视为已知）。真正的名称解析在 normalizeDecorators 里按整词做。
 */
const KNOWN_DECORATORS: readonly string[] = [
  '@@activate_only_after',
  '@@activate_only_every',
  '@@activate',
  '@@additional_keys',
  '@@constant',
  '@@depth',
  '@@disable',
  '@@dont_activate_after_match',
  '@@dont_activate',
  '@@exclude_keys',
  '@@ignore_on_max_context',
  '@@is_greeting',
  '@@keep_activate_after_match',
  '@@position',
  '@@role',
  '@@scan_depth',
];

/** 解析得到但无法映射到 ST 语义的装饰器；scanWorldInfo 会为它们产生一条 warning */
export const UNSUPPORTED_DECORATORS: readonly string[] = [
  'activate_only_every',
  'ignore_on_max_context',
];

/** `@@keep_activate_after_match` / `@@dont_activate_after_match` 的「永久」时间态长度 */
const FOREVER = Number.MAX_SAFE_INTEGER;

/** `@@exclude_keys` 借用的副键逻辑：NOT_ANY */
const NOT_ANY: WILogic = 2;

const POSITION_ALIASES: Record<string, WIPosition> = {
  before_char: 0,
  before_desc: 0,
  before: 0,
  after_char: 1,
  after_desc: 1,
  after: 1,
  an_top: 2,
  antop: 2,
  before_an: 2,
  an_bottom: 3,
  anbottom: 3,
  after_an: 3,
  at_depth: 4,
  depth: 4,
  em_top: 5,
  emtop: 5,
  before_em: 5,
  em_bottom: 6,
  embottom: 6,
  after_em: 6,
  outlet: 7,
};

const ROLE_ALIASES: Record<string, WIRole> = { system: 0, user: 1, assistant: 2 };

function isKnownDecorator(line: string): boolean {
  const data = line.startsWith('@@@') ? line.substring(1) : line;
  return KNOWN_DECORATORS.some((known) => data.startsWith(known));
}

/**
 * 剥离 content 头部的装饰器行。
 * @returns `[装饰器行（已去掉 `@@@` 的首个 `@`）, 剩余 content]`
 */
export function parseDecorators(content: string): [string[], string] {
  if (!content.startsWith('@@')) {
    return [[], content];
  }

  const lines = content.split('\n');
  const decorators: string[] = [];
  let newContent = content;
  let fallbacked = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.startsWith('@@')) {
      newContent = lines.slice(i).join('\n');
      break;
    }
    if (line.startsWith('@@@') && !fallbacked) {
      continue;
    }
    if (isKnownDecorator(line)) {
      decorators.push(line.startsWith('@@@') ? line.substring(1) : line);
      fallbacked = false;
    } else {
      fallbacked = true;
    }
  }

  return [decorators, newContent];
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function toInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** 装饰器行 → `{ 名称: 值 }`；无值的开关型装饰器取 `true` */
function normalizeDecorators(lines: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of lines) {
    const match = /^@@([A-Za-z_]+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = (match[1] ?? '').toLowerCase();
    const raw = (match[2] ?? '').trim();
    switch (name) {
      case 'depth':
      case 'scan_depth':
      case 'activate_only_after':
      case 'activate_only_every':
        out[name] = toInt(raw) ?? raw;
        break;
      // `@@is_greeting` 可不带参数（RisuAI 视作第 0 条）；带参数时是开场白序号
      case 'is_greeting':
        out[name] = raw === '' ? 0 : (toInt(raw) ?? raw);
        break;
      case 'position':
        out[name] = POSITION_ALIASES[raw.toLowerCase()] ?? toInt(raw) ?? raw;
        break;
      case 'role':
        out[name] = ROLE_ALIASES[raw.toLowerCase()] ?? toInt(raw) ?? raw;
        break;
      case 'additional_keys':
      case 'exclude_keys':
        out[name] = splitList(raw);
        break;
      default:
        out[name] = raw.length > 0 ? raw : true;
        break;
    }
  }
  return out;
}

const isPosition = (v: unknown): v is WIPosition =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 7;
const isRole = (v: unknown): v is WIRole =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 2;
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((item) => typeof item === 'string');

/**
 * 解析 content 头部装饰器并覆写字段；已解析过（`decorators` 已存在且 content 不再以 `@@` 开头）时原样返回。
 * `@@activate` / `@@dont_activate` 没有对应字段，保留在 `decorators` 里由 scanWorldInfo 读取。
 */
export function applyDecorators(entry: WIEntry): WIEntry {
  if (!entry.content.startsWith('@@')) {
    return entry.decorators ? entry : { ...entry, decorators: {} };
  }

  const [lines, content] = parseDecorators(entry.content);
  const decorators = { ...entry.decorators, ...normalizeDecorators(lines) };
  const next: WIEntry = { ...entry, content, decorators };

  const depth = decorators['depth'];
  if (typeof depth === 'number') next.depth = depth;
  const position = decorators['position'];
  if (isPosition(position)) next.position = position;
  const role = decorators['role'];
  if (isRole(role)) next.role = role;
  const scanDepth = decorators['scan_depth'];
  if (typeof scanDepth === 'number') next.scanDepth = scanDepth;
  const greeting = decorators['is_greeting'];
  if (typeof greeting === 'number') next.isGreeting = Math.max(0, greeting);
  const after = decorators['activate_only_after'];
  if (typeof after === 'number') next.delay = after;
  if (decorators['keep_activate_after_match'] === true) next.sticky = FOREVER;
  if (decorators['dont_activate_after_match'] === true) next.cooldown = FOREVER;
  if (decorators['constant'] === true) next.constant = true;
  if (decorators['disable'] === true) next.disabled = true;

  const additional = decorators['additional_keys'];
  if (isStringArray(additional) && additional.length > 0) {
    next.keys = [...next.keys, ...additional];
  }
  // 排除键没有独立字段：仅在条目未使用副键时借 NOT_ANY 逻辑表达
  const exclude = decorators['exclude_keys'];
  if (isStringArray(exclude) && exclude.length > 0 && next.secondaryKeys.length === 0) {
    next.secondaryKeys = [...exclude];
    next.selective = true;
    next.selectiveLogic = NOT_ANY;
  }

  return next;
}
