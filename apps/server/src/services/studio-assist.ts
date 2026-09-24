import {
  estimateTokens,
  type Part,
  type PromptIR,
  type Segment,
  type SegmentOriginKind,
} from '@newtavern/core';
import type { CollectedToolCall } from '@newtavern/providers';
import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { assemblePrompt, type AssembleResult } from './assemble.js';
import { buildAssembleInput } from './assemble-input.js';
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
import { DraftInputError, parseDraft, type AssembleDraft } from './studio-draft.js';
import { getOrCreateTestChat, StudioEntityNotFoundError } from './studio-test-chat.js';

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
  for (const key of ['connectionId', 'model', 'testChatId'] as const) {
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
  };
}

export class AssistTargetNotFoundError extends Error {}

export interface PreparedAssist {
  state: AssistState;
  /** lorebook：库里这本书的最大 uid（新条目 uid 接在后面）；其余为 -1 */
  dbMaxUid: number;
}

/** 检查 target 存在并建内存副本；target.id 指向不存在的实体时抛 AssistTargetNotFoundError */
export function prepareAssist(db: Db, req: StudioAssistRequest): PreparedAssist {
  const { kind, id } = req.target;
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

function buildIr(
  model: string,
  segments: Segment[],
  rt: AssistRuntime,
  tools: ReturnType<typeof toolDefs>,
  last: boolean,
): PromptIR {
  return {
    model,
    sampling: {},
    // 拷贝：之后的轮次还会往 segments 里追加
    segments: [...segments],
    cachePlan: { breakpoints: [] },
    meta: {
      chatId: rt.req.testChatId ?? '',
      presetId: '',
      layoutMode: 'strict',
      activations: [],
      warnings: [],
      tokenEstimate: 0,
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

  const segments: Segment[] = [
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
    ...req.conversation.map((turn, index) =>
      seg(
        `studio:conv:${index}`,
        turn.role,
        [{ type: 'text', text: turn.content }],
        'history',
        'history',
      ),
    ),
    seg(
      'studio:instruction',
      'user',
      [{ type: 'text', text: req.instruction }],
      'user_input',
      'turn',
    ),
  ];

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  let sawUsage = false;
  let steps = 0;
  let stopReason: StudioAssistEvents['done']['stopReason'] = 'end';
  let failure: StudioAssistEvents['error'] | null = null;

  for (;;) {
    if (signal.aborted) return;
    steps += 1;
    const last = steps >= MAX_ASSIST_STEPS;
    const ir = buildIr(rt.model, segments, rt, defs, last);
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
