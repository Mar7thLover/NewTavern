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
import { irToChatMessages, mergeAdjacentSameRole, type ChatMessage } from '../messages.js';
import { parseSseStream } from '../sse.js';
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
}

interface GoogleBody {
  contents: GoogleContent[];
  safetySettings: GoogleSafetySetting[];
  generationConfig: GoogleGenerationConfig;
  systemInstruction?: { parts: GooglePart[] };
}

/** 从 `reasoning_opaque.payload` 里取签名：兼容 `{ thoughtSignature }` 与裸字符串 */
function extractSignature(payload: unknown): string | undefined {
  if (typeof payload === 'string') return payload === '' ? undefined : payload;
  if (typeof payload === 'object' && payload !== null) {
    const v = (payload as { thoughtSignature?: unknown }).thoughtSignature;
    if (typeof v === 'string' && v !== '') return v;
  }
  return undefined;
}

function renderParts(parts: readonly Part[], model: string, warnings: string[]): GooglePart[] {
  const out: GooglePart[] = [];
  const signatures: string[] = [];

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        out.push({ text: part.text });
        break;
      case 'image':
        // assetId 占位，由服务端在 M4 替换为 inlineData { mimeType, data }
        out.push({ text: `asset:${part.assetId}` });
        warnings.push(`图片 ${part.assetId} 以 asset: 占位文本渲染，需由服务端替换为 inlineData`);
        break;
      case 'document':
        out.push({ text: `asset:${part.assetId}` });
        warnings.push(`文档 ${part.assetId} 以 asset: 占位文本渲染，需由服务端替换为 inlineData`);
        break;
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
        signatures.push(sig);
        break;
      }
    }
  }

  // 签名按出现顺序附着到文本 part 上（Gemini 不接受独立的推理块）
  let used = 0;
  for (const p of out) {
    if (used >= signatures.length) break;
    if (typeof p.text !== 'string') continue;
    const sig = signatures[used];
    used += 1;
    if (sig !== undefined) p.thoughtSignature = sig;
  }
  if (used < signatures.length) {
    warnings.push(
      `有 ${signatures.length - used} 个 thoughtSignature 没有可附着的文本 part，已丢弃`,
    );
  }

  return out;
}

/** `ir.sampling` 上的扩展字段（core 目前未声明，按可选读取） */
function irThinking(ir: PromptIR): { effort?: string; budgetTokens?: number } {
  const ext = (ir.sampling as Record<string, unknown>).thinking;
  if (typeof ext !== 'object' || ext === null) return {};
  const obj = ext as { effort?: unknown; budgetTokens?: unknown };
  return {
    ...(typeof obj.effort === 'string' ? { effort: obj.effort } : {}),
    ...(typeof obj.budgetTokens === 'number' ? { budgetTokens: obj.budgetTokens } : {}),
  };
}

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
    mergeSameRole: true,
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

  const contents: GoogleContent[] = working.map((msg) => ({
    role: msg.role === 'assistant' ? 'model' : 'user',
    parts: renderParts(msg.parts, model, warnings),
  }));

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
  const thinkingOpt = { ...irThinking(ir), ...opts?.thinking };
  if (caps.thinking === 'level') {
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

  const body: GoogleBody = {
    contents,
    safetySettings: safetySettings(),
    generationConfig,
  };

  const systemParts = systemBlocks.flatMap((b) => renderParts(b.parts, model, warnings));
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
  const signatures = new Map<string, number>();

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
        if (typeof part.thoughtSignature === 'string' && part.thoughtSignature !== '') {
          if (!signatures.has(part.thoughtSignature)) signatures.set(part.thoughtSignature, i);
        }
        if (typeof part.text === 'string' && part.text !== '') {
          if (part.thought === true) yield { type: 'reasoning.delta', text: part.text };
          else yield { type: 'text.delta', text: part.text };
        }
        const inline = part.inlineData;
        if (inline && typeof inline.data === 'string') {
          yield {
            type: 'image',
            mime: typeof inline.mimeType === 'string' ? inline.mimeType : 'image/png',
            data: inline.data,
          };
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

  for (const [thoughtSignature, partIndex] of signatures) {
    yield {
      type: 'reasoning.opaque',
      provider: 'google',
      model,
      payload: { type: 'thoughtSignature', thoughtSignature, partIndex },
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
