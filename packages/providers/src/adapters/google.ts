import type { Part, PromptIR } from '@newtavern/core';

import { defaultMaxTokens, lookupCapabilities } from '../catalog.js';
import {
  errorTypeToKind,
  httpStatusToKind,
  isAbortError,
  isRetryableKind,
  normalizeUnknownError,
} from '../errors.js';
import { providerFetch, providerGet, trimTrailingSlash } from '../http.js';
import {
  createMediaRenderer,
  EMPTY_TEXT_PLACEHOLDER,
  isMediaPart,
  resolveImageOutput,
  type MediaRenderer,
} from '../media.js';
import { irToChatMessages, mergeAdjacentSameRole, type ChatMessage } from '../messages.js';
import { parseSseStream } from '../sse.js';
import { canDisableThinking, resolveThinking, stEffortToGoogle } from '../thinking.js';
import type {
  BuildOptions,
  Connection,
  GenEvent,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
  ProviderError,
  ProviderErrorKind,
  ProviderRequest,
  ThinkingOptions,
} from '../types.js';

/**
 * Google Gemini（generativeLanguage / AI Studio）适配器。
 * 要点：system 抽到 `systemInstruction`；contents 只有 user/model（system 降级 user）；
 * thinkingConfig 分 thinkingLevel（3.x）与 thinkingBudget（2.5）两套；
 * safety 全开（BLOCK_NONE）；`thought===true` 的 part 是推理文本，`thoughtSignature` 需原样回传。
 */

export const GOOGLE_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
export const GOOGLE_API_VERSION = 'v1beta';

/** 开头/末尾必须是 user 时的占位（沿用 ST 与其他适配器的做法） */
const START_PLACEHOLDER = '[Start]';
const CONTINUE_PLACEHOLDER = '[Continue]';

/**
 * 安全设置：契约要求全部类别 BLOCK_NONE。
 * （ST 1.18 用的是更新的 `OFF` 档，见 src/constants.js 的 GEMINI_SAFETY；
 *   BLOCK_NONE 在 v1beta 上兼容性更好，故按契约取 BLOCK_NONE。）
 */
const SAFETY_CATEGORIES = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
  'HARM_CATEGORY_CIVIC_INTEGRITY',
] as const;

export interface GoogleSafetySetting {
  category: string;
  threshold: string;
}

/** 每次调用返回新数组，保证 buildRequest 的返回值互不共享引用 */
function safetySettings(): GoogleSafetySetting[] {
  return SAFETY_CATEGORIES.map((category) => ({ category, threshold: 'BLOCK_NONE' }));
}

/** thinkingLevel 的合法档位（catalog 未声明 effortLevels 时的兜底） */
const DEFAULT_THINKING_LEVELS = ['low', 'high'];
const FALLBACK_THINKING_LEVEL = 'high';

interface GoogleInlineData {
  mimeType: string;
  data: string;
}

interface GooglePart {
  text?: string;
  /** 推理文本标记（响应侧） */
  thought?: boolean;
  /**
   * 推理签名。Gemini 要求签名"附着在 part 上"而不是单独成块：
   * 见 ST `src/prompt-converters.js` 的 convertGooglePrompt——
   * `parts.forEach(part => { if (textSignature && typeof part.text === 'string') part.thoughtSignature = textSignature; })`，
   * 即回传形状是 `{ text, thoughtSignature }`。
   */
  thoughtSignature?: string;
  inlineData?: GoogleInlineData;
}

interface GoogleContent {
  role: 'user' | 'model';
  parts: GooglePart[];
}

interface GoogleThinkingConfig {
  includeThoughts: boolean;
  thinkingLevel?: string;
  thinkingBudget?: number;
}

interface GoogleGenerationConfig {
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  thinkingConfig?: GoogleThinkingConfig;
  /** 生图模型：`['TEXT','IMAGE']` 允许输出图片 */
  responseModalities?: string[];
}

interface GoogleBody {
  contents: GoogleContent[];
  safetySettings: GoogleSafetySetting[];
  generationConfig: GoogleGenerationConfig;
  systemInstruction?: { parts: GooglePart[] };
}

/** 签名附着的目标种类：模型输出里的文本段 / 图片 */
type SignatureTarget = 'text' | 'image';

/**
 * 历史里的一个签名。
 * - 新格式（M4 起流式解析写入）：`target` + `ordinal` = 该签名在那次响应里挂在第几个文本段 / 第几张图片上；
 * - 旧格式（只有 `thoughtSignature` 或裸字符串）：按出现顺序附着到文本 part。
 */
interface PendingSignature {
  signature: string;
  target?: SignatureTarget;
  ordinal?: number;
  /** 该签名所属节点在本条（可能已合并的）消息里的起点：此前已有的文本 / 图片 part 数 */
  base: Record<SignatureTarget, number>;
}

/** 从 `reasoning_opaque.payload` 里取签名：兼容 `{ thoughtSignature, target, ordinal }` 与裸字符串 */
function extractSignature(
  payload: unknown,
): Pick<PendingSignature, 'signature' | 'target' | 'ordinal'> | undefined {
  if (typeof payload === 'string') return payload === '' ? undefined : { signature: payload };
  if (typeof payload === 'object' && payload !== null) {
    const p = payload as { thoughtSignature?: unknown; target?: unknown; ordinal?: unknown };
    if (typeof p.thoughtSignature !== 'string' || p.thoughtSignature === '') return undefined;
    const target = p.target === 'text' || p.target === 'image' ? p.target : undefined;
    const ordinal =
      typeof p.ordinal === 'number' && Number.isInteger(p.ordinal) && p.ordinal >= 0
        ? p.ordinal
        : undefined;
    return {
      signature: p.thoughtSignature,
      ...(target !== undefined && ordinal !== undefined ? { target, ordinal } : {}),
    };
  }
  return undefined;
}

/**
 * 渲染一段 parts。`role`：'user' / 'model' 进 contents（都可带 inlineData），
 * 'systemInstruction' 只收文本，媒体丢弃并告警。
 */
function renderParts(
  parts: readonly Part[],
  role: 'user' | 'model' | 'systemInstruction',
  model: string,
  media: MediaRenderer,
  warnings: string[],
): GooglePart[] {
  const out: GooglePart[] = [];
  const roleCtx = { accepts: role !== 'systemInstruction', role };
  /** IR 里第 n 个文本 / 图片 part 渲染到了 out 的哪个下标（被丢弃的为 -1） */
  const slots: Record<SignatureTarget, number[]> = { text: [], image: [] };
  const signatures: PendingSignature[] = [];
  let prevOpaque = false;
  let groupBase: Record<SignatureTarget, number> = { text: 0, image: 0 };

  for (const part of parts) {
    const isOpaque = part.type === 'reasoning_opaque';
    // 组装器把每个节点的推理块放在该节点 parts 开头；合并过的消息里，签名的序号从这一组推理块之后算起
    if (isOpaque && !prevOpaque) groupBase = { text: slots.text.length, image: slots.image.length };
    prevOpaque = isOpaque;

    switch (part.type) {
      case 'text':
        slots.text.push(out.length);
        out.push({ text: part.text });
        break;
      case 'image':
      case 'document': {
        const rendered = media.render(part, roleCtx);
        const isImage = part.type === 'image';
        if (!rendered) {
          if (isImage) slots.image.push(-1);
          break;
        }
        if (isImage) slots.image.push(out.length);
        if (rendered.kind === 'text') {
          out.push({ text: rendered.text });
        } else if (rendered.source.type === 'inline') {
          out.push({ inlineData: { mimeType: rendered.mime, data: rendered.source.base64 } });
        } else {
          // 预览（没有 resolver）：占位文本
          out.push({ text: rendered.source.url });
        }
        break;
      }
      case 'reasoning_opaque': {
        if (part.provider !== 'google' || part.model !== model) {
          warnings.push(`推理块来自 ${part.provider}/${part.model}，与当前模型不符，已丢弃`);
          break;
        }
        const sig = extractSignature(part.payload);
        if (sig === undefined) {
          warnings.push('推理块里没有 thoughtSignature，已丢弃');
          break;
        }
        signatures.push({ ...sig, base: groupBase });
        break;
      }
    }
  }

  attachSignatures(out, slots, signatures, warnings);
  return out;
}

/**
 * 签名附着（Gemini 不接受独立的推理块，签名必须挂在 part 上；生图模型的签名也挂在 inlineData part 上）：
 * 1. 带 target/ordinal 的签名挂到对应的文本段 / 图片；
 * 2. 旧格式签名按顺序挂到还没有签名的文本 part；
 * 3. 目标不存在（被丢弃、或那次响应里是空文本）的签名，退而挂到第一个还没有签名的文本 / 图片 part。
 */
function attachSignatures(
  out: GooglePart[],
  slots: Record<SignatureTarget, number[]>,
  signatures: readonly PendingSignature[],
  warnings: string[],
): void {
  const unplaced: string[] = [];
  const legacy: string[] = [];
  for (const sig of signatures) {
    if (sig.target === undefined || sig.ordinal === undefined) {
      legacy.push(sig.signature);
      continue;
    }
    const idx = slots[sig.target][sig.base[sig.target] + sig.ordinal];
    const part = idx === undefined || idx < 0 ? undefined : out[idx];
    if (part && part.thoughtSignature === undefined) part.thoughtSignature = sig.signature;
    else unplaced.push(sig.signature);
  }

  const place = (signature: string, allowImage: boolean): boolean => {
    const part = out.find(
      (p) =>
        p.thoughtSignature === undefined &&
        (typeof p.text === 'string' || (allowImage && p.inlineData !== undefined)),
    );
    if (!part) return false;
    part.thoughtSignature = signature;
    return true;
  };

  let dropped = 0;
  for (const s of legacy) if (!place(s, false)) dropped += 1;
  for (const s of unplaced) if (!place(s, true)) dropped += 1;
  if (dropped > 0) {
    warnings.push(`有 ${dropped} 个 thoughtSignature 没有可附着的文本 / 图片 part，已丢弃`);
  }
}

/** `ir.sampling` 上的扩展字段（core 目前未声明，按可选读取） */

/** system → user（Gemini contents 只有 user/model） */
function downgradeSystemRoles(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (m.role === 'system' ? { ...m, role: 'user' as const } : m));
}

function placeholder(text: string): ChatMessage {
  return { role: 'user', parts: [{ type: 'text', text }], segmentIds: [] };
}

function buildRequest(
  ir: PromptIR,
  conn: Connection,
  model: string,
  opts?: BuildOptions,
): ProviderRequest {
  const warnings: string[] = [];
  const caps = capabilities(model, conn);

  const { systemBlocks, messages } = irToChatMessages(ir, {
    systemPlacement: 'top',
    // Gemini 没有消息级 name 字段，且相邻同角色要合并，name 前缀化写进正文（契约 §9 AS-8）
    mergeSameRole: true,
    nameStrategy: 'prefix',
  });

  // 1. system 降级为 user，降级后再合并一次相邻同角色
  let working = mergeAdjacentSameRole(downgradeSystemRoles(messages));

  // 2. 首条必须是 user
  if (working.length === 0) {
    working = [placeholder(CONTINUE_PLACEHOLDER)];
  } else if (working[0]?.role !== 'user') {
    working.unshift(placeholder(START_PLACEHOLDER));
  }

  // 3. 末尾必须是 user
  const tail = working[working.length - 1];
  if (tail && tail.role !== 'user') working.push(placeholder(CONTINUE_PLACEHOLDER));

  const media = createMediaRenderer({
    caps,
    resolveAsset: opts?.resolveAsset,
    label: 'Gemini',
    warnings,
  });
  const contents: GoogleContent[] = working.map((msg) => {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = renderParts(msg.parts, role, model, media, warnings);
    // 只有媒体、且媒体全被丢弃时 parts 为空（API 会 400）：零宽空格占位
    if (parts.length === 0 && msg.parts.some(isMediaPart)) {
      parts.push({ text: EMPTY_TEXT_PLACEHOLDER });
    }
    return { role, parts };
  });
  const systemParts = systemBlocks.flatMap((b) =>
    renderParts(b.parts, 'systemInstruction', model, media, warnings),
  );
  media.flush();

  const s = ir.sampling;
  const generationConfig: GoogleGenerationConfig = {
    maxOutputTokens: s.maxTokens ?? defaultMaxTokens(caps),
  };
  if (s.temperature !== undefined) generationConfig.temperature = s.temperature;
  if (s.topP !== undefined) generationConfig.topP = s.topP;
  if (s.topK !== undefined) generationConfig.topK = s.topK;
  if (s.seed !== undefined) generationConfig.seed = s.seed;
  if (s.presencePenalty !== undefined) generationConfig.presencePenalty = s.presencePenalty;
  if (s.frequencyPenalty !== undefined) generationConfig.frequencyPenalty = s.frequencyPenalty;
  if (s.stop && s.stop.length > 0) generationConfig.stopSequences = s.stop;
  if (s.minP !== undefined) warnings.push('Gemini 不支持 min_p，已丢弃');
  if (s.repetitionPenalty !== undefined) warnings.push('Gemini 不支持 repetition_penalty，已丢弃');

  // 4. thinkingConfig：3.x 走 thinkingLevel，2.5 走 thinkingBudget（-1 = 由模型自动决定）
  //    来源：会话覆盖 > IR 扩展 > 预设 reasoning_effort（见 thinking.ts）
  const resolved = resolveThinking(ir, opts);
  let thinkingOpt: ThinkingOptions = resolved.stEffort
    ? stEffortToGoogle(resolved.stEffort, model, generationConfig.maxOutputTokens)
    : resolved.thinking;
  // 只有 budget 型（2.5 Flash 系）能用 thinkingBudget=0 关闭；3.x 的 thinkingLevel 没有「关」
  if (thinkingOpt.enabled === false && !(canDisableThinking(caps) && caps.thinking === 'budget')) {
    if (caps.thinking !== 'none') warnings.push(`模型 ${model} 不支持关闭推理，已按默认处理`);
    thinkingOpt = {};
  }
  if (thinkingOpt.enabled === false) {
    generationConfig.thinkingConfig = { thinkingBudget: 0, includeThoughts: false };
  } else if (caps.thinking === 'level') {
    const levels = caps.effortLevels ?? DEFAULT_THINKING_LEVELS;
    let level = thinkingOpt.effort ?? FALLBACK_THINKING_LEVEL;
    if (!levels.includes(level)) {
      warnings.push(
        `thinkingLevel=${level} 不是 ${model} 的合法档位（${levels.join('/')}），已回退 ${FALLBACK_THINKING_LEVEL}`,
      );
      level = FALLBACK_THINKING_LEVEL;
    }
    generationConfig.thinkingConfig = { thinkingLevel: level, includeThoughts: true };
    if (thinkingOpt.budgetTokens !== undefined) {
      warnings.push('该模型用 thinkingLevel 控制推理，thinkingBudget 已丢弃');
    }
  } else if (caps.thinking === 'budget') {
    generationConfig.thinkingConfig = {
      thinkingBudget: thinkingOpt.budgetTokens ?? -1,
      includeThoughts: true,
    };
    if (thinkingOpt.effort !== undefined) {
      warnings.push(`该模型用 thinkingBudget 控制推理，effort=${thinkingOpt.effort} 已丢弃`);
    }
  } else if (thinkingOpt.effort !== undefined || thinkingOpt.budgetTokens !== undefined) {
    warnings.push(`模型 ${model} 不支持推理参数，thinking 配置已丢弃`);
  }

  // 5. 生图：缺省在 caps.imageOut 时开；显式关闭生图模型时只要文本
  const imageOutput = resolveImageOutput(opts, caps, caps.imageOut, model, warnings);
  if (imageOutput) {
    generationConfig.responseModalities = ['TEXT', 'IMAGE'];
  } else if (opts?.imageOutput === false && caps.imageOut) {
    generationConfig.responseModalities = ['TEXT'];
  }

  const body: GoogleBody = {
    contents,
    safetySettings: safetySettings(),
    generationConfig,
  };

  if (systemParts.length > 0) body.systemInstruction = { parts: systemParts };

  return {
    method: 'POST',
    url: `${modelsBase(conn)}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    headers: googleHeaders(conn),
    body,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function apiBase(conn: Connection): string {
  return `${trimTrailingSlash(conn.baseUrl || GOOGLE_DEFAULT_BASE_URL)}/${GOOGLE_API_VERSION}`;
}

function modelsBase(conn: Connection): string {
  return `${apiBase(conn)}/models`;
}

function googleHeaders(conn: Connection): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(conn.apiKey ? { 'x-goog-api-key': conn.apiKey } : {}),
    ...conn.headers,
  };
}

function capabilities(model: string, conn: Connection): ModelCapabilities {
  return lookupCapabilities('google', model, conn.modelOverrides?.[model]);
}

/** INVALID_ARGUMENT 里带这些字样的基本都是上下文超限 */
const TOKEN_HINT = /token|length|too long|exceed/i;

function kindFromGoogleStatus(
  status: string | undefined,
  message: string | undefined,
  httpStatus: number | undefined,
): ProviderErrorKind {
  const byStatus = errorTypeToKind(status);
  if (byStatus) return byStatus;
  if (status === 'INVALID_ARGUMENT') {
    return TOKEN_HINT.test(message ?? '') ? 'contextLength' : 'invalid';
  }
  if (httpStatus !== undefined) return httpStatusToKind(httpStatus);
  return 'invalid';
}

/** Google 错误体 `{ error: { code, message, status } }` → ProviderError */
function errorFromGoogleBody(raw: unknown, httpStatus?: number): ProviderError {
  const err = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    code?: unknown;
    message?: unknown;
    status?: unknown;
  };
  const status = typeof err.status === 'string' ? err.status : undefined;
  const message = typeof err.message === 'string' ? err.message : 'Google 返回了错误';
  const code = typeof err.code === 'number' ? err.code : httpStatus;
  const kind = kindFromGoogleStatus(status, message, code);
  return {
    kind,
    message,
    ...(code !== undefined ? { status: code } : {}),
    retryable: isRetryableKind(kind),
    detail: raw,
  };
}

function normalizeError(e: unknown): ProviderError {
  const err = normalizeUnknownError(e);
  const root = err.detail as { error?: unknown } | undefined;
  if (root && typeof root === 'object' && typeof root.error === 'object' && root.error !== null) {
    return { ...errorFromGoogleBody(root.error, err.status), detail: err.detail };
  }
  return err;
}

function toProviderException(e: unknown): Error & { providerError: ProviderError } {
  const pe = normalizeError(e);
  const err = new Error(pe.message) as Error & { providerError: ProviderError };
  err.name = 'ProviderErrorException';
  err.providerError = pe;
  return err;
}

interface GoogleModelRow {
  name?: unknown;
  displayName?: unknown;
  inputTokenLimit?: unknown;
  outputTokenLimit?: unknown;
  supportedGenerationMethods?: unknown;
}

async function listModels(conn: Connection): Promise<ModelInfo[]> {
  try {
    const json = await providerGet(conn, `${modelsBase(conn)}?pageSize=200`, googleHeaders(conn));
    const models = (json as { models?: unknown }).models;
    if (!Array.isArray(models)) return [];
    return models
      .map((m): ModelInfo | null => {
        const row = m as GoogleModelRow;
        if (typeof row.name !== 'string' || row.name === '') return null;
        // 只保留能走 generateContent 的（排除 embedding / countTokens-only 模型）
        const methods = row.supportedGenerationMethods;
        if (!Array.isArray(methods) || !methods.includes('generateContent')) return null;
        const info: ModelInfo = { id: row.name.replace(/^models\//, '') };
        if (typeof row.displayName === 'string') info.name = row.displayName;
        if (typeof row.inputTokenLimit === 'number') info.contextLength = row.inputTokenLimit;
        if (typeof row.outputTokenLimit === 'number') info.maxOutput = row.outputTokenLimit;
        return info;
      })
      .filter((m): m is ModelInfo => m !== null);
  } catch (e) {
    throw toProviderException(e);
  }
}

interface GoogleUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}

function toUsageEvent(u: GoogleUsageMetadata): Extract<GenEvent, { type: 'usage' }> {
  const cacheRead = u.cachedContentTokenCount ?? 0;
  const prompt = u.promptTokenCount ?? 0;
  return {
    type: 'usage',
    // Gemini 的 promptTokenCount 含缓存命中，减去后 input + cacheRead + cacheWrite = 总输入
    input: Math.max(0, prompt - cacheRead),
    output: u.candidatesTokenCount ?? 0,
    cacheRead,
    // Gemini 隐式缓存不收写入 token，显式 cachedContents 也不在本次请求里计费
    cacheWrite: 0,
    reasoning: u.thoughtsTokenCount ?? 0,
  };
}

const FILTER_FINISH_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

function mapFinishReason(reason: string): Extract<GenEvent, { type: 'stop' }> {
  if (reason === 'STOP') return { type: 'stop', reason: 'end' };
  if (reason === 'MAX_TOKENS') return { type: 'stop', reason: 'length' };
  if (FILTER_FINISH_REASONS.has(reason)) return { type: 'stop', reason: 'filter', detail: reason };
  return { type: 'stop', reason: 'end', detail: reason };
}

/** Google 把模型名放在 URL 里而不是 body，reasoning.opaque 需要它 */
function modelFromUrl(url: string): string {
  const m = /\/models\/([^:/?]+):/.exec(url);
  return m?.[1] === undefined ? '' : decodeURIComponent(m[1]);
}

interface GoogleCandidate {
  content?: { parts?: unknown };
  finishReason?: unknown;
}

async function* stream(
  conn: Connection,
  req: ProviderRequest,
  signal: AbortSignal,
): AsyncGenerator<GenEvent, void, undefined> {
  const model = modelFromUrl(req.url);
  let usage: Extract<GenEvent, { type: 'usage' }> | undefined;
  let stopEvent: Extract<GenEvent, { type: 'stop' }> | undefined;
  /** thoughtSignature 通常只出现在最后一个 chunk；按值去重后在流末统一 yield */
  const signatures = new Map<
    string,
    { partIndex: number; target: SignatureTarget; ordinal: number }
  >();
  /**
   * 输出位置计数，与服务端落库的 parts 对齐（连续文本增量合并为一个 text part、图片按到达顺序交错）：
   * textRuns = 已开始的文本段数（被图片隔开算新的一段），images = 已输出的图片数。
   */
  let textRuns = 0;
  let images = 0;
  let lastOutput: SignatureTarget | null = null;

  try {
    const res = await providerFetch(conn, req, signal);
    if (!res.body) throw new Error('响应没有可读流');

    for await (const ev of parseSseStream(res.body)) {
      if (signal.aborted) {
        yield { type: 'stop', reason: 'abort' };
        return;
      }
      const data = ev.data.trim();
      if (data === '' || data === '[DONE]') continue;

      let chunk: Record<string, unknown>;
      try {
        chunk = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      // 流内错误（配额耗尽等，Google 会在建立流之后再塞一条）
      if (chunk.error !== undefined && chunk.error !== null) {
        const pe = errorFromGoogleBody(chunk.error);
        yield { type: 'error', error: pe, retryable: pe.retryable };
        return;
      }

      if (chunk.usageMetadata) usage = toUsageEvent(chunk.usageMetadata as GoogleUsageMetadata);

      const candidates = Array.isArray(chunk.candidates) ? chunk.candidates : [];
      const candidate = candidates[0] as GoogleCandidate | undefined;

      // 提示词被拦截：没有候选，只有 promptFeedback.blockReason
      const feedback = chunk.promptFeedback as { blockReason?: unknown } | undefined;
      if (
        candidate === undefined &&
        feedback &&
        typeof feedback.blockReason === 'string' &&
        feedback.blockReason !== ''
      ) {
        stopEvent = { type: 'stop', reason: 'filter', detail: feedback.blockReason };
        continue;
      }
      if (!candidate) continue;

      const rawParts = candidate.content?.parts;
      const parts: unknown[] = Array.isArray(rawParts) ? rawParts : [];
      for (const [i, rawPart] of parts.entries()) {
        const part = (typeof rawPart === 'object' && rawPart !== null ? rawPart : {}) as GooglePart;
        const inline = part.inlineData;
        // 签名挂在哪：图片 part → 这张图；其余（文本、空文本、thought 文本）→ 当前文本段（还没有就是第一段）
        let target: SignatureTarget = 'text';
        let ordinal = Math.max(0, textRuns - 1);

        if (typeof part.text === 'string' && part.text !== '') {
          if (part.thought === true) {
            yield { type: 'reasoning.delta', text: part.text };
          } else {
            if (lastOutput !== 'text') {
              textRuns += 1;
              lastOutput = 'text';
            }
            ordinal = textRuns - 1;
            yield { type: 'text.delta', text: part.text };
          }
        }
        // thought 图片是推理过程中的草图，不作为输出
        if (inline && typeof inline.data === 'string' && part.thought !== true) {
          target = 'image';
          ordinal = images;
          images += 1;
          lastOutput = 'image';
          yield {
            type: 'image',
            mime: typeof inline.mimeType === 'string' ? inline.mimeType : 'image/png',
            data: inline.data,
          };
        }

        if (typeof part.thoughtSignature === 'string' && part.thoughtSignature !== '') {
          if (!signatures.has(part.thoughtSignature)) {
            signatures.set(part.thoughtSignature, { partIndex: i, target, ordinal });
          }
        }
      }

      if (typeof candidate.finishReason === 'string' && candidate.finishReason !== '') {
        stopEvent = mapFinishReason(candidate.finishReason);
      }
    }
  } catch (e) {
    if (signal.aborted || isAbortError(e)) {
      yield { type: 'stop', reason: 'abort' };
      return;
    }
    const pe = normalizeError(e);
    yield { type: 'error', error: pe, retryable: pe.retryable };
    return;
  }

  for (const [thoughtSignature, where] of signatures) {
    yield {
      type: 'reasoning.opaque',
      provider: 'google',
      model,
      // target + ordinal 让回传时能挂回同一个文本段 / 同一张图（见 renderParts）
      payload: { type: 'thoughtSignature', thoughtSignature, ...where },
    };
  }
  if (usage) yield usage;
  yield stopEvent ?? { type: 'stop', reason: 'end' };
}

export const googleAdapter: ProviderAdapter = {
  id: 'google',
  listModels,
  capabilities,
  buildRequest,
  stream,
  normalizeError,
};
