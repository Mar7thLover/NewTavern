import type { PromptIR } from '@newtavern/core';

import { defaultMaxTokens, lookupCapabilities } from '../catalog.js';
import { errorTypeToKind, isAbortError, normalizeUnknownError } from '../errors.js';
import { providerFetch, providerGet, trimTrailingSlash } from '../http.js';
import {
  createMediaRenderer,
  resolveImageOutput,
  sourceUrl,
  type MediaRenderer,
} from '../media.js';
import { irToChatMessages, partsToText, type ChatMessage } from '../messages.js';
import { parseSseStream } from '../sse.js';
import { canDisableThinking, resolveThinking, stEffortToOpenAI } from '../thinking.js';
import type {
  BuildOptions,
  Connection,
  GenEvent,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
  ProviderError,
  ProviderRequest,
  ThinkingOptions,
} from '../types.js';

/**
 * OpenAI Responses 适配器（`POST /v1/responses`）。
 * 与 Chat Completions 的关键差异：
 *   - static 层 system 走顶层 `instructions`，其余消息走 `input[]`（每条一个 message 项）；
 *   - 推理产物是独立的 `reasoning` 输出项，`include:['reasoning.encrypted_content']` + `store:false`
 *     拿到 `encrypted_content` 后原样回传，分支/重生成不丢推理上下文；
 *   - 前缀缓存靠 `prompt_cache_key`（= chatId）稳定命中。
 *
 * 字段名已对照 https://developers.openai.com/api/reference/resources/responses/methods/create
 * 与 cookbook「reasoning items」核对；个别项标注「待核对」。
 */

export const OPENAI_RESPONSES_DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** 末尾不是 user 时补的占位（Responses 没有 assistant prefill） */
const RESPONSES_LAST_USER_FALLBACK = '[Continue]';

/** `include` 固定项：拿到加密推理内容才能在下一轮回传 */
const INCLUDE_ENCRYPTED_REASONING = 'reasoning.encrypted_content';

/**
 * effort 的全集。`none`/`xhigh` 见 GPT-5.x / GPT-6 的档位扩展，
 * 实际可用档位以 catalog 的 `effortLevels` 为准（不在其中的回退 medium）。
 */
const KNOWN_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
const DEFAULT_EFFORT = 'medium';

type ResponsesRole = 'user' | 'assistant' | 'developer';

type ResponsesContent =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }
  /** PDF：`file_data` 是 data URL（无需先上传拿 file_id） */
  | { type: 'input_file'; filename: string; file_data: string };

interface ResponsesMessageItem {
  role: ResponsesRole;
  content: ResponsesContent[];
}

type ResponsesInputItem = ResponsesMessageItem | Record<string, unknown>;

/** ChatMessage.role → Responses 的 input 角色：中途 system 降级为 developer */
function mapRole(role: ChatMessage['role']): ResponsesRole {
  return role === 'system' ? 'developer' : role;
}

/**
 * 渲染一条消息：
 * 返回 `leading` 是必须排在该消息**之前**的独立 input 项（历史加密推理项），
 * `content` 是消息自身的内容块。
 */
function renderMessage(
  msg: ChatMessage,
  model: string,
  media: MediaRenderer,
  warnings: string[],
): { leading: ResponsesInputItem[]; content: ResponsesContent[] } {
  const role = mapRole(msg.role);
  const leading: ResponsesInputItem[] = [];
  const content: ResponsesContent[] = [];
  // 图片 / PDF 只放进 user 消息：assistant 只能是 output_text，developer 按保守处理
  const roleCtx = { accepts: role === 'user', role };
  // assistant 的文本是模型的历史输出，必须用 output_text；user/developer 用 input_text
  const textBlock = (text: string): ResponsesContent =>
    role === 'assistant' ? { type: 'output_text', text } : { type: 'input_text', text };

  for (const part of msg.parts) {
    switch (part.type) {
      case 'text':
        content.push(textBlock(part.text));
        break;
      case 'image':
      case 'document': {
        const rendered = media.render(part, roleCtx);
        if (!rendered) break;
        if (rendered.kind === 'text') {
          content.push(textBlock(rendered.text));
        } else if (rendered.kind === 'image') {
          content.push({ type: 'input_image', image_url: sourceUrl(rendered.source) });
        } else {
          content.push({
            type: 'input_file',
            filename: rendered.filename,
            file_data: sourceUrl(rendered.source),
          });
        }
        break;
      }
      case 'reasoning_opaque': {
        if (part.provider !== 'openai-responses' || part.model !== model) {
          warnings.push(`推理块来自 ${part.provider}/${part.model}，与当前模型不符，已丢弃`);
          break;
        }
        const item = asRecord(part.payload);
        if (!item) break;
        // payload 就是当时 `response.output_item.done` 给的 reasoning 项，原样回传；
        // 只兜底补齐 type / summary，避免上游对缺字段报 400
        leading.push({
          ...item,
          type: 'reasoning',
          summary: Array.isArray(item.summary) ? item.summary : [],
        });
        break;
      }
    }
  }

  return { leading, content };
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

interface ResponsesBody {
  model: string;
  input: ResponsesInputItem[];
  stream: true;
  store: false;
  include: string[];
  max_output_tokens: number;
  [k: string]: unknown;
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
    // Responses 的 input 项没有 name 字段，name 前缀化写进正文（契约 §9 AS-8）
    mergeSameRole: true,
    nameStrategy: 'prefix',
  });

  const working = [...messages];
  // Responses 不支持 assistant prefill：末尾不是 user 就补一条占位 user
  const tail = working[working.length - 1];
  if (tail?.role !== 'user') {
    if (tail?.role === 'assistant') {
      warnings.push('Responses 不支持 assistant prefill，已在末尾补一条 user 消息');
    }
    working.push({
      role: 'user',
      parts: [{ type: 'text', text: RESPONSES_LAST_USER_FALLBACK }],
      segmentIds: [],
    });
  }

  // static 层 system → instructions（多块以空行连接）
  const instructions = systemBlocks
    .map((b) => {
      for (const part of b.parts) {
        if (part.type !== 'text') warnings.push(`instructions 只接受文本，已丢弃 ${part.type} 块`);
      }
      return partsToText(b.parts, '\n\n');
    })
    .filter((t) => t !== '')
    .join('\n\n');

  const media = createMediaRenderer({
    caps,
    resolveAsset: opts?.resolveAsset,
    label: 'Responses',
    warnings,
  });
  const input: ResponsesInputItem[] = [];
  for (const msg of working) {
    const { leading, content } = renderMessage(msg, model, media, warnings);
    input.push(...leading);
    if (content.length > 0) input.push({ role: mapRole(msg.role), content });
  }
  media.flush();

  const s = ir.sampling;
  const body: ResponsesBody = {
    model,
    input,
    stream: true,
    // 加密推理项的前提；同时避免把角色扮演内容留在 OpenAI 侧
    store: false,
    include: [INCLUDE_ENCRYPTED_REASONING],
    max_output_tokens: s.maxTokens ?? defaultMaxTokens(caps),
  };
  if (instructions !== '') body.instructions = instructions;
  // 前缀缓存命中靠稳定的 key；同一会话固定用 chatId
  if (ir.meta.chatId !== '') body.prompt_cache_key = ir.meta.chatId;

  // 采样：推理模型（o 系列 / GPT-5+）不接受 temperature / top_p
  const isReasoning = caps.thinking !== 'none';
  if (isReasoning) {
    if (s.temperature !== undefined || s.topP !== undefined) {
      warnings.push(`推理模型 ${model} 不接受 temperature/top_p，已丢弃`);
    }
  } else {
    if (s.temperature !== undefined) body.temperature = s.temperature;
    if (s.topP !== undefined) body.top_p = s.topP;
  }

  // reasoning：仅 effort 型能力；来源：会话覆盖 > IR 扩展 > 预设 reasoning_effort（见 thinking.ts）
  const resolved = resolveThinking(ir, opts);
  const thinkingOpt: ThinkingOptions = resolved.stEffort
    ? { effort: stEffortToOpenAI(resolved.stEffort, model) }
    : resolved.thinking;
  if (caps.thinking === 'effort') {
    // 关闭 = effort:'none'（GPT-5.1+），只有档位里有 none 的模型可关
    const canOff = canDisableThinking(caps) && (caps.effortLevels ?? []).includes('none');
    let effort: string;
    if (thinkingOpt.enabled === false && canOff) {
      effort = 'none';
    } else {
      if (thinkingOpt.enabled === false) {
        warnings.push(`模型 ${model} 不支持关闭推理，已按默认处理`);
      }
      const requested = thinkingOpt.enabled === false ? undefined : thinkingOpt.effort;
      effort = resolveEffort(requested, caps, model, warnings);
    }
    body.reasoning = { effort, summary: 'auto' };
    if (thinkingOpt.budgetTokens !== undefined) {
      warnings.push('Responses 用 effort 档位而非 budget_tokens，budgetTokens 已丢弃');
    }
  } else if (thinkingOpt.effort !== undefined || thinkingOpt.budgetTokens !== undefined) {
    warnings.push(`模型 ${model} 不支持推理参数，thinking 配置已丢弃`);
  }

  // 生图：image_generation 工具单独计费，缺省关，只在显式开启时追加（与已有 tools 合并）
  if (resolveImageOutput(opts, caps, false, model, warnings)) {
    const existing = Array.isArray(body.tools) ? (body.tools as unknown[]) : [];
    body.tools = [...existing, { type: 'image_generation' }];
  }

  // Responses 没有 stop / seed / penalty / top_k / min_p
  if (s.stop && s.stop.length > 0) warnings.push('Responses 不支持 stop 序列，已丢弃');
  if (s.seed !== undefined) warnings.push('Responses 不支持 seed，已丢弃');
  if (s.topK !== undefined) warnings.push('Responses 不支持 top_k，已丢弃');
  if (s.minP !== undefined) warnings.push('Responses 不支持 min_p，已丢弃');
  if (s.frequencyPenalty !== undefined) warnings.push('Responses 不支持 frequency_penalty，已丢弃');
  if (s.presencePenalty !== undefined) warnings.push('Responses 不支持 presence_penalty，已丢弃');
  if (s.repetitionPenalty !== undefined)
    warnings.push('Responses 不支持 repetition_penalty，已丢弃');

  return {
    method: 'POST',
    url: `${trimTrailingSlash(conn.baseUrl)}/responses`,
    headers: responsesHeaders(conn),
    body,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/** effort 校验：不在全集或不在该模型的 effortLevels 内则回退 medium */
function resolveEffort(
  raw: string | undefined,
  caps: ModelCapabilities,
  model: string,
  warnings: string[],
): string {
  const effort = raw ?? DEFAULT_EFFORT;
  if (!(KNOWN_EFFORTS as readonly string[]).includes(effort)) {
    warnings.push(`effort=${effort} 不是合法档位，已回退 ${DEFAULT_EFFORT}`);
    return DEFAULT_EFFORT;
  }
  if (caps.effortLevels && !caps.effortLevels.includes(effort)) {
    warnings.push(`effort=${effort} 不在 ${model} 的可用档位内，已回退 ${DEFAULT_EFFORT}`);
    return DEFAULT_EFFORT;
  }
  return effort;
}

function responsesHeaders(conn: Connection): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
    ...conn.headers,
  };
}

function capabilities(model: string, conn: Connection): ModelCapabilities {
  return lookupCapabilities('openai-responses', model, conn.modelOverrides?.[model]);
}

function normalizeError(e: unknown): ProviderError {
  const err = normalizeUnknownError(e);
  // Responses 的错误体同 Chat Completions：{ error: { message, type, code } }
  const detail = err.detail as { error?: { code?: unknown; type?: unknown } } | undefined;
  for (const candidate of [detail?.error?.code, detail?.error?.type]) {
    if (typeof candidate !== 'string') continue;
    const kind = errorTypeToKind(candidate);
    if (kind) return { ...err, kind, retryable: kind === 'rateLimit' || kind === 'overloaded' };
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

async function listModels(conn: Connection): Promise<ModelInfo[]> {
  try {
    const json = await providerGet(conn, `${trimTrailingSlash(conn.baseUrl)}/models`, {
      ...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
    });
    const data = (json as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    return data
      .map((m): ModelInfo | null => {
        const row = m as Record<string, unknown>;
        const id = typeof row.id === 'string' ? row.id : null;
        if (!id) return null;
        const info: ModelInfo = { id };
        if (typeof row.name === 'string') info.name = row.name;
        const ctx = row.context_length ?? row.context_window;
        if (typeof ctx === 'number') info.contextLength = ctx;
        return info;
      })
      .filter((m): m is ModelInfo => m !== null);
  } catch (e) {
    throw toProviderException(e);
  }
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

function toUsageEvent(u: ResponsesUsage): Extract<GenEvent, { type: 'usage' }> {
  const cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
  const inputTokens = u.input_tokens ?? 0;
  return {
    type: 'usage',
    // input_tokens 含缓存命中，减去后 input + cacheRead + cacheWrite = 总输入
    input: Math.max(0, inputTokens - cacheRead),
    output: u.output_tokens ?? 0,
    cacheRead,
    cacheWrite: 0,
    reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

/** `response.incomplete` 的 `incomplete_details.reason` → stop 原因 */
function mapIncompleteReason(reason: string | undefined): Extract<GenEvent, { type: 'stop' }> {
  switch (reason) {
    case 'max_output_tokens':
      return { type: 'stop', reason: 'length' };
    case 'content_filter':
      return { type: 'stop', reason: 'filter' };
    default:
      return { type: 'stop', reason: 'end', ...(reason ? { detail: reason } : {}) };
  }
}

/** image_generation_call.output_format → mime（缺省 png） */
function imageMimeOf(format: unknown): string {
  switch (typeof format === 'string' ? format.toLowerCase() : '') {
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

/** 从 message 输出项里捞 refusal 文本（非流式 refusal 的情形） */
function refusalOf(item: Record<string, unknown>): string {
  const content = item.content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const c of content) {
    const block = asRecord(c);
    if (block?.type === 'refusal' && typeof block.refusal === 'string') out += block.refusal;
  }
  return out;
}

function errorEvent(
  code: unknown,
  message: unknown,
  raw: unknown,
): Extract<GenEvent, { type: 'error' }> {
  const kind =
    (typeof code === 'string' ? errorTypeToKind(code) : undefined) ??
    normalizeError(new Error(typeof message === 'string' ? message : JSON.stringify(raw))).kind;
  const error: ProviderError = {
    kind,
    message: typeof message === 'string' ? message : JSON.stringify(raw),
    retryable: kind === 'rateLimit' || kind === 'overloaded' || kind === 'network',
    detail: raw,
  };
  return { type: 'error', error, retryable: error.retryable };
}

async function* stream(
  conn: Connection,
  req: ProviderRequest,
  signal: AbortSignal,
): AsyncGenerator<GenEvent, void, undefined> {
  const model = (req.body as { model?: string }).model ?? '';
  let usage: Extract<GenEvent, { type: 'usage' }> | undefined;
  let stopEvent: Extract<GenEvent, { type: 'stop' }> | undefined;
  let refusal = '';

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
      // Responses 的 `event:` 名与 data.type 一致，两者取其一
      const type = (typeof chunk.type === 'string' ? chunk.type : ev.event) ?? '';
      const response = asRecord(chunk.response);

      switch (type) {
        case 'response.output_text.delta': {
          const delta = chunk.delta;
          if (typeof delta === 'string' && delta !== '') yield { type: 'text.delta', text: delta };
          break;
        }
        case 'response.reasoning_summary_text.delta': {
          const delta = chunk.delta;
          if (typeof delta === 'string' && delta !== '')
            yield { type: 'reasoning.delta', text: delta };
          break;
        }
        case 'response.refusal.delta': {
          const delta = chunk.delta;
          if (typeof delta === 'string') refusal += delta;
          break;
        }
        // `.completed` 是防御性别名：待核对官方是否两者都发
        case 'response.output_item.done':
        case 'response.output_item.completed': {
          const item = asRecord(chunk.item);
          if (!item) break;
          if (item.type === 'reasoning') {
            // 原样保留整项：下一轮作为独立 input 项回传即可复原推理上下文
            yield { type: 'reasoning.opaque', provider: 'openai-responses', model, payload: item };
          } else if (item.type === 'image_generation_call') {
            const result = item.result;
            if (typeof result === 'string' && result !== '') {
              // image_generation 工具的 result 是 base64；output_format（png/jpeg/webp）缺省为 png
              yield { type: 'image', mime: imageMimeOf(item.output_format), data: result };
            }
          } else if (item.type === 'message') {
            const text = refusalOf(item);
            if (text !== '') refusal += text;
          }
          break;
        }
        case 'response.completed': {
          const u = asRecord(response?.usage);
          if (u) usage = toUsageEvent(u as ResponsesUsage);
          stopEvent = { type: 'stop', reason: 'end' };
          break;
        }
        case 'response.incomplete': {
          const u = asRecord(response?.usage);
          if (u) usage = toUsageEvent(u as ResponsesUsage);
          const details = asRecord(response?.incomplete_details);
          const reason = typeof details?.reason === 'string' ? details.reason : undefined;
          stopEvent = mapIncompleteReason(reason);
          break;
        }
        case 'response.failed': {
          const err = asRecord(response?.error) ?? {};
          yield errorEvent(err.code, err.message, err);
          return;
        }
        case 'error': {
          yield errorEvent(chunk.code, chunk.message, chunk);
          return;
        }
        default:
          // response.created / output_item.added / content_part.* / *.done 等无需映射
          break;
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

  if (usage) yield usage;
  if (refusal !== '') {
    yield { type: 'stop', reason: 'refusal', detail: refusal };
    return;
  }
  yield stopEvent ?? { type: 'stop', reason: 'end' };
}

export const openaiResponsesAdapter: ProviderAdapter = {
  id: 'openai-responses',
  listModels,
  capabilities,
  buildRequest,
  stream,
  normalizeError,
};
