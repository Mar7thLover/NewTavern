import {
  estimateTokens,
  type Part,
  type PromptIR,
  type SamplingParams,
  type Segment,
  type SegmentOriginKind,
} from '@newtavern/core';
import type { CollectedToolCall } from '@newtavern/providers';
import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import {
  assemblePrompt,
  type AssembleHistoryNode,
  type AssembleInputV2,
  type AssembleResult,
} from './assemble.js';
import { buildAssembleInput } from './assemble-input.js';
import { withTemplateRenderer } from './ejs.js';
import { readDefaultPersonaId } from './personas.js';
import {
  loadChat,
  loadNodes,
  nextSiblingSeq,
  type ChatOverrides,
  type ChatRow,
  type NodeRow,
} from './chat-tree.js';
import type { LayoutMode } from './generation-context.js';
import { callLlm } from './llm.js';
import type { ThinkingOptions } from './provider-request.js';
import type { ResolvedConnection } from './providers.js';
import { studioContextText, studioSystemPrompt } from './studio-assist-prompt.js';
import {
  ENTRY_FIELDS,
  L,
  NEEDS_TARGET_ID,
  ToolError,
  addEntry,
  createAssistState,
  dbMaxUid,
  deleteEntry,
  getField,
  isToolName,
  listEntries,
  previewText,
  searchReference,
  setField,
  setPrompt,
  toolDefs,
  toolsFor,
  truncateResult,
  updateEntry,
  type AssistState,
  type StudioAssistKind,
  type StudioAssistMode,
  type StudioLang,
  type StudioPatchOp,
  type ToolName,
} from './studio-assist-tools.js';
import {
  DraftInputError,
  parseDraft,
  withPresetDraft,
  type AssembleDraft,
} from './studio-draft.js';
import { getOrCreateTestChat, StudioEntityNotFoundError } from './studio-test-chat.js';
import { readWISettings } from './wi-settings.js';

export type { StudioAssistKind, StudioAssistMode, StudioLang, StudioPatchOp };

/**
 * AI 协作者（M6 §3）：`POST /api/studio/assist` 的服务层。SSE 本身在 `routes/studio.ts`。
 *
 * 一轮 = 若干次模型调用（最多 `MAX_ASSIST_STEPS` 次）：模型发起工具调用 → 在草稿的内存副本上执行
 * → 结果以 tool_result 回传 → 再调模型，直到模型不再调用工具。最后一次调用强制 `toolChoice:'none'`
 * 并提示模型总结。整轮结束时按「请求草稿 vs 内存副本」算出补丁发一次（`patch`）。
 * 模型不支持原生工具时 `callLlm` 自动走文本降级（M6 §1.3），这里无需区分。
 */

/** 一轮里最多调几次模型（含最后一次强制总结） */
export const MAX_ASSIST_STEPS = 12;
/** run_test_turn 返回回复的前多少字 */
export const TEST_REPLY_CHARS = 1500;
/** 模型调用遇到限流 / 过载 / 网络错误（且还没有任何输出）时的退避重试间隔；测试可改 */
export const RETRY_DELAYS_MS: number[] = [1500, 4000];
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set(['rateLimit', 'overloaded', 'network']);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface StudioAssistRequest {
  connectionId?: string;
  model?: string;
  target: { kind: StudioAssistKind; id?: string };
  draft: Record<string, unknown>;
  conversation: { role: 'user' | 'assistant'; content: string }[];
  instruction: string;
  mode: StudioAssistMode;
  testChatId?: string;
  lang: StudioLang;
  /** 可选：本轮的推理设置（同聊天覆盖项 `thinking`） */
  thinking?: ThinkingOptions;
  /**
   * 可选：协作请求套用的预设（破限 / 文风等）。给了就用对话组装器按该预设组装提示词，
   * 工作台自己的系统提示词与草稿概览插在预设 main 之前；缺省 / null = 不经过预设（原行为）。
   */
  presetId?: string;
}

/** SSE 事件（`event:` 名 → `data` 形状） */
export interface StudioAssistEvents {
  text: { delta: string };
  reasoning: { delta: string };
  /** 调用发起；args 为解析后的参数（解析失败时为原始字符串） */
  tool: { id: string; name: string; args: unknown; summary: string };
  /** 调用结果；content 为回传给模型的结果正文（前端展开时显示） */
  tool_result: { id: string; ok: boolean; summary: string; content: string };
  patch: { ops: StudioPatchOp[] };
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
  done: { steps: number; stopReason: 'end' | 'max_steps' };
  error: { message: string; kind?: string };
}

export type StudioAssistEmit = <K extends keyof StudioAssistEvents>(
  event: K,
  data: StudioAssistEvents[K],
) => Promise<void> | void;

/* ------------------------------------------------------------------ */
/* 请求校验                                                             */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const KINDS: readonly StudioAssistKind[] = ['character', 'preset', 'lorebook'];

/** 校验并规整请求体；不合法时返回错误信息。connectionId / model 缺省由路由按全局默认补 */
export function parseAssistRequest(body: unknown): StudioAssistRequest | string {
  if (!isRecord(body)) return '请求体必须是对象';
  for (const key of ['connectionId', 'model', 'testChatId', 'presetId'] as const) {
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') {
      return `${key} 必须是字符串`;
    }
  }
  const target = body.target;
  if (!isRecord(target) || !KINDS.includes(target.kind as StudioAssistKind)) {
    return 'target.kind 必须是 character / preset / lorebook';
  }
  if (
    target.id !== undefined &&
    target.id !== null &&
    (typeof target.id !== 'string' || target.id === '')
  ) {
    return 'target.id 必须是非空字符串';
  }
  const draft = body.draft ?? {};
  if (!isRecord(draft)) return 'draft 必须是对象';
  const conversation = body.conversation ?? [];
  if (!Array.isArray(conversation)) return 'conversation 必须是数组';
  for (const [index, turn] of conversation.entries()) {
    if (
      !isRecord(turn) ||
      (turn.role !== 'user' && turn.role !== 'assistant') ||
      typeof turn.content !== 'string'
    ) {
      return `conversation[${index}] 必须是 { role: 'user' | 'assistant', content: string }`;
    }
  }
  if (typeof body.instruction !== 'string' || body.instruction.trim() === '') {
    return 'instruction 不能为空';
  }
  const mode = body.mode ?? 'edit';
  if (mode !== 'edit' && mode !== 'generate') return "mode 必须是 'edit' 或 'generate'";
  const lang = body.lang ?? 'zh-CN';
  if (lang !== 'zh-CN' && lang !== 'en') return "lang 必须是 'zh-CN' 或 'en'";
  let thinking: ThinkingOptions | undefined;
  if (body.thinking !== undefined && body.thinking !== null) {
    if (!isRecord(body.thinking)) return 'thinking 必须是对象';
    const t = body.thinking;
    thinking = {
      ...(typeof t.enabled === 'boolean' ? { enabled: t.enabled } : {}),
      ...(typeof t.effort === 'string' ? { effort: t.effort } : {}),
      ...(typeof t.budgetTokens === 'number' ? { budgetTokens: t.budgetTokens } : {}),
    };
  }
  return {
    ...(typeof body.connectionId === 'string' && body.connectionId
      ? { connectionId: body.connectionId }
      : {}),
    ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
    target: {
      kind: target.kind as StudioAssistKind,
      ...(typeof target.id === 'string' ? { id: target.id } : {}),
    },
    draft,
    conversation: (conversation as Json[]).map((turn) => ({
      role: turn.role as 'user' | 'assistant',
      content: turn.content as string,
    })),
    instruction: body.instruction,
    mode,
    ...(typeof body.testChatId === 'string' && body.testChatId
      ? { testChatId: body.testChatId }
      : {}),
    lang,
    ...(thinking ? { thinking } : {}),
    // 空串与 null 一样当「无预设」
    ...(typeof body.presetId === 'string' && body.presetId ? { presetId: body.presetId } : {}),
  };
}

export class AssistTargetNotFoundError extends Error {}

/**
 * `presetId` 指向不存在的预设。路由按 400 invalid 返回（附说明），**不**静默当「无预设」：
 * 用户选了破限预设却悄悄空提示词出字，比直接报错更难排查；前端在预设被删后会自行回退。
 */
export class AssistPresetNotFoundError extends Error {
  constructor(readonly presetId: string) {
    super(`预设不存在：${presetId}`);
  }
}

type PresetRow = typeof schema.presets.$inferSelect;

export interface PreparedAssist {
  state: AssistState;
  /** lorebook：库里这本书的最大 uid（新条目 uid 接在后面）；其余为 -1 */
  dbMaxUid: number;
  /** 请求带了 presetId 时的预设行（已保存版；草稿替换在组装时做） */
  preset?: PresetRow;
}

/**
 * 检查 target 存在并建内存副本；target.id 指向不存在的实体时抛 AssistTargetNotFoundError，
 * presetId 指向不存在的预设时抛 AssistPresetNotFoundError
 */
export function prepareAssist(db: Db, req: StudioAssistRequest): PreparedAssist {
  const { kind, id } = req.target;
  let preset: PresetRow | undefined;
  if (req.presetId !== undefined) {
    preset = db.select().from(schema.presets).where(eq(schema.presets.id, req.presetId)).get();
    if (!preset) throw new AssistPresetNotFoundError(req.presetId);
  }
  let characterBookId: string | null = null;
  if (id !== undefined) {
    const table =
      kind === 'character'
        ? schema.characters
        : kind === 'preset'
          ? schema.presets
          : schema.lorebooks;
    const exists = db.select({ id: table.id }).from(table).where(eq(table.id, id)).get();
    if (!exists) throw new AssistTargetNotFoundError();
    if (kind === 'character') {
      characterBookId =
        db
          .select({ bookId: schema.characters.bookId })
          .from(schema.characters)
          .where(eq(schema.characters.id, id))
          .get()?.bookId ?? null;
    }
  }
  return {
    state: createAssistState({
      kind,
      lang: req.lang,
      mode: req.mode,
      targetId: id ?? null,
      draft: req.draft,
      characterBookId,
    }),
    dbMaxUid: kind === 'lorebook' && id !== undefined ? dbMaxUid(db, id) : -1,
    ...(preset ? { preset } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* 草稿组装（run_test_turn / inspect_prompt）                            */
/* ------------------------------------------------------------------ */

export interface AssistRuntime {
  db: Db;
  dataDir: string;
  connectionId: string;
  model: string;
  resolved: ResolvedConnection;
  req: StudioAssistRequest;
  prepared: PreparedAssist;
  signal: AbortSignal;
}

/** 内存副本 → §2.4 的 draft（按 PUT / 草稿规则校验） */
function toAssembleDraft(state: AssistState): AssembleDraft {
  const id = state.targetId as string;
  const w = state.working;
  let body: Json;
  if (state.kind === 'character') {
    body = { character: { id, data: w } };
  } else if (state.kind === 'preset') {
    body = { preset: { id, data: w } };
  } else {
    // 编辑器草稿里的条目带界面字段（key、extra、displayIndex …），只留 PUT 认的
    const entries = (Array.isArray(w.entries) ? w.entries : []).filter(isRecord).map((entry) => {
      const out: Json = {};
      if (typeof entry.id === 'string' && entry.id !== '') out.id = entry.id;
      else if (typeof entry.uid === 'number') out.uid = entry.uid;
      for (const key of ENTRY_FIELDS) if (entry[key] !== undefined) out[key] = entry[key];
      return out;
    });
    body = {
      lorebook: {
        id,
        entries,
        ...(typeof w.name === 'string' && w.name.trim() ? { name: w.name } : {}),
      },
    };
  }
  try {
    return parseDraft(body) ?? {};
  } catch (e) {
    if (e instanceof DraftInputError) {
      throw new ToolError(
        `当前草稿无法组装：${e.message}`,
        `The current draft cannot be assembled: ${e.message}`,
      );
    }
    throw e;
  }
}

function testChatFor(rt: AssistRuntime): ChatRow {
  const { db, req, prepared } = rt;
  if (req.testChatId) {
    const chat = loadChat(db, req.testChatId);
    if (!chat) {
      throw new ToolError(
        `测试会话不存在：${req.testChatId}`,
        `Test chat not found: ${req.testChatId}`,
      );
    }
    return chat;
  }
  try {
    return getOrCreateTestChat(db, prepared.state.kind, prepared.state.targetId as string).chat;
  } catch (e) {
    if (e instanceof StudioEntityNotFoundError) {
      throw new ToolError('编辑对象已不存在', 'The edited object no longer exists');
    }
    throw e;
  }
}

/** 用当前内存草稿在测试会话上组装一轮（dryRun：不推进世界书时间态、不落库）；可附一条用户消息 */
function assembleWithDraft(
  rt: AssistRuntime,
  userMessage: string | null,
): { result: AssembleResult; chat: ChatRow; overrides: ChatOverrides } {
  const { state } = rt.prepared;
  if (!state.targetId) {
    throw new ToolError(
      '还没有保存，没有测试会话，不能试跑；请先保存再试',
      'Not saved yet, so there is no test chat to run; save first',
    );
  }
  const draft = toAssembleDraft(state);
  const chat = testChatFor(rt);
  const overrides = (chat.overrides as ChatOverrides | null) ?? {};
  let nodes: NodeRow[] = loadNodes(rt.db, chat.id);
  let parentId = chat.headNodeId;
  if (userMessage !== null) {
    // 不落库的用户消息：只在这次组装里接在 head 后面
    const node: NodeRow = {
      id: 'studio-assist:user',
      chatId: chat.id,
      parentId,
      siblingSeq: nextSiblingSeq(nodes, parentId),
      role: 'user',
      name: null,
      parts: [{ type: 'text', text: userMessage }],
      reasoning: null,
      variables: null,
      wiState: null,
      usage: null,
      provider: null,
      model: null,
      isHidden: false,
      extra: null,
      createdAt: new Date(),
    };
    nodes = [...nodes, node];
    parentId = node.id;
  }
  const layoutMode: LayoutMode = overrides.layoutMode === 'cache-aware' ? 'cache-aware' : 'strict';
  const result = assemblePrompt(
    buildAssembleInput(rt.db, {
      chat,
      overrides,
      nodes,
      parentId,
      provider: rt.resolved.conn.provider,
      model: rt.model,
      layoutMode,
      caps: rt.resolved.adapter.capabilities(rt.model, rt.resolved.conn),
      dryRun: true,
      draft,
    }),
  );
  return { result, chat, overrides };
}

function segmentText(segment: Segment): string {
  return segment.parts
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join('\n');
}

function inspectPrompt(rt: AssistRuntime): { content: string; summary: string } {
  const { result } = assembleWithDraft(rt, null);
  const segments = result.ir.segments.map((segment) => {
    const text = segmentText(segment);
    return {
      origin: segment.origin.ref
        ? `${segment.origin.kind}:${segment.origin.ref}`
        : segment.origin.kind,
      role: segment.role,
      tokens: estimateTokens(text),
      preview: previewText(text, 120),
    };
  });
  const lang = rt.prepared.state.lang;
  return {
    content: truncateResult(
      JSON.stringify({
        tokenEstimate: result.ir.meta.tokenEstimate,
        segments,
        warnings: result.ir.meta.warnings.slice(0, 10),
      }),
      lang,
    ),
    summary: L(
      lang,
      `${segments.length} 段，约 ${result.ir.meta.tokenEstimate} token`,
      `${segments.length} segments, ~${result.ir.meta.tokenEstimate} tokens`,
    ),
  };
}

async function runTestTurn(
  rt: AssistRuntime,
  args: Json,
): Promise<{ content: string; summary: string }> {
  const lang = rt.prepared.state.lang;
  const message = typeof args.user_message === 'string' ? args.user_message : '';
  if (message.trim() === '') {
    throw new ToolError('user_message 不能为空', 'user_message must not be empty');
  }
  const { result, overrides } = assembleWithDraft(rt, message);
  const out = await callLlm(rt.db, rt.dataDir, {
    connectionId: rt.connectionId,
    model: rt.model,
    ir: result.ir,
    signal: rt.signal,
    ...(overrides.thinking ? { thinking: overrides.thinking } : {}),
  });
  if (out.error) {
    throw new ToolError(`试跑失败：${out.error.message}`, `Test run failed: ${out.error.message}`);
  }
  const reply = out.text;
  return {
    content: JSON.stringify({
      reply: reply.slice(0, TEST_REPLY_CHARS),
      length: reply.length,
      truncated: reply.length > TEST_REPLY_CHARS,
      stopReason: out.stop.reason,
    }),
    summary: L(
      lang,
      `试跑回复 ${reply.length} 字：${previewText(reply, 40)}`,
      `Test reply (${reply.length} chars): ${previewText(reply, 40)}`,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* 工具分发                                                             */
/* ------------------------------------------------------------------ */

function callSummary(name: string, args: Json, lang: StudioLang): string {
  const path = typeof args.path === 'string' ? args.path : '';
  switch (name) {
    case 'get_field':
      return L(lang, `读取 ${path}`, `Read ${path}`);
    case 'set_field':
      return L(lang, `修改 ${path}`, `Set ${path}`);
    case 'list_entries':
      return typeof args.query === 'string' && args.query
        ? L(lang, `列出条目：「${args.query}」`, `List entries: “${args.query}”`)
        : L(lang, '列出条目', 'List entries');
    case 'add_entry': {
      const entry = isRecord(args.entry) ? args.entry : {};
      const title = previewText(entry.comment ?? '', 30);
      return L(
        lang,
        `新增条目${title ? `「${title}」` : ''}`,
        `Add entry${title ? ` “${title}”` : ''}`,
      );
    }
    case 'update_entry':
      return L(lang, `修改条目 #${String(args.uid)}`, `Update entry #${String(args.uid)}`);
    case 'delete_entry':
      return L(lang, `删除条目 #${String(args.uid)}`, `Delete entry #${String(args.uid)}`);
    case 'set_prompt':
      return L(
        lang,
        `修改提示词 ${String(args.identifier)}`,
        `Set prompt ${String(args.identifier)}`,
      );
    case 'run_test_turn':
      return L(
        lang,
        `试跑一轮：「${previewText(args.user_message, 30)}」`,
        `Test turn: “${previewText(args.user_message, 30)}”`,
      );
    case 'inspect_prompt':
      return L(lang, '检查组装后的提示词', 'Inspect the assembled prompt');
    case 'search_reference':
      return L(lang, `检索「${String(args.query)}」`, `Search “${String(args.query)}”`);
    default:
      return name;
  }
}

/** 参数：优先 collectStream 解析好的；空参数当 {} */
function argsOf(call: CollectedToolCall): Json {
  if (call.parseError !== undefined) {
    throw new ToolError(
      `参数不是合法的 JSON：${call.parseError}`,
      `Arguments are not valid JSON: ${call.parseError}`,
    );
  }
  const parsed = call.parsed !== undefined ? call.parsed : call.args.trim() === '' ? {} : undefined;
  if (parsed === undefined) {
    try {
      const value = JSON.parse(call.args) as unknown;
      if (isRecord(value)) return value;
    } catch {
      // 落到下面报错
    }
    throw new ToolError('参数必须是 JSON 对象', 'Arguments must be a JSON object');
  }
  if (!isRecord(parsed))
    throw new ToolError('参数必须是 JSON 对象', 'Arguments must be a JSON object');
  return parsed;
}

async function executeTool(
  rt: AssistRuntime,
  available: readonly ToolName[],
  name: string,
  args: Json,
): Promise<{ content: string; summary: string }> {
  const { state } = rt.prepared;
  if (!isToolName(name)) {
    throw new ToolError(`未知工具：${name}`, `Unknown tool: ${name}`);
  }
  if (!available.includes(name)) {
    if (NEEDS_TARGET_ID.has(name) && !state.targetId) {
      throw new ToolError(
        '还没有保存，没有测试会话，不能试跑或检查提示词；请先保存再试',
        'Not saved yet, so there is no test chat to run or inspect; save first',
      );
    }
    throw new ToolError(
      `工具 ${name} 不适用于当前对象`,
      `Tool ${name} does not apply to this object`,
    );
  }
  switch (name) {
    case 'get_field':
      return getField(state, args);
    case 'set_field':
      return setField(state, args);
    case 'list_entries':
      return listEntries(rt.db, state, args);
    case 'add_entry':
      return addEntry(state, args, rt.prepared.dbMaxUid);
    case 'update_entry':
      return updateEntry(state, args);
    case 'delete_entry':
      return deleteEntry(state, args);
    case 'set_prompt':
      return setPrompt(state, args);
    case 'run_test_turn':
      return runTestTurn(rt, args);
    case 'inspect_prompt':
      return inspectPrompt(rt);
    case 'search_reference':
      return searchReference(rt.db, state, args);
  }
}

/* ------------------------------------------------------------------ */
/* 主循环                                                               */
/* ------------------------------------------------------------------ */

function seg(
  id: string,
  role: Segment['role'],
  parts: Part[],
  kind: SegmentOriginKind,
  stability: Segment['stability'],
): Segment {
  return {
    id,
    role,
    parts,
    origin: { kind },
    anchor: { slot: role === 'system' ? 'system' : 'history', order: 0 },
    stability,
  };
}

/** 协作提示词的基底：段落 + 预设带来的采样参数与元信息（无预设时为空） */
interface AssistPromptBase {
  segments: Segment[];
  sampling: SamplingParams;
  presetId: string;
  squashSystemMessages?: boolean;
  warnings: string[];
}

const INSTRUCTION_NODE_ID = 'studio:instruction';
const HISTORY_ORIGINS: ReadonlySet<SegmentOriginKind> = new Set(['history', 'user_input']);

function positiveNumber(source: Record<string, unknown> | null | undefined, key: string) {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 无预设（原行为）：工作台系统提示词 + 草稿概览 + 协作对话 + 本轮指令 */
function plainPromptBase(rt: AssistRuntime, head: Segment[]): AssistPromptBase {
  return {
    segments: [
      ...head,
      ...rt.req.conversation.map((turn, index) =>
        seg(
          `studio:conv:${index}`,
          turn.role,
          [{ type: 'text', text: turn.content }],
          'history',
          'history',
        ),
      ),
      seg(
        INSTRUCTION_NODE_ID,
        'user',
        [{ type: 'text', text: rt.req.instruction }],
        'user_input',
        'turn',
      ),
    ],
    sampling: {},
    presetId: '',
    warnings: [],
  };
}

/**
 * 带预设：复用对话组装器 `assemblePrompt`，让破限 / 文风类预设照常生效（用户多用中转站，
 * 空提示词容易被拒或出字差）。取舍：
 *
 * - **预设**：target 就是这份预设时用请求里的草稿（边改边用，规则同 `withPresetDraft`，
 *   采样参数随草稿重算）；草稿不合法（编辑中途）就退回已保存版。
 * - **角色**：null；**用户档案**：默认档案只提供 `{{user}}` 名字（描述置空、position none，不注入）。
 * - **历史**：协作对话各轮 + 本轮指令（最后一条 user）。组装器会对历史做宏替换 / 提示词侧正则 /
 *   删 EJS 块——但协作对话里常常**就是在讨论** `{{char}}`、`<% %>` 这些写法，所以组装完按
 *   节点 id 把历史段的正文换回原文（位置、深度注入、裁剪结果仍按组装器的来）。
 *   预设没有 chatHistory 标记时组装器不放历史，这时把各轮原样追加到末尾。
 * - **工作台系统提示词 + 草稿概览**：不走 `globalSystemPrompt`（它会过宏替换与 EJS 渲染，
 *   草稿里的 `{{…}}` / `<% %>` 会被展开甚至执行），而是组装后以原文插在预设 main 段之前
 *   （语义同 before_main；没有 main 就放最前）。
 * - **末尾预填**：预设的 assistant 预填（或 depth 0 的 assistant 注入）落在最后时与工具调用冲突
 *   （模型会接着预填续写正文，工具循环也要往末尾追加 assistant tool_call），去掉末尾所有
 *   非历史来源的 assistant 段。
 * - 世界书空、变量空表、正则不用：历史已换回原文，提示词侧正则只作用于历史与世界书，套了也无效。
 * - dryRun：不推进 WI 时间态、不产生变量副作用；EJS 模板按设置挂渲染器（只渲染预设段）。
 */
function presetPromptBase(rt: AssistRuntime, head: Segment[], saved: PresetRow): AssistPromptBase {
  const { db, req } = rt;
  let row = saved;
  if (req.target.kind === 'preset' && req.target.id === saved.id) {
    try {
      row =
        withPresetDraft(saved, parseDraft({ preset: { id: saved.id, data: req.draft } })) ?? saved;
    } catch (e) {
      if (!(e instanceof DraftInputError)) throw e;
    }
  }
  const data = row.data as Json;
  const caps = rt.resolved.adapter.capabilities(rt.model, rt.resolved.conn);
  // 同 buildAssembleInput：模型能力与预设 openai_max_context 取小
  const presetMaxContext =
    positiveNumber(row.sampling, 'openai_max_context') ??
    positiveNumber(data, 'openai_max_context');
  const maxContextTokens =
    presetMaxContext !== undefined ? Math.min(caps.maxContext, presetMaxContext) : caps.maxContext;
  const maxResponse =
    positiveNumber(row.sampling, 'openai_max_tokens') ??
    positiveNumber(data, 'openai_max_tokens') ??
    0;

  const personaId = readDefaultPersonaId(db);
  const persona = personaId
    ? db
        .select({ id: schema.personas.id, name: schema.personas.name })
        .from(schema.personas)
        .where(eq(schema.personas.id, personaId))
        .get()
    : undefined;

  const turns: { id: string; role: 'user' | 'assistant'; content: string }[] = [
    ...req.conversation.map((turn, index) => ({ id: `studio:conv:${index}`, ...turn })),
    { id: INSTRUCTION_NODE_ID, role: 'user', content: req.instruction },
  ];
  const raw = new Map(turns.map((turn) => [turn.id, turn.content]));
  const history: AssembleHistoryNode[] = turns.map((turn) => ({
    id: turn.id,
    role: turn.role,
    name: null,
    parts: [{ type: 'text', text: turn.content }],
  }));

  const input: AssembleInputV2 = {
    chatId: req.testChatId ?? '',
    model: rt.model,
    provider: rt.resolved.conn.provider,
    preset: {
      id: row.id,
      format: row.format,
      data,
      sampling: row.sampling ?? null,
    },
    character: null,
    persona: persona
      ? { id: persona.id, name: persona.name, description: '', position: 'none' }
      : null,
    history,
    layoutMode: 'strict',
    options: { maxContextTokens },
    lorebooks: [],
    wiSettings: readWISettings(db, { maxContext: maxContextTokens, maxResponse }),
    wiState: null,
    regexScripts: [],
    variables: { chat: {}, global: {} },
    messageCount: history.length,
    providerCaps: {
      caching: caps.caching,
      ...(caps.cacheMinTokens === undefined ? {} : { cacheMinTokens: caps.cacheMinTokens }),
      ...(caps.maxBreakpoints === undefined ? {} : { maxBreakpoints: caps.maxBreakpoints }),
      systemInMessages: caps.systemInMessages,
      prefill: caps.prefill,
    },
    rng: { seed: `studio-assist:${row.id}` },
    now: new Date(),
    dryRun: true,
  };
  const { ir } = assemblePrompt(withTemplateRenderer(db, input));

  // 历史段换回原文（见上）
  let segments = ir.segments.map((segment): Segment => {
    const ref = segment.origin.ref;
    const text = HISTORY_ORIGINS.has(segment.origin.kind) && ref ? raw.get(ref) : undefined;
    if (text === undefined) return segment;
    return {
      ...segment,
      parts: [...segment.parts.filter((part) => part.type !== 'text'), { type: 'text', text }],
    };
  });
  const warnings = [...ir.meta.warnings];
  // 预设没有 chatHistory 标记：本轮指令不在里面（裁剪不会丢 user_input），各轮原样追加到末尾
  if (!segments.some((segment) => segment.origin.ref === INSTRUCTION_NODE_ID)) {
    warnings.push('预设里没有 chatHistory 标记，协作对话已追加在末尾');
    segments.push(...plainPromptBase(rt, []).segments);
  }

  // 去掉末尾的预填（非历史来源的 assistant 段），见上
  while (segments.length > 0) {
    const tail = segments[segments.length - 1] as Segment;
    if (tail.role !== 'assistant' || HISTORY_ORIGINS.has(tail.origin.kind)) break;
    segments = segments.slice(0, -1);
  }

  // 工作台系统提示词 + 草稿概览：插在 main 之前（没有 main、或 main 被排到历史后面时放最前）
  const mainIndex = segments.findIndex(
    (segment) => segment.origin.kind === 'preset' && segment.origin.ref === 'main',
  );
  const firstHistory = segments.findIndex((segment) => HISTORY_ORIGINS.has(segment.origin.kind));
  const at = mainIndex >= 0 && (firstHistory < 0 || mainIndex < firstHistory) ? mainIndex : 0;
  segments = [...segments.slice(0, at), ...head, ...segments.slice(at)];

  return {
    segments,
    sampling: ir.sampling,
    presetId: row.id,
    ...(ir.meta.squashSystemMessages ? { squashSystemMessages: true } : {}),
    warnings,
  };
}

function buildIr(
  model: string,
  segments: Segment[],
  rt: AssistRuntime,
  tools: ReturnType<typeof toolDefs>,
  last: boolean,
  base: AssistPromptBase,
): PromptIR {
  return {
    model,
    sampling: base.sampling,
    // 拷贝：之后的轮次还会往 segments 里追加
    segments: [...segments],
    cachePlan: { breakpoints: [] },
    meta: {
      chatId: rt.req.testChatId ?? '',
      presetId: base.presetId,
      layoutMode: 'strict',
      activations: [],
      warnings: base.warnings,
      tokenEstimate: 0,
      ...(base.squashSystemMessages ? { squashSystemMessages: true } : {}),
    },
    tools,
    toolChoice: last ? 'none' : 'auto',
  };
}

/**
 * 跑一整轮。事件经 `emit` 发出；客户端断开（signal 中止）后不再发任何事件。
 * 上游错误：先发 `patch`（已做的改动仍可审阅），再发 `error`，不发 `done`。
 */
export async function runStudioAssist(rt: AssistRuntime, emit: StudioAssistEmit): Promise<void> {
  const { req, prepared, signal } = rt;
  const { state } = prepared;
  const lang = state.lang;
  const available = toolsFor(state.kind, state.targetId !== null);
  const defs = toolDefs(available, lang);

  const head: Segment[] = [
    seg(
      'studio:system',
      'system',
      [{ type: 'text', text: studioSystemPrompt(lang, state.kind, state.mode) }],
      'global_system',
      'static',
    ),
    seg(
      'studio:context',
      'system',
      [{ type: 'text', text: studioContextText(state, available) }],
      'global_system',
      'turn',
    ),
  ];
  // 预设只在一轮开始时组装一次：之后的工具步骤往末尾追加 tool_call / tool_result
  const base = prepared.preset
    ? presetPromptBase(rt, head, prepared.preset)
    : plainPromptBase(rt, head);
  const segments: Segment[] = base.segments;

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let sawUsage = false;
  let steps = 0;
  let stopReason: StudioAssistEvents['done']['stopReason'] = 'end';
  let failure: StudioAssistEvents['error'] | null = null;

  for (;;) {
    if (signal.aborted) return;
    steps += 1;
    const last = steps >= MAX_ASSIST_STEPS;
    const ir = buildIr(rt.model, segments, rt, defs, last, base);
    let result: Awaited<ReturnType<typeof callLlm>>;
    for (let attempt = 0; ; attempt += 1) {
      const pending: Promise<void>[] = [];
      let sawOutput = false;
      result = await callLlm(rt.db, rt.dataDir, {
        connectionId: rt.connectionId,
        model: rt.model,
        ir,
        signal,
        lang,
        ...(req.thinking ? { thinking: req.thinking } : {}),
        onEvent: (ev) => {
          if (signal.aborted) return;
          if (ev.type === 'text.delta' && ev.text !== '') {
            sawOutput = true;
            pending.push(Promise.resolve(emit('text', { delta: ev.text })));
          } else if (ev.type === 'reasoning.delta' && ev.text !== '') {
            sawOutput = true;
            pending.push(Promise.resolve(emit('reasoning', { delta: ev.text })));
          } else if (ev.type === 'tool.call') {
            sawOutput = true;
          }
        },
      });
      await Promise.all(pending);
      // 一轮要连调多次模型，偶发的限流 / 过载就让整轮失败太亏：没有任何输出时退避重试
      const retryable =
        result.error !== undefined &&
        !sawOutput &&
        TRANSIENT_ERRORS.has(result.error.kind) &&
        attempt < RETRY_DELAYS_MS.length &&
        !signal.aborted;
      if (!retryable) break;
      await sleep(RETRY_DELAYS_MS[attempt] as number, signal);
    }
    if (result.usage) {
      sawUsage = true;
      usage.input += result.usage.input;
      usage.output += result.usage.output;
      usage.cacheRead += result.usage.cacheRead;
      usage.cacheWrite += result.usage.cacheWrite;
      usage.reasoning += result.usage.reasoning;
    }
    if (signal.aborted || result.stop.reason === 'abort') return;
    if (result.error) {
      failure = { message: result.error.message, kind: result.error.kind };
      break;
    }
    const calls = result.toolCalls;
    if (calls.length === 0) break;
    if (last) {
      // 强制总结的那一次还在调工具：不再执行
      stopReason = 'max_steps';
      break;
    }

    segments.push(
      seg(
        `studio:step:${steps}:assistant`,
        'assistant',
        [
          ...result.opaque.map((o): Part => ({ type: 'reasoning_opaque', ...o })),
          ...(result.text !== '' ? [{ type: 'text', text: result.text } as Part] : []),
          ...calls.map((call): Part => ({
            type: 'tool_call',
            id: call.id,
            name: call.name,
            args: call.args.trim() === '' ? '{}' : call.args,
          })),
        ],
        'history',
        'history',
      ),
    );

    const results: Part[] = [];
    for (const call of calls) {
      if (signal.aborted) return;
      let args: Json | null = null;
      let argsError: ToolError | null = null;
      try {
        args = argsOf(call);
      } catch (e) {
        argsError = e as ToolError;
      }
      await emit('tool', {
        id: call.id,
        name: call.name,
        args: args ?? call.args,
        summary: callSummary(call.name, args ?? {}, lang),
      });
      let content: string;
      let summary: string;
      let ok = true;
      try {
        if (args === null) throw argsError ?? new ToolError('参数无效', 'Invalid arguments');
        const out = await executeTool(rt, available, call.name, args);
        content = out.content;
        summary = out.summary;
      } catch (e) {
        if (signal.aborted) return;
        ok = false;
        content =
          e instanceof ToolError
            ? e.text(lang)
            : L(lang, `工具出错：${(e as Error).message}`, `Tool failed: ${(e as Error).message}`);
        summary = content;
      }
      if (signal.aborted) return;
      await emit('tool_result', { id: call.id, ok, summary, content });
      results.push({
        type: 'tool_result',
        callId: call.id,
        name: call.name,
        content,
        ...(ok ? {} : { isError: true }),
      });
    }
    const parts: Part[] = [...results];
    if (steps + 1 >= MAX_ASSIST_STEPS) {
      parts.push({
        type: 'text',
        text: L(
          lang,
          '（已到工具调用步数上限：请不要再调用工具，直接用文字总结本轮的改动与建议。）',
          '(Tool step limit reached: do not call any more tools; summarize this round’s changes and suggestions in text.)',
        ),
      });
    }
    segments.push(seg(`studio:step:${steps}:results`, 'user', parts, 'history', 'history'));
  }

  if (signal.aborted) return;
  await emit('patch', { ops: state.tracker.build(state.original, state.working) });
  if (sawUsage) await emit('usage', usage);
  if (failure) {
    await emit('error', failure);
    return;
  }
  await emit('done', { steps, stopReason });
}
