import {
  assembleWriting,
  estimateTokens,
  WRITING_ACTIONS,
  type LayoutProviderCaps,
  type PromptIR,
  type Segment,
  type WritingAction,
  type WritingAssembleInput,
  type WritingAssembleResult,
  type WritingContextReport,
} from '@newtavern/core';
import type { ModelCapabilities } from '@newtavern/providers';
import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { readGenerationDefault } from './generation-context.js';
import { resolveGlobalSystemPrompt } from './global-system-prompt.js';
import { callLlm } from './llm.js';
import {
  createProviderService,
  ProviderServiceError,
  type ProviderService,
  type ResolvedConnection,
} from './providers.js';
import { createSecrets } from './secrets.js';
import { loadWIBooks } from './wi-map.js';
import { readWISettings } from './wi-settings.js';
import {
  loadDocument,
  loadProject,
  loadProjectDocuments,
  normalizeProjectSettings,
  projectLanguage,
  WritingError,
  type WritingDocumentRow,
  type WritingLayoutMode,
  type WritingProjectRow,
  type WritingProjectSettings,
} from './writing.js';
import { loadWritingTemplates } from './writing-prompts.js';

/**
 * 写作的 AI 部分（M7 契约 §2 / §3）：请求解析、连接解析、从库里拼 `WritingAssembleInput`、
 * 章节完成后的后台摘要。SSE 本身在 `routes/writing.ts`。
 */

// ── 请求 / 响应类型 ─────────────────────────────────────

/**
 * `POST /api/writing/documents/:docId/ai` 的请求体。
 * 文本以前端提交的为准（编辑器里可能有尚未保存的改动）：
 * - `textBefore` 缺省时用库里已保存的 `text` 按 `cursor`（纯文本偏移）切；
 * - `selectionText` 缺省时按 `selection`（纯文本偏移）从库里的 `text` 切；
 * - `summarize` 用整章：给了 `textBefore` 时取 `textBefore + selectionText + textAfter`，否则取库里的 `text`。
 */
export interface WritingAiRequest {
  action: WritingAction;
  instruction?: string;
  cursor?: number;
  selection?: { from: number; to: number };
  textBefore?: string;
  textAfter?: string;
  selectionText?: string;
  /** 续写目标长度（中文字 / 英文词） */
  targetLength?: number;
  /** 本次覆盖项目设置里的连接 / 模型（不写回项目） */
  connectionId?: string;
  model?: string;
}

/** `POST /api/writing/projects/:id/inspect` 的请求体 */
export interface WritingInspectRequest extends WritingAiRequest {
  docId: string;
}

export interface WritingInspectResponse {
  /** 是否解析到了可用连接（没有时用缺省能力与预算预览） */
  connected: boolean;
  connectionId: string | null;
  model: string | null;
  layoutMode: WritingLayoutMode;
  budget: number;
  segments: Segment[];
  cachePlan: PromptIR['cachePlan'];
  report: WritingContextReport;
}

/** AI SSE 的事件（`event:` 名 → `data` 形状） */
export interface WritingAiEvents {
  context: { report: WritingContextReport; model: string; connectionId: string };
  text: { delta: string };
  reasoning: { delta: string };
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
  done: {
    text: string;
    stopReason: string;
    usage: WritingAiEvents['usage'] | null;
    /** summarize 动作写回的摘要（其它动作没有） */
    summary?: string;
    /** 动作前存的那一版（与上一版相同未写入时为 null） */
    beforeVersion: number | null;
  };
  error: { message: string; kind?: string };
}

// ── 请求校验 ───────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const optionalString = (value: unknown) => value === undefined || typeof value === 'string';
const optionalNumber = (value: unknown) =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value));

/** 校验并规整请求体；不合法时返回错误信息 */
export function parseAiRequest(body: unknown): WritingAiRequest | string {
  if (!isRecord(body)) return '请求体必须是对象';
  if (!WRITING_ACTIONS.includes(body.action as WritingAction)) return 'action 非法';
  for (const key of [
    'instruction',
    'textBefore',
    'textAfter',
    'selectionText',
    'connectionId',
    'model',
  ]) {
    if (!optionalString(body[key])) return `${key} 必须是字符串`;
  }
  if (!optionalNumber(body.cursor)) return 'cursor 必须是数字';
  if (!optionalNumber(body.targetLength)) return 'targetLength 必须是数字';
  if (body.selection !== undefined && body.selection !== null) {
    const s = body.selection;
    if (!isRecord(s) || typeof s.from !== 'number' || typeof s.to !== 'number' || s.from > s.to) {
      return 'selection 必须是 { from, to }';
    }
  }
  return {
    action: body.action as WritingAction,
    ...(typeof body.instruction === 'string' ? { instruction: body.instruction } : {}),
    ...(typeof body.cursor === 'number' ? { cursor: body.cursor } : {}),
    ...(isRecord(body.selection)
      ? { selection: { from: body.selection.from as number, to: body.selection.to as number } }
      : {}),
    ...(typeof body.textBefore === 'string' ? { textBefore: body.textBefore } : {}),
    ...(typeof body.textAfter === 'string' ? { textAfter: body.textAfter } : {}),
    ...(typeof body.selectionText === 'string' ? { selectionText: body.selectionText } : {}),
    ...(typeof body.targetLength === 'number' ? { targetLength: body.targetLength } : {}),
    ...(typeof body.connectionId === 'string' ? { connectionId: body.connectionId } : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
  };
}

// ── 连接与预算 ─────────────────────────────────────────

/** 没有可用连接时（inspect 预览）用的缺省能力 */
const FALLBACK_MAX_CONTEXT = 32_768;
const FALLBACK_CAPS: LayoutProviderCaps = {
  caching: 'none',
  systemInMessages: true,
  prefill: false,
};
/** 缺省预算 = 模型 maxContext 的 60% */
export const WRITING_BUDGET_SHARE = 0.6;

const providerServices = new WeakMap<Db, ProviderService>();

/**
 * 解析连接拿能力（预算、布局要用）。每个库一个 ProviderService；真正的调用走 `llm.ts`，
 * 它自己有一份服务实例（Key 轮换计数各算各的，不影响正确性）。
 */
function writingProviders(db: Db, dataDir: string): ProviderService {
  let service = providerServices.get(db);
  if (!service) {
    service = createProviderService(db, createSecrets(dataDir));
    providerServices.set(db, service);
  }
  return service;
}

export interface WritingTarget {
  connectionId: string;
  model: string;
  resolved: ResolvedConnection;
  caps: ModelCapabilities;
}

/**
 * 连接 / 模型：请求覆盖 > 项目设置 > 全局默认（`generation.default`）。
 * 都没有时返回 null；连接不存在或适配器未注册时抛 `WritingError(400, 'no_connection')`。
 */
export async function resolveWritingTarget(
  db: Db,
  dataDir: string,
  settings: WritingProjectSettings,
  override: { connectionId?: string; model?: string } = {},
): Promise<WritingTarget | null> {
  const fallback = readGenerationDefault(db);
  const connectionId = override.connectionId ?? settings.connectionId ?? fallback.connectionId;
  const model = override.model ?? settings.model ?? fallback.model;
  if (!connectionId || !model) return null;
  try {
    const resolved = await writingProviders(db, dataDir).resolveConnection(connectionId);
    return {
      connectionId,
      model,
      resolved,
      caps: resolved.adapter.capabilities(model, resolved.conn),
    };
  } catch (e) {
    if (e instanceof ProviderServiceError) throw new WritingError(400, 'no_connection', e.message);
    throw e;
  }
}

export function layoutCapsOf(caps: ModelCapabilities): LayoutProviderCaps {
  return {
    caching: caps.caching,
    ...(caps.cacheMinTokens === undefined ? {} : { cacheMinTokens: caps.cacheMinTokens }),
    ...(caps.maxBreakpoints === undefined ? {} : { maxBreakpoints: caps.maxBreakpoints }),
    systemInMessages: caps.systemInMessages,
    prefill: caps.prefill,
  };
}

export function writingBudget(
  settings: WritingProjectSettings,
  caps: ModelCapabilities | null,
): number {
  if (typeof settings.contextBudget === 'number' && settings.contextBudget > 0) {
    return Math.floor(settings.contextBudget);
  }
  return Math.floor((caps?.maxContext ?? FALLBACK_MAX_CONTEXT) * WRITING_BUDGET_SHARE);
}

// ── 组装 ───────────────────────────────────────────────

/** 光标 / 选区文本（见 `WritingAiRequest` 的说明） */
export function cursorTexts(
  doc: WritingDocumentRow,
  req: WritingAiRequest,
): { textBefore: string; selection?: string; textAfter?: string } {
  const clamp = (n: number) => Math.max(0, Math.min(doc.text.length, Math.floor(n)));
  const selectionText =
    req.selectionText ??
    (req.selection
      ? doc.text.slice(clamp(req.selection.from), clamp(req.selection.to))
      : undefined);
  if (req.action === 'summarize') {
    const full =
      req.textBefore !== undefined
        ? `${req.textBefore}${req.selectionText ?? ''}${req.textAfter ?? ''}`
        : doc.text;
    return { textBefore: full };
  }
  if (req.textBefore !== undefined) {
    return {
      textBefore: req.textBefore,
      ...(selectionText ? { selection: selectionText } : {}),
      ...(req.textAfter ? { textAfter: req.textAfter } : {}),
    };
  }
  const start = req.selection ? clamp(req.selection.from) : clamp(req.cursor ?? doc.text.length);
  const end = req.selection ? clamp(req.selection.to) : start;
  const textAfter = doc.text.slice(end);
  return {
    textBefore: doc.text.slice(0, start),
    ...(selectionText ? { selection: selectionText } : {}),
    ...(textAfter ? { textAfter } : {}),
  };
}

export interface WritingAssembleContext {
  project: WritingProjectRow;
  doc: WritingDocumentRow;
  req: WritingAiRequest;
  target: WritingTarget | null;
}

/** 从库里拼 `WritingAssembleInput`（圣经 / 全局系统提示词 / 章节与笔记 / 模板）并组装 */
export function assembleForDocument(
  db: Db,
  ctx: WritingAssembleContext,
): { input: WritingAssembleInput; result: WritingAssembleResult; budget: number } {
  const settings = normalizeProjectSettings(ctx.project.settings);
  const language = projectLanguage(settings);
  const budget = writingBudget(settings, ctx.target?.caps ?? null);
  const docs = loadProjectDocuments(db, ctx.project.id);
  const input: WritingAssembleInput = {
    project: {
      id: ctx.project.id,
      title: ctx.project.title,
      styleGuide: settings.styleGuide,
      ...(typeof settings.systemPrompt === 'string' ? { systemPrompt: settings.systemPrompt } : {}),
      outline: ctx.project.outline,
      language,
    },
    chapters: docs
      .filter((doc) => doc.kind === 'chapter')
      .map((doc) => ({
        id: doc.id,
        title: doc.title,
        order: doc.docOrder,
        summary: doc.summary,
        summaryStale: doc.summaryStale,
        done: doc.done,
        text: doc.text,
      })),
    notes: docs
      .filter((doc) => doc.kind === 'note')
      .map((doc) => ({ id: doc.id, title: doc.title, text: doc.text })),
    current: { id: ctx.doc.id, ...cursorTexts(ctx.doc, ctx.req) },
    action: ctx.req.action,
    ...(ctx.req.instruction ? { instruction: ctx.req.instruction } : {}),
    ...(ctx.req.targetLength ? { targetLength: ctx.req.targetLength } : {}),
    bible: loadWIBooks(db, {
      globalBookIds: ctx.project.lorebookIds,
      chatBookIds: [],
      characterBookId: null,
    }),
    // 世界书预算按写作预算换算（写作没有「回复长度」的预设，maxResponse 记 0）
    wiSettings: readWISettings(db, { maxContext: budget, maxResponse: 0 }),
    globalSystemPrompt: resolveGlobalSystemPrompt(db, null)?.text ?? null,
    model: ctx.target?.model ?? '',
    providerCaps: ctx.target ? layoutCapsOf(ctx.target.caps) : FALLBACK_CAPS,
    layoutMode: settings.layoutMode,
    budget,
    countTokens: estimateTokens,
    templates: loadWritingTemplates(language),
  };
  return { input, result: assembleWriting(input), budget };
}

// ── 章节完成后的后台摘要 ───────────────────────────────

const pendingSummaries = new Map<string, Promise<void>>();

export function isSummaryPending(docId: string): boolean {
  return pendingSummaries.has(docId);
}

/** 测试用：等某个文档的后台摘要跑完（没有在跑就立即返回） */
export async function waitForSummary(docId: string): Promise<void> {
  await pendingSummaries.get(docId);
}

/**
 * 起一次后台摘要（不 await）：用项目的连接对整章做 `summarize`，完成后写回 `summary`。
 * 生成期间正文又被改过时把 `summaryStale` 置 true。没有连接 / 失败时静默放弃
 * （前端下次读取看到仍无摘要，可以手动用 AI 动作重试）。同一文档同时只跑一个。
 */
export function startChapterSummary(db: Db, dataDir: string, docId: string): Promise<void> | null {
  if (pendingSummaries.has(docId)) return null;
  const run = (async () => {
    const doc = loadDocument(db, docId);
    const project = doc ? loadProject(db, doc.projectId) : undefined;
    if (!doc || !project || doc.text.trim() === '') return;
    const settings = normalizeProjectSettings(project.settings);
    const target = await resolveWritingTarget(db, dataDir, settings);
    if (!target) return;
    const { result } = assembleForDocument(db, {
      project,
      doc,
      req: { action: 'summarize' },
      target,
    });
    const out = await callLlm(db, dataDir, {
      connectionId: target.connectionId,
      model: target.model,
      ir: result.ir,
      ...(settings.thinking ? { thinking: settings.thinking } : {}),
    });
    const summary = out.text.trim();
    if (out.error || summary === '') {
      console.warn(
        `[writing] 章节 ${docId} 自动摘要失败：${out.error?.message ?? '模型没有返回文本'}`,
      );
      return;
    }
    const now = loadDocument(db, docId);
    if (!now) return;
    db.update(schema.documents)
      .set({ summary, summaryStale: now.text !== doc.text, updatedAt: new Date() })
      .where(eq(schema.documents.id, docId))
      .run();
  })()
    .catch((e: unknown) => {
      console.warn(`[writing] 章节 ${docId} 自动摘要失败：${(e as Error).message}`);
    })
    .finally(() => {
      pendingSummaries.delete(docId);
    });
  pendingSummaries.set(docId, run);
  return run;
}
