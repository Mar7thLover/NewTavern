import type { Db } from '../db/client.js';
import {
  assemblePrompt,
  diffLayouts,
  type AssembleResult,
  type LayoutDiff,
  type LayoutReport,
  type PromptIR,
  type WIScanResult,
} from './assemble.js';
import { buildAssembleInput } from './assemble-input.js';
import type { AssetsService } from './assets.js';
import { pathToNode, type Usage } from './chat-tree.js';
import type { GenerationContext, LayoutMode } from './generation-context.js';
import { buildProviderRequest, requestForInspect } from './provider-request.js';

/**
 * 提示词检查器与「与 ST 请求比对」的服务层（M3 契约 §6）。
 * 两个端点都以 `dryRun: true` 组装：不推进 WI 时间态、不落变量副作用。
 */

export interface InspectWorldInfo {
  activations: WIScanResult['activations'];
  rejected: WIScanResult['rejected'];
  budgetUsed: number;
  overflowed: boolean;
}

export interface InspectData {
  layoutMode: LayoutMode;
  ir: PromptIR;
  /** 适配器构造出的原生请求（已去 headers） */
  request: Record<string, unknown>;
  strictIr: PromptIR | null;
  diff: LayoutDiff | null;
  layout: LayoutReport;
  wi: InspectWorldInfo;
  warnings: string[];
  tokenEstimate: number;
  /** parentId 所在路径上最近一条带 usage 的 assistant 消息 */
  lastUsage: Usage | null;
}

/** 组装一轮（检查器 / 比对共用）；`layoutMode` 可强制为 strict */
function assembleFor(
  db: Db,
  context: GenerationContext,
  layoutMode: LayoutMode,
  assets?: AssetsService,
): AssembleResult {
  const { resolved, model } = context;
  return assemblePrompt(
    buildAssembleInput(db, {
      chat: context.chat,
      overrides: context.overrides,
      nodes: context.nodes,
      parentId: context.parentId,
      provider: resolved.conn.provider,
      model,
      layoutMode,
      caps: resolved.adapter.capabilities(model, resolved.conn),
      // 文档附件与真实请求一样先内联（M4 §3.3）；图片 / PDF 仍是 asset:<id> 占位（不传解析器）
      ...(assets ? { assets } : {}),
      dryRun: true,
    }),
  );
}

/** 路径上最后一条 assistant 的 usage（前端展示「上一轮实际 cacheRead/cacheWrite」） */
export function readLastUsage(context: GenerationContext): Usage | null {
  if (!context.parentId) return null;
  const path = pathToNode(context.nodes, context.parentId);
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const node = path[i];
    if (node?.role !== 'assistant') continue;
    const usage = node.usage as Usage | null;
    if (usage) return usage;
  }
  return null;
}

export function buildInspect(
  db: Db,
  context: GenerationContext,
  assets?: AssetsService,
): InspectData {
  const result = assembleFor(db, context, context.layoutMode, assets);
  const request = buildProviderRequest(
    context.resolved.adapter,
    result.ir,
    context.resolved.conn,
    context.model,
    context.overrides.thinking,
    { imageOutput: context.overrides.imageOutput },
  );
  const strictIr = context.layoutMode === 'cache-aware' ? (result.strictIr ?? null) : null;

  return {
    layoutMode: context.layoutMode,
    ir: result.ir,
    request: requestForInspect(request),
    strictIr,
    diff: strictIr ? diffLayouts(strictIr, result.ir) : null,
    layout: result.layout,
    wi: {
      activations: result.wi.activations,
      rejected: result.wi.rejected,
      budgetUsed: result.wi.budgetUsed,
      overflowed: result.wi.overflowed,
    },
    warnings: result.ir.meta.warnings,
    tokenEstimate: result.ir.meta.tokenEstimate,
    lastUsage: readLastUsage(context),
  };
}

// ───────────────────────── 与 ST 请求比对 ─────────────────────────

export interface CompareMessage {
  role: string;
  content: unknown;
  name?: string;
}

export interface CompareResult {
  same: boolean;
  /** -1 表示没有差异 */
  firstDiffIndex: number;
  ours: CompareMessage[];
  theirs: CompareMessage[];
  hints: string[];
}

function toCompareMessage(value: unknown): CompareMessage {
  const row = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    role: typeof row.role === 'string' ? row.role : '',
    content: row.content ?? '',
    ...(typeof row.name === 'string' ? { name: row.name } : {}),
  };
}

/** 从粘贴的 ST 请求体里取 messages（允许直接粘 messages 数组） */
export function readStMessages(stRequest: unknown): CompareMessage[] | null {
  if (Array.isArray(stRequest)) return stRequest.map(toCompareMessage);
  if (typeof stRequest !== 'object' || stRequest === null) return null;
  const messages = (stRequest as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;
  return messages.map(toCompareMessage);
}

function sameMessage(a: CompareMessage | undefined, b: CompareMessage | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function clip(value: unknown, limit = 120): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '（空）';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 逐条比对本地 strict 输出与 ST 请求；差异位置与可读提示一并返回 */
export function compareMessages(
  ours: CompareMessage[],
  theirs: CompareMessage[],
): Omit<CompareResult, 'ours' | 'theirs'> {
  const hints: string[] = [];
  if (ours.length !== theirs.length) {
    hints.push(`消息条数不同：我们 ${ours.length} 条，ST ${theirs.length} 条`);
  }
  const max = Math.max(ours.length, theirs.length);
  let firstDiffIndex = -1;
  for (let i = 0; i < max; i += 1) {
    if (sameMessage(ours[i], theirs[i])) continue;
    firstDiffIndex = i;
    const a = ours[i];
    const b = theirs[i];
    if (!a) hints.push(`第 ${i} 条我们缺失，ST 是 ${b?.role}：${clip(b?.content)}`);
    else if (!b) hints.push(`第 ${i} 条 ST 缺失，我们是 ${a.role}：${clip(a.content)}`);
    else {
      if (a.role !== b.role) hints.push(`第 ${i} 条 role 不同：我们 ${a.role}，ST ${b.role}`);
      if ((a.name ?? null) !== (b.name ?? null)) {
        hints.push(`第 ${i} 条 name 不同：我们 ${a.name ?? '（无）'}，ST ${b.name ?? '（无）'}`);
      }
      if (JSON.stringify(a.content) !== JSON.stringify(b.content)) {
        hints.push(`第 ${i} 条正文不同：我们 ${clip(a.content)} ／ ST ${clip(b.content)}`);
      }
    }
    break;
  }
  if (firstDiffIndex === -1) hints.push('逐条一致');
  return { same: firstDiffIndex === -1, firstDiffIndex, hints };
}

/** `POST /api/inspect/compare`：本地 strict 组装 → 适配器请求体 → 与 ST 的 messages 逐条比对 */
export function buildCompare(
  db: Db,
  context: GenerationContext,
  stRequest: unknown,
): CompareResult {
  const theirs = readStMessages(stRequest);
  // strict 才有「与 ST 一致」的语义（契约 §6）
  const result = assembleFor(db, context, 'strict');
  const request = buildProviderRequest(
    context.resolved.adapter,
    result.ir,
    context.resolved.conn,
    context.model,
  );
  const body = (request.body ?? {}) as { messages?: unknown };
  const ours = Array.isArray(body.messages) ? body.messages.map(toCompareMessage) : [];

  if (theirs === null) {
    return {
      same: false,
      firstDiffIndex: 0,
      ours,
      theirs: [],
      hints: ['粘贴的内容里没有 messages 数组：请贴 ST 发给端点的完整请求体，或直接贴 messages'],
    };
  }
  const compared = compareMessages(ours, theirs);
  return { ...compared, ours, theirs };
}
