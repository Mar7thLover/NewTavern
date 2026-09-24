import { ST_SAMPLING_KEYS, normalizeCard } from '@newtavern/compat';
import type { ToolDef } from '@newtavern/core';
import { desc, eq, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import {
  EDITABLE_COLUMNS,
  LorebookInputError,
  RAW_FIELDS,
  loadLorebookDetail,
  parseSaveInput,
} from './lorebook-edit.js';

/**
 * AI 协作者的工具（M6 §3.2）：全部在请求草稿的**内存副本**上执行，不落库。
 *
 * 本文件是同步部分（读写字段、世界书条目、预设提示词、检索用户库）与补丁记录；
 * 要组装 / 调模型的 `run_test_turn`、`inspect_prompt` 在 `studio-assist.ts`。
 *
 * 补丁（`StudioPatchOp[]`）在整轮结束时由 `PatchTracker.build` 从「请求里的原始草稿」与
 * 「当前内存副本」对比得出：同一路径多次写只出一条、写回原值的不出；祖先路径被写过时
 * 子路径并进祖先那一条；世界书条目按 uid 归并（新增后又改 = 一条 add_entry，新增后又删 = 无）。
 */

export type StudioAssistKind = 'character' | 'preset' | 'lorebook';
export type StudioLang = 'zh-CN' | 'en';
export type StudioAssistMode = 'edit' | 'generate';

/**
 * 前端据此渲染字段级 diff 与逐条接受（契约 §3.2）。
 * - `set`：`path` 为 JSON Pointer；路径原先不存在时**没有 `before` 键**（JSON 无法表达 undefined），
 *   数组下标等于原长度 = 追加；
 * - `add_entry`：`entry` 为 PUT 形态的可编辑字段 + `uid`（PUT 对无 id 的新条目沿用这个 uid）；
 * - `update_entry`：`patch` 只含真正变了的字段，`before` 为这些字段的原值；
 * - `delete_entry`：`before` 为请求草稿里的整条原条目。
 */
export type StudioPatchOp =
  | { op: 'set'; path: string; value: unknown; before?: unknown }
  | { op: 'add_entry'; entry: Record<string, unknown>; uid: number }
  | {
      op: 'update_entry';
      uid: number;
      patch: Record<string, unknown>;
      before: Record<string, unknown>;
    }
  | { op: 'delete_entry'; uid: number; before: Record<string, unknown> };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clone = <T>(value: T): T => (value === undefined ? value : structuredClone(value));

/** 工具执行错误：以 tool_result isError 回传给模型；两种语言的说明 */
export class ToolError extends Error {
  constructor(
    readonly zh: string,
    readonly en: string = zh,
  ) {
    super(zh);
  }
  text(lang: StudioLang): string {
    return lang === 'zh-CN' ? this.zh : this.en;
  }
}

export const L = (lang: StudioLang, zh: string, en: string) => (lang === 'zh-CN' ? zh : en);

/* ------------------------------------------------------------------ */
/* JSON Pointer                                                        */
/* ------------------------------------------------------------------ */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** `/a/b~1c` → ['a', 'b/c']；空串与单独的 `/` 视为根；没有前导 `/` 时补上（模型常漏） */
export function parsePointer(path: unknown): string[] {
  if (typeof path !== 'string') throw new ToolError('path 必须是字符串', 'path must be a string');
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '/') return [];
  const p = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const tokens = p
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const t of tokens) {
    if (FORBIDDEN_KEYS.has(t))
      throw new ToolError(`非法路径段：${t}`, `Illegal path segment: ${t}`);
  }
  return tokens;
}

export function formatPointer(tokens: readonly string[]): string {
  return tokens.map((t) => `/${t.replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

const INDEX_RE = /^(0|[1-9]\d*)$/;

export function getAt(
  root: unknown,
  tokens: readonly string[],
): { found: boolean; value: unknown } {
  let cur: unknown = root;
  for (const token of tokens) {
    if (Array.isArray(cur)) {
      if (!INDEX_RE.test(token) || Number(token) >= cur.length)
        return { found: false, value: undefined };
      cur = cur[Number(token)];
    } else if (isRecord(cur)) {
      if (!Object.hasOwn(cur, token)) return { found: false, value: undefined };
      cur = cur[token];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

/**
 * 写入；父级必须存在且是对象 / 数组。数组下标可以等于长度（追加），`-` 也表示追加。
 * 返回实际写入的路径段（`-` 换成具体下标）。
 */
export function setAt(root: unknown, tokens: readonly string[], value: unknown): string[] {
  if (tokens.length === 0) {
    throw new ToolError(
      '不能整体替换草稿，请写具体字段',
      'Cannot replace the whole draft; set a specific field',
    );
  }
  const parentTokens = tokens.slice(0, -1);
  const parent = getAt(root, parentTokens);
  const last = tokens[tokens.length - 1] as string;
  if (!parent.found) {
    throw new ToolError(
      `父级路径不存在：${formatPointer(parentTokens)}（先写父级对象）`,
      `Parent path does not exist: ${formatPointer(parentTokens)} (set the parent object first)`,
    );
  }
  const container = parent.value;
  if (Array.isArray(container)) {
    const index = last === '-' ? container.length : INDEX_RE.test(last) ? Number(last) : NaN;
    if (!Number.isInteger(index) || index > container.length) {
      throw new ToolError(
        `数组下标越界：${formatPointer(tokens)}（长度 ${container.length}）`,
        `Array index out of range: ${formatPointer(tokens)} (length ${container.length})`,
      );
    }
    container[index] = value;
    return [...parentTokens, String(index)];
  }
  if (isRecord(container)) {
    container[last] = value;
    return [...tokens];
  }
  throw new ToolError(
    `父级不是对象或数组：${formatPointer(parentTokens)}`,
    `Parent is not an object or array: ${formatPointer(parentTokens)}`,
  );
}

/* ------------------------------------------------------------------ */
/* 补丁                                                                 */
/* ------------------------------------------------------------------ */

/** 条目里 PUT 认的字段（可编辑列 + 只在 raw 里的字段） */
export const ENTRY_FIELDS: readonly string[] = [...EDITABLE_COLUMNS, ...RAW_FIELDS];

function entriesOf(draft: unknown): Json[] {
  return isRecord(draft) && Array.isArray(draft.entries) ? draft.entries.filter(isRecord) : [];
}

function findEntry(draft: unknown, uid: number): Json | undefined {
  return entriesOf(draft).find((entry) => entry.uid === uid);
}

/** 条目的 PUT 形态（可编辑字段）+ uid */
function entryForPatch(entry: Json, uid: number): Json {
  const out: Json = {};
  for (const key of ENTRY_FIELDS) if (key in entry) out[key] = clone(entry[key]);
  out.uid = uid;
  return out;
}

export class PatchTracker {
  /** `p<pointer>` / `e<uid>`，按首次触碰的顺序 */
  private readonly order: string[] = [];
  private readonly seen = new Set<string>();

  private add(key: string): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.order.push(key);
  }

  touchPath(tokens: readonly string[]): void {
    this.add(`p${formatPointer(tokens)}`);
  }

  touchEntry(uid: number): void {
    this.add(`e${uid}`);
  }

  build(original: unknown, working: unknown): StudioPatchOp[] {
    const paths = this.order.filter((k) => k.startsWith('p')).map((k) => k.slice(1));
    const ops: StudioPatchOp[] = [];
    for (const key of this.order) {
      if (key.startsWith('p')) {
        const path = key.slice(1);
        // 祖先路径也被写过：由祖先那一条覆盖
        if (paths.some((other) => other !== path && path.startsWith(`${other}/`))) continue;
        const tokens = parsePointer(path);
        const now = getAt(working, tokens);
        if (!now.found) continue;
        const before = getAt(original, tokens);
        if (before.found && sameJson(before.value, now.value)) continue;
        ops.push({
          op: 'set',
          path,
          value: clone(now.value),
          ...(before.found ? { before: clone(before.value) } : {}),
        });
        continue;
      }
      const uid = Number(key.slice(1));
      const orig = findEntry(original, uid);
      const cur = findEntry(working, uid);
      if (!orig && cur) {
        ops.push({ op: 'add_entry', entry: entryForPatch(cur, uid), uid });
      } else if (orig && !cur) {
        ops.push({ op: 'delete_entry', uid, before: clone(orig) });
      } else if (orig && cur) {
        const patch: Json = {};
        const before: Json = {};
        for (const field of ENTRY_FIELDS) {
          if (!(field in cur) || sameJson(cur[field], orig[field])) continue;
          patch[field] = clone(cur[field]);
          if (field in orig) before[field] = clone(orig[field]);
        }
        if (Object.keys(patch).length > 0) ops.push({ op: 'update_entry', uid, patch, before });
      }
    }
    return ops;
  }
}

/* ------------------------------------------------------------------ */
/* 状态                                                                 */
/* ------------------------------------------------------------------ */

export interface AssistState {
  kind: StudioAssistKind;
  lang: StudioLang;
  mode: StudioAssistMode;
  targetId: string | null;
  /** 请求里的草稿（深拷贝，从不修改） */
  readonly original: Json;
  /** 内存副本：工具在它上面改 */
  working: Json;
  tracker: PatchTracker;
  /** character：库里这张卡已关联内嵌书（`character_book` 只读，改书走世界书编辑器） */
  characterBookId: string | null;
}

export function createAssistState(input: {
  kind: StudioAssistKind;
  lang: StudioLang;
  mode: StudioAssistMode;
  targetId: string | null;
  draft: Json;
  characterBookId?: string | null;
}): AssistState {
  const working = structuredClone(input.draft);
  if (input.kind === 'lorebook' && !Array.isArray(working.entries)) working.entries = [];
  return {
    kind: input.kind,
    lang: input.lang,
    mode: input.mode,
    targetId: input.targetId,
    original: structuredClone(input.draft),
    working,
    tracker: new PatchTracker(),
    characterBookId: input.characterBookId ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* 工具表                                                               */
/* ------------------------------------------------------------------ */

export type ToolName =
  | 'get_field'
  | 'set_field'
  | 'list_entries'
  | 'add_entry'
  | 'update_entry'
  | 'delete_entry'
  | 'set_prompt'
  | 'run_test_turn'
  | 'inspect_prompt'
  | 'search_reference';

const TOOLS_BY_KIND: Record<StudioAssistKind, readonly ToolName[]> = {
  character: [
    'get_field',
    'set_field',
    'list_entries',
    'run_test_turn',
    'inspect_prompt',
    'search_reference',
  ],
  preset: [
    'get_field',
    'set_field',
    'set_prompt',
    'run_test_turn',
    'inspect_prompt',
    'search_reference',
  ],
  lorebook: [
    'get_field',
    'set_field',
    'list_entries',
    'add_entry',
    'update_entry',
    'delete_entry',
    'run_test_turn',
    'inspect_prompt',
    'search_reference',
  ],
};

/** 需要测试会话（target 有 id）的工具 */
export const NEEDS_TARGET_ID: ReadonlySet<ToolName> = new Set(['run_test_turn', 'inspect_prompt']);

export function toolsFor(kind: StudioAssistKind, hasTargetId: boolean): ToolName[] {
  return TOOLS_BY_KIND[kind].filter((name) => hasTargetId || !NEEDS_TARGET_ID.has(name));
}

export function isToolName(name: string): name is ToolName {
  return (Object.values(TOOLS_BY_KIND) as (readonly string[])[]).some((list) =>
    list.includes(name),
  );
}

const ENTRY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    keys: { type: 'array', items: { type: 'string' } },
    secondaryKeys: { type: 'array', items: { type: 'string' } },
    content: { type: 'string' },
    comment: { type: 'string' },
    constant: { type: 'boolean' },
    selective: { type: 'boolean' },
    selectiveLogic: { type: 'integer', minimum: 0, maximum: 3 },
    position: { type: 'integer', minimum: 0, maximum: 7 },
    depth: { type: 'integer', minimum: 0 },
    entryOrder: { type: 'integer', minimum: 0 },
    probability: { type: 'integer', minimum: 0, maximum: 100 },
    role: { type: 'string', enum: ['system', 'user', 'assistant'] },
    disabled: { type: 'boolean' },
    group: { type: 'string' },
    sticky: { type: 'integer', minimum: 0 },
    cooldown: { type: 'integer', minimum: 0 },
    delay: { type: 'integer', minimum: 0 },
    excludeRecursion: { type: 'boolean' },
    preventRecursion: { type: 'boolean' },
  },
};

export function toolDefs(names: readonly ToolName[], lang: StudioLang): ToolDef[] {
  const t = (zh: string, en: string) => L(lang, zh, en);
  const defs: Record<ToolName, ToolDef> = {
    get_field: {
      name: 'get_field',
      description: t(
        '读取草稿里的一个字段。path 为 JSON Pointer，如 /description、/alternate_greetings/0、/prompts/3/content；/ 读整份草稿（很长时会截断）。',
        'Read one field of the draft. path is a JSON Pointer such as /description, /alternate_greetings/0 or /prompts/3/content; / reads the whole draft (truncated when long).',
      ),
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    set_field: {
      name: 'set_field',
      description: t(
        '写草稿里的一个字段（整值替换）。父级必须已存在；数组下标等于长度或写 - 表示追加。预设只能改 prompts / prompt_order / 采样参数 / name；世界书只能改 /name（条目用条目工具）。',
        'Write one field of the draft (replaces the whole value). The parent must exist; an array index equal to the length, or -, appends. Presets: only prompts / prompt_order / sampling parameters / name. Lorebooks: only /name (use the entry tools for entries).',
      ),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          value: { description: t('任意 JSON 值', 'Any JSON value') },
        },
        required: ['path', 'value'],
      },
    },
    list_entries: {
      name: 'list_entries',
      description: t(
        '列出世界书条目摘要（uid、备注、关键词、正文前 80 字）；query 按备注 / 关键词 / 正文过滤。角色卡上列的是内嵌世界书（只读）。',
        'List lorebook entry summaries (uid, comment, keys, first 80 chars of content); query filters by comment / keys / content. On a character card this lists the embedded lorebook (read-only).',
      ),
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
    add_entry: {
      name: 'add_entry',
      description: t(
        '新增一条世界书条目。字段：keys（主关键词数组）、content（正文）、comment（备注/标题）、constant（常驻）、position（0 角色定义前 / 1 角色定义后 / 4 按深度插入 …）、depth、entryOrder（插入顺序）等；未给的字段取 ST 默认值。返回新条目的 uid。',
        'Add a lorebook entry. Fields: keys (primary keywords), content, comment (title), constant (always on), position (0 before char defs / 1 after / 4 at depth …), depth, entryOrder (insertion order), etc.; omitted fields use the ST defaults. Returns the new uid.',
      ),
      parameters: {
        type: 'object',
        properties: { entry: ENTRY_SCHEMA },
        required: ['entry'],
      },
    },
    update_entry: {
      name: 'update_entry',
      description: t(
        '按 uid 修改一条世界书条目，patch 只写要改的字段（字段同 add_entry）。',
        'Modify one lorebook entry by uid; patch contains only the fields to change (same fields as add_entry).',
      ),
      parameters: {
        type: 'object',
        properties: { uid: { type: 'integer' }, patch: ENTRY_SCHEMA },
        required: ['uid', 'patch'],
      },
    },
    delete_entry: {
      name: 'delete_entry',
      description: t('按 uid 删除一条世界书条目。', 'Delete one lorebook entry by uid.'),
      parameters: {
        type: 'object',
        properties: { uid: { type: 'integer' } },
        required: ['uid'],
      },
    },
    set_prompt: {
      name: 'set_prompt',
      description: t(
        '按 identifier 修改预设的提示词条目（只写给出的字段；enabled 写进提示词顺序表）。identifier 不存在时新建一个自定义条目并追加到顺序表末尾。',
        'Modify a preset prompt entry by identifier (only the given fields; enabled goes into the prompt order list). If the identifier does not exist, a custom entry is created and appended to the order list.',
      ),
      parameters: {
        type: 'object',
        properties: {
          identifier: { type: 'string' },
          name: { type: 'string' },
          content: { type: 'string' },
          role: { type: 'string', enum: ['system', 'user', 'assistant'] },
          enabled: { type: 'boolean' },
          injection_position: {
            type: 'integer',
            enum: [0, 1],
            description: t(
              '0 = 相对（按顺序表位置），1 = 按深度插入',
              '0 = relative (order list position), 1 = in-chat at depth',
            ),
          },
          injection_depth: { type: 'integer', minimum: 0 },
          injection_order: { type: 'integer' },
        },
        required: ['identifier'],
      },
    },
    run_test_turn: {
      name: 'run_test_turn',
      description: t(
        '用当前草稿（含本轮未保存的改动）组装提示词，以一条用户消息试跑一轮，返回回复前 1500 字。不写入对话。',
        'Assemble the prompt from the current draft (including unsaved changes in this round), send one user message and return the first 1500 characters of the reply. Nothing is written to the chat.',
      ),
      parameters: {
        type: 'object',
        properties: { user_message: { type: 'string' } },
        required: ['user_message'],
      },
    },
    inspect_prompt: {
      name: 'inspect_prompt',
      description: t(
        '用当前草稿组装提示词，返回各段的来源、角色、token 数与前 120 字。',
        'Assemble the prompt from the current draft and return each segment’s origin, role, token count and first 120 characters.',
      ),
      parameters: { type: 'object', properties: {} },
    },
    search_reference: {
      name: 'search_reference',
      description: t(
        '在用户库里检索参考资料（角色卡名称与描述、世界书条目、预设名），返回最多 10 条摘要。',
        "Search the user's library for reference material (character names and descriptions, lorebook entries, preset names); returns up to 10 summaries.",
      ),
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  };
  return names.map((name) => defs[name]);
}

/* ------------------------------------------------------------------ */
/* 参数小工具                                                           */
/* ------------------------------------------------------------------ */

/** 模型有时把对象参数再包一层 JSON 字符串 */
function maybeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return value;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return value;
  }
}

function requireRecord(value: unknown, name: string): Json {
  const parsed = maybeParseJson(value);
  if (!isRecord(parsed)) throw new ToolError(`${name} 必须是对象`, `${name} must be an object`);
  return parsed;
}

function requireUid(value: unknown): number {
  const n = typeof value === 'string' && INDEX_RE.test(value.trim()) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
    throw new ToolError('uid 必须是非负整数', 'uid must be a non-negative integer');
  }
  return n;
}

const preview = (text: unknown, max: number): string => {
  const s =
    typeof text === 'string'
      ? text
      : text === undefined || text === null
        ? ''
        : JSON.stringify(text);
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

export { preview as previewText };

/* ------------------------------------------------------------------ */
/* get_field / set_field                                               */
/* ------------------------------------------------------------------ */

/** 结果正文上限（回传给模型的 tool_result） */
export const MAX_RESULT_CHARS = 8000;

export function truncateResult(text: string, lang: StudioLang): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n${L(lang, `…（已截断，共 ${text.length} 字符；请读更具体的路径）`, `… (truncated, ${text.length} characters in total; read a more specific path)`)}`;
}

export function getField(state: AssistState, args: Json): { content: string; summary: string } {
  const tokens = parsePointer(args.path);
  const hit = getAt(state.working, tokens);
  const path = formatPointer(tokens) || '/';
  if (!hit.found) {
    throw new ToolError(`路径不存在：${path}`, `Path does not exist: ${path}`);
  }
  const body = typeof hit.value === 'string' ? hit.value : JSON.stringify(hit.value, null, 1);
  const size = typeof hit.value === 'string' ? hit.value.length : body.length;
  return {
    content: truncateResult(JSON.stringify({ path, value: hit.value }), state.lang),
    summary: L(state.lang, `读取 ${path}（${size} 字）`, `Read ${path} (${size} chars)`),
  };
}

const CARD_STRING_FIELDS = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'creator',
  'character_version',
]);
const CARD_STRING_ARRAYS = new Set(['alternate_greetings', 'tags', 'group_only_greetings']);
/** 期望对象 / 数组的字段：模型传 JSON 字符串时解析 */
const STRUCTURED_FIELDS = new Set([
  'character_book',
  'extensions',
  'alternate_greetings',
  'tags',
  'group_only_greetings',
  'creator_notes_multilingual',
  'prompts',
  'prompt_order',
  'entries',
]);

const PRESET_ROOTS = new Set<string>(['prompts', 'prompt_order', 'name', ...ST_SAMPLING_KEYS]);

/** CCv2/v3 必填的六个字符串字段：从空卡生成时还没写到的先按空串算，只校验已写字段的类型 */
const CARD_REQUIRED_DEFAULTS = {
  name: '',
  description: '',
  personality: '',
  scenario: '',
  first_mes: '',
  mes_example: '',
};

function cardIsValid(data: Json): boolean {
  try {
    normalizeCard({
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: { ...CARD_REQUIRED_DEFAULTS, ...data },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * CCv3 内嵌书条目补默认值：模型常漏 `enabled` / `insertion_order` / `extensions`，
 * 关键词给成字符串时按逗号切开。只补缺的，已给的原样保留（类型错的交给卡校验报错）。
 */
function normalizeBookEntry(value: unknown, index: number): unknown {
  if (!isRecord(value)) return value;
  const entry: Json = { ...value };
  for (const key of ['keys', 'secondary_keys'] as const) {
    if (typeof entry[key] === 'string') {
      entry[key] = (entry[key] as string)
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter((s) => s !== '');
    }
  }
  if (entry.keys === undefined) entry.keys = [];
  if (entry.content === undefined) entry.content = '';
  if (entry.enabled === undefined) entry.enabled = true;
  if (entry.insertion_order === undefined) {
    entry.insertion_order = typeof entry.order === 'number' ? entry.order : 100;
  }
  if (entry.id === undefined) entry.id = index;
  if (entry.extensions === undefined) entry.extensions = {};
  return entry;
}

function normalizeCharacterBook(tokens: readonly string[], value: unknown): unknown {
  if (tokens[0] !== 'character_book') return value;
  if (tokens.length === 1 && isRecord(value) && Array.isArray(value.entries)) {
    return { ...value, entries: value.entries.map(normalizeBookEntry) };
  }
  if (tokens.length === 2 && tokens[1] === 'entries' && Array.isArray(value)) {
    return value.map(normalizeBookEntry);
  }
  if (tokens.length === 3 && tokens[1] === 'entries') {
    return normalizeBookEntry(value, INDEX_RE.test(tokens[2] as string) ? Number(tokens[2]) : 0);
  }
  return value;
}

function checkSetField(state: AssistState, tokens: string[], value: unknown): unknown {
  const root = tokens[0] as string;
  const whole = tokens.length === 1;
  // 模型有时把对象 / 数组值包成 JSON 字符串：只在目标本身期望结构化值时解析
  // （如 /character_book、/prompts/3），普通字符串字段保持原样
  const last = tokens[tokens.length - 1] as string;
  const expectsStructured =
    STRUCTURED_FIELDS.has(last) ||
    ((root === 'prompts' || root === 'prompt_order') && tokens.length === 2);
  const v = expectsStructured ? maybeParseJson(value) : value;

  if (state.kind === 'preset') {
    if (!PRESET_ROOTS.has(root)) {
      throw new ToolError(
        `预设只允许改 prompts / prompt_order / 采样参数（${ST_SAMPLING_KEYS.join(', ')}）/ name，不能改 /${root}`,
        `Presets only allow prompts / prompt_order / sampling parameters (${ST_SAMPLING_KEYS.join(', ')}) / name; /${root} is not editable`,
      );
    }
    if (whole && root === 'name' && (typeof v !== 'string' || v.trim() === '')) {
      throw new ToolError('name 必须是非空字符串', 'name must be a non-empty string');
    }
    if (whole && (ST_SAMPLING_KEYS as readonly string[]).includes(root)) {
      const ok =
        root === 'reasoning_effort'
          ? typeof v === 'string'
          : typeof v === 'number' && Number.isFinite(v);
      if (!ok) {
        throw new ToolError(
          `${root} 应为${root === 'reasoning_effort' ? '字符串' : '数字'}`,
          `${root} must be a ${root === 'reasoning_effort' ? 'string' : 'number'}`,
        );
      }
    }
    if (whole && (root === 'prompts' || root === 'prompt_order') && !Array.isArray(v)) {
      throw new ToolError(`${root} 必须是数组`, `${root} must be an array`);
    }
    return v;
  }

  if (state.kind === 'lorebook') {
    if (!(whole && root === 'name')) {
      throw new ToolError(
        '世界书只能用 set_field 改 /name；条目请用 add_entry / update_entry / delete_entry',
        'On a lorebook set_field can only change /name; use add_entry / update_entry / delete_entry for entries',
      );
    }
    if (typeof v !== 'string' || v.trim() === '') {
      throw new ToolError('name 必须是非空字符串', 'name must be a non-empty string');
    }
    return v;
  }

  // character
  if (root === 'character_book' && state.characterBookId) {
    throw new ToolError(
      '这张卡的内嵌世界书在世界书编辑器里编辑，这里只读（可用 list_entries 查看）',
      "This card's embedded lorebook is edited in the lorebook editor and is read-only here (use list_entries to view it)",
    );
  }
  if (whole && CARD_STRING_FIELDS.has(root) && typeof v !== 'string') {
    throw new ToolError(`${root} 必须是字符串`, `${root} must be a string`);
  }
  if (whole && root === 'name' && (v as string).trim() === '') {
    throw new ToolError('name 不能为空', 'name must not be empty');
  }
  if (CARD_STRING_ARRAYS.has(root)) {
    if (whole && !(Array.isArray(v) && v.every((item) => typeof item === 'string'))) {
      throw new ToolError(`${root} 必须是字符串数组`, `${root} must be an array of strings`);
    }
    if (tokens.length === 2 && typeof v !== 'string') {
      throw new ToolError(`${root} 的元素必须是字符串`, `Items of ${root} must be strings`);
    }
  }
  if (whole && (root === 'extensions' || root === 'character_book') && !isRecord(v)) {
    throw new ToolError(`${root} 必须是对象`, `${root} must be an object`);
  }
  if (whole && root === 'character_book' && isRecord(v) && !Array.isArray(v.entries)) {
    throw new ToolError(
      'character_book.entries 必须是数组',
      'character_book.entries must be an array',
    );
  }
  return normalizeCharacterBook(tokens, v);
}

export function setField(state: AssistState, args: Json): { content: string; summary: string } {
  const tokens = parsePointer(args.path);
  if (!('value' in args)) throw new ToolError('缺少 value', 'Missing value');
  if (tokens.length === 0) {
    throw new ToolError(
      '不能整体替换草稿，请写具体字段',
      'Cannot replace the whole draft; set a specific field',
    );
  }
  const value = checkSetField(state, tokens, args.value);
  const next = structuredClone(state.working);
  const written = setAt(next, tokens, structuredClone(value));
  if (state.kind === 'character' && !cardIsValid(next) && cardIsValid(state.working)) {
    throw new ToolError(
      `写入后角色卡结构不合法（${formatPointer(written)} 的类型不对）`,
      `The card would become invalid after this write (wrong type at ${formatPointer(written)})`,
    );
  }
  state.working = next;
  state.tracker.touchPath(written);
  const path = formatPointer(written);
  const size = typeof value === 'string' ? value.length : (JSON.stringify(value)?.length ?? 0);
  return {
    content: JSON.stringify({ ok: true, path }),
    summary: L(state.lang, `已写入 ${path}（${size} 字）`, `Wrote ${path} (${size} chars)`),
  };
}

/* ------------------------------------------------------------------ */
/* 世界书条目                                                           */
/* ------------------------------------------------------------------ */

/** 模型常用 ST 原始字段名：换成 PUT 的列名 */
const ENTRY_ALIASES: Record<string, string> = {
  key: 'keys',
  keysecondary: 'secondaryKeys',
  secondary_keys: 'secondaryKeys',
  order: 'entryOrder',
  insertion_order: 'entryOrder',
  disable: 'disabled',
};

function normalizeEntryFields(input: Json): Json {
  const out: Json = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = ENTRY_ALIASES[rawKey] ?? rawKey;
    let value = rawValue;
    // 关键词给成逗号分隔的字符串
    if ((key === 'keys' || key === 'secondaryKeys') && typeof value === 'string') {
      value = value
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter((s) => s !== '');
    }
    out[key] = value;
  }
  return out;
}

function validateEntryFields(fields: Json): void {
  try {
    parseSaveInput({ entries: [fields] });
  } catch (e) {
    if (e instanceof LorebookInputError) {
      const message = e.message.replace(/^entries\[0\]\.?/, '');
      throw new ToolError(`条目字段不合法：${message}`, `Invalid entry field: ${message}`);
    }
    throw e;
  }
}

function describeEntry(entry: Json) {
  return {
    uid: typeof entry.uid === 'number' ? entry.uid : null,
    comment: typeof entry.comment === 'string' ? entry.comment : (entry.name ?? null),
    keys: Array.isArray(entry.keys) ? entry.keys : [],
    content: preview(entry.content, 80),
    ...(entry.constant === true ? { constant: true } : {}),
    ...(entry.disabled === true || entry.enabled === false ? { disabled: true } : {}),
  };
}

function matches(entry: Json, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const hay = [
    entry.comment,
    entry.name,
    entry.content,
    ...(Array.isArray(entry.keys) ? entry.keys : []),
  ]
    .filter((s): s is string => typeof s === 'string')
    .join('\n')
    .toLowerCase();
  return hay.includes(q);
}

const LIST_LIMIT = 100;

export function listEntries(
  db: Db,
  state: AssistState,
  args: Json,
): { content: string; summary: string } {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  let entries: Json[];
  let readOnly = false;
  if (state.kind === 'lorebook') {
    entries = entriesOf(state.working);
  } else if (state.kind === 'character') {
    readOnly = true;
    const book = state.working.character_book;
    if (isRecord(book) && Array.isArray(book.entries)) {
      // CCv3 内嵌书：没有 uid，用 id 或下标
      entries = book.entries.filter(isRecord).map((entry, index) => ({
        ...entry,
        uid: typeof entry.id === 'number' ? entry.id : index,
      }));
    } else if (state.characterBookId) {
      entries = (loadLorebookDetail(db, state.characterBookId)?.entries ?? []).map(
        (row) => row as unknown as Json,
      );
    } else {
      entries = [];
    }
  } else {
    throw new ToolError('预设没有世界书条目', 'Presets have no lorebook entries');
  }
  const hits = entries.filter((entry) => matches(entry, query));
  const shown = hits.slice(0, LIST_LIMIT).map(describeEntry);
  return {
    content: truncateResult(
      JSON.stringify({
        total: entries.length,
        matched: hits.length,
        ...(readOnly ? { readOnly: true } : {}),
        entries: shown,
      }),
      state.lang,
    ),
    summary: L(
      state.lang,
      `${query ? `「${query}」命中` : '共'} ${hits.length} 条${readOnly ? '（内嵌书，只读）' : ''}`,
      `${hits.length} entr${hits.length === 1 ? 'y' : 'ies'}${query ? ` matching “${query}”` : ''}${readOnly ? ' (embedded, read-only)' : ''}`,
    ),
  };
}

function requireLorebook(state: AssistState): Json[] {
  if (state.kind !== 'lorebook') {
    throw new ToolError(
      state.kind === 'character'
        ? '角色卡的内嵌世界书在这里只读；生成整卡时可 set_field /character_book'
        : '预设没有世界书条目',
      state.kind === 'character'
        ? 'The embedded lorebook is read-only here; when generating a whole card use set_field /character_book'
        : 'Presets have no lorebook entries',
    );
  }
  if (!Array.isArray(state.working.entries)) state.working.entries = [];
  return state.working.entries as Json[];
}

/** 新条目 uid：接在库里、原始草稿、当前副本里的最大 uid 之后（不复用本轮删掉的 uid） */
function nextUid(state: AssistState, dbMaxUid: number): number {
  let max = dbMaxUid;
  for (const entry of [...entriesOf(state.original), ...entriesOf(state.working)]) {
    if (typeof entry.uid === 'number' && entry.uid > max) max = entry.uid;
  }
  return max + 1;
}

/** 库里这本书的最大 uid（含 stKey 里的数字）；没有书 / 没有条目为 -1 */
export function dbMaxUid(db: Db, bookId: string | null): number {
  if (!bookId) return -1;
  const rows = db
    .select({ uid: schema.lorebookEntries.uid, extra: schema.lorebookEntries.extra })
    .from(schema.lorebookEntries)
    .where(eq(schema.lorebookEntries.bookId, bookId))
    .all();
  let max = -1;
  for (const row of rows) {
    const stKey = Number((row.extra as { stKey?: unknown } | null)?.stKey);
    max = Math.max(max, row.uid ?? -1, Number.isInteger(stKey) ? stKey : -1);
  }
  return max;
}

export function addEntry(
  state: AssistState,
  args: Json,
  dbMax: number,
): { content: string; summary: string } {
  const entries = requireLorebook(state);
  const fields = normalizeEntryFields(requireRecord(args.entry, 'entry'));
  delete fields.uid;
  if ('id' in fields) throw new ToolError('新条目不能带 id', 'A new entry must not carry an id');
  if (Object.keys(fields).length === 0) throw new ToolError('entry 为空', 'entry is empty');
  validateEntryFields(fields);
  const uid = nextUid(state, dbMax);
  entries.push({ ...structuredClone(fields), uid });
  state.tracker.touchEntry(uid);
  const title = preview(
    fields.comment ?? (Array.isArray(fields.keys) ? fields.keys.join('、') : ''),
    30,
  );
  return {
    content: JSON.stringify({ ok: true, uid }),
    summary: L(
      state.lang,
      `新增条目 #${uid}${title ? `「${title}」` : ''}`,
      `Added entry #${uid}${title ? ` “${title}”` : ''}`,
    ),
  };
}

export function updateEntry(state: AssistState, args: Json): { content: string; summary: string } {
  const entries = requireLorebook(state);
  const uid = requireUid(args.uid);
  const entry = entries.find((item) => item.uid === uid);
  if (!entry) throw new ToolError(`没有 uid 为 ${uid} 的条目`, `No entry with uid ${uid}`);
  const patch = normalizeEntryFields(requireRecord(args.patch, 'patch'));
  if ('uid' in patch || 'id' in patch) {
    throw new ToolError('patch 不能改 uid / id', 'patch must not change uid / id');
  }
  if (Object.keys(patch).length === 0) throw new ToolError('patch 为空', 'patch is empty');
  validateEntryFields(patch);
  Object.assign(entry, structuredClone(patch));
  state.tracker.touchEntry(uid);
  const fields = Object.keys(patch).join(', ');
  return {
    content: JSON.stringify({ ok: true, uid, fields: Object.keys(patch) }),
    summary: L(state.lang, `修改条目 #${uid}：${fields}`, `Updated entry #${uid}: ${fields}`),
  };
}

export function deleteEntry(state: AssistState, args: Json): { content: string; summary: string } {
  const entries = requireLorebook(state);
  const uid = requireUid(args.uid);
  const index = entries.findIndex((item) => item.uid === uid);
  if (index < 0) throw new ToolError(`没有 uid 为 ${uid} 的条目`, `No entry with uid ${uid}`);
  entries.splice(index, 1);
  state.tracker.touchEntry(uid);
  return {
    content: JSON.stringify({ ok: true, uid }),
    summary: L(state.lang, `删除条目 #${uid}`, `Deleted entry #${uid}`),
  };
}

/* ------------------------------------------------------------------ */
/* set_prompt                                                          */
/* ------------------------------------------------------------------ */

/** 与组装器一致：优先 character_id 100001，其次 100000，否则第一张 */
const PROMPT_ORDER_IDS = ['100001', '100000'];

function pickOrderList(preset: Json): number {
  const lists = Array.isArray(preset.prompt_order) ? preset.prompt_order : [];
  for (const id of PROMPT_ORDER_IDS) {
    const index = lists.findIndex((list) => isRecord(list) && String(list.character_id) === id);
    if (index >= 0) return index;
  }
  return lists.findIndex(isRecord);
}

const PROMPT_FIELDS = [
  'name',
  'content',
  'role',
  'injection_position',
  'injection_depth',
  'injection_order',
] as const;

export function setPrompt(state: AssistState, args: Json): { content: string; summary: string } {
  if (state.kind !== 'preset') {
    throw new ToolError('set_prompt 只适用于预设', 'set_prompt only applies to presets');
  }
  const identifier = typeof args.identifier === 'string' ? args.identifier.trim() : '';
  if (!identifier) throw new ToolError('identifier 不能为空', 'identifier must not be empty');
  if (args.role !== undefined && !['system', 'user', 'assistant'].includes(args.role as string)) {
    throw new ToolError(
      'role 只能是 system / user / assistant',
      'role must be system / user / assistant',
    );
  }
  if (args.content !== undefined && typeof args.content !== 'string') {
    throw new ToolError('content 必须是字符串', 'content must be a string');
  }
  if (args.name !== undefined && typeof args.name !== 'string') {
    throw new ToolError('name 必须是字符串', 'name must be a string');
  }
  if (args.enabled !== undefined && typeof args.enabled !== 'boolean') {
    throw new ToolError('enabled 必须是布尔值', 'enabled must be a boolean');
  }
  if (
    args.injection_position !== undefined &&
    args.injection_position !== 0 &&
    args.injection_position !== 1
  ) {
    throw new ToolError('injection_position 只能是 0 或 1', 'injection_position must be 0 or 1');
  }
  for (const key of ['injection_depth', 'injection_order'] as const) {
    const v = args[key];
    if (
      v !== undefined &&
      !(typeof v === 'number' && Number.isInteger(v) && (key === 'injection_order' || v >= 0))
    ) {
      throw new ToolError(`${key} 必须是整数`, `${key} must be an integer`);
    }
  }

  const next = structuredClone(state.working);
  const touched: string[][] = [];
  if (!Array.isArray(next.prompts)) {
    next.prompts = [];
    touched.push(['prompts']);
  }
  const prompts = next.prompts as unknown[];
  let index = prompts.findIndex((p) => isRecord(p) && p.identifier === identifier);
  const created = index < 0;
  if (created) {
    prompts.push({
      identifier,
      name: typeof args.name === 'string' && args.name.trim() ? args.name : identifier,
      system_prompt: false,
      marker: false,
      role: 'system',
      content: '',
      injection_position: 0,
      injection_depth: 4,
      injection_order: 100,
      forbid_overrides: false,
    });
    index = prompts.length - 1;
  }
  const prompt = prompts[index] as Json;
  if (prompt.marker === true && args.content !== undefined) {
    throw new ToolError(
      `${identifier} 是占位标记（marker），没有正文，不能设置 content`,
      `${identifier} is a marker placeholder without content; content cannot be set`,
    );
  }
  for (const key of PROMPT_FIELDS) {
    if (args[key] !== undefined) prompt[key] = args[key];
  }
  if (touched.length === 0) touched.push(['prompts', String(index)]);

  // enabled 在顺序表里；新条目追加到顺序表末尾（默认启用）
  if (args.enabled !== undefined || created) {
    const listIndex = pickOrderList(next);
    if (listIndex >= 0) {
      const list = (next.prompt_order as Json[])[listIndex] as Json;
      if (!Array.isArray(list.order)) list.order = [];
      const order = list.order as Json[];
      const item = order.find((o) => isRecord(o) && o.identifier === identifier);
      if (item) {
        if (typeof args.enabled === 'boolean') item.enabled = args.enabled;
      } else {
        order.push({
          identifier,
          enabled: typeof args.enabled === 'boolean' ? args.enabled : true,
        });
      }
      touched.push(['prompt_order', String(listIndex), 'order']);
    } else if (args.enabled !== undefined) {
      throw new ToolError(
        '这份预设没有 prompt_order，无法设置 enabled',
        'This preset has no prompt_order; enabled cannot be set',
      );
    }
  }

  state.working = next;
  for (const tokens of touched) state.tracker.touchPath(tokens);
  const changed = [
    ...PROMPT_FIELDS.filter((key) => args[key] !== undefined),
    ...(args.enabled !== undefined ? ['enabled'] : []),
  ];
  return {
    content: JSON.stringify({ ok: true, identifier, created, index }),
    summary: created
      ? L(state.lang, `新建提示词 ${identifier}`, `Created prompt ${identifier}`)
      : L(
          state.lang,
          `修改提示词 ${identifier}：${changed.join(', ') || '无'}`,
          `Updated prompt ${identifier}: ${changed.join(', ') || 'nothing'}`,
        ),
  };
}

/* ------------------------------------------------------------------ */
/* search_reference                                                    */
/* ------------------------------------------------------------------ */

const SEARCH_LIMIT = 10;

function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function searchReference(
  db: Db,
  state: AssistState,
  args: Json,
): { content: string; summary: string } {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new ToolError('query 不能为空', 'query must not be empty');
  const pattern = likePattern(query);
  const results: Json[] = [];

  const characters = db
    .select({
      id: schema.characters.id,
      name: schema.characters.name,
      data: schema.characters.data,
    })
    .from(schema.characters)
    .where(
      sql`${schema.characters.name} LIKE ${pattern} ESCAPE '\\'
        OR json_extract(${schema.characters.data}, '$.description') LIKE ${pattern} ESCAPE '\\'
        OR json_extract(${schema.characters.data}, '$.personality') LIKE ${pattern} ESCAPE '\\'`,
    )
    .orderBy(desc(schema.characters.updatedAt))
    .limit(SEARCH_LIMIT)
    .all();
  for (const row of characters) {
    const data = (row.data ?? {}) as Json;
    results.push({
      type: 'character',
      id: row.id,
      name: row.name,
      description: preview(data.description, 160),
      personality: preview(data.personality, 80),
    });
  }

  const entries = db
    .select({
      book: schema.lorebooks.name,
      uid: schema.lorebookEntries.uid,
      comment: schema.lorebookEntries.comment,
      keys: schema.lorebookEntries.keys,
      content: schema.lorebookEntries.content,
    })
    .from(schema.lorebookEntries)
    .innerJoin(schema.lorebooks, eq(schema.lorebooks.id, schema.lorebookEntries.bookId))
    .where(
      sql`${schema.lorebookEntries.content} LIKE ${pattern} ESCAPE '\\'
        OR ${schema.lorebookEntries.comment} LIKE ${pattern} ESCAPE '\\'
        OR ${schema.lorebookEntries.keys} LIKE ${pattern} ESCAPE '\\'`,
    )
    .limit(SEARCH_LIMIT)
    .all();
  for (const row of entries) {
    results.push({
      type: 'lorebook_entry',
      book: row.book,
      uid: row.uid,
      comment: row.comment,
      keys: row.keys,
      content: preview(row.content, 160),
    });
  }

  const presets = db
    .select({ id: schema.presets.id, name: schema.presets.name })
    .from(schema.presets)
    .where(sql`${schema.presets.name} LIKE ${pattern} ESCAPE '\\'`)
    .limit(SEARCH_LIMIT)
    .all();
  for (const row of presets) results.push({ type: 'preset', id: row.id, name: row.name });

  const shown = results.slice(0, SEARCH_LIMIT);
  return {
    content: truncateResult(
      JSON.stringify({ query, total: results.length, results: shown }),
      state.lang,
    ),
    summary: L(
      state.lang,
      `检索「${query}」：${shown.length} 条`,
      `Search “${query}”: ${shown.length} result(s)`,
    ),
  };
}
