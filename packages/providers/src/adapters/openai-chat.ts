import type { Part, PromptIR } from '@newtavern/core';

import { defaultMaxTokens, lookupCapabilities } from '../catalog.js';
import { errorTypeToKind, isAbortError, normalizeUnknownError } from '../errors.js';
import { providerFetch, providerGet, trimTrailingSlash } from '../http.js';
import {
  createMediaRenderer,
  parseDataUrl,
  resolveImageOutput,
  sourceUrl,
  type MediaRenderer,
} from '../media.js';
import { irToChatMessages, type ChatMessage } from '../messages.js';
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
 * OpenAI Chat Completions 兼容适配器。
 * 目标不止官方端点：DeepSeek、OpenRouter、Ollama、LM Studio、各类中转站都走这里，
 * 差异全部收敛到 quirks。
 */

export const OPENAI_CHAT_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
/** 末尾不是 user 且模型不支持 prefill 时补的占位 */
const OPENAI_LAST_USER_FALLBACK = '[Continue]';

/** 按 baseUrl 推断 quirks 默认值；用户可用 `conn.quirks` 覆盖 */
export function detectQuirks(baseUrl: string): Record<string, boolean> {
  let host = '';
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    host = baseUrl.toLowerCase();
  }

  if (host === 'api.openai.com' || host.endsWith('.openai.com')) {
    return {
      developerRole: true,
      streamUsage: true,
      reasoningEffort: true,
      reasoningContent: false,
      prefill: false,
    };
  }
  if (host === 'api.z.ai' || host.endsWith('.z.ai') || host.includes('bigmodel')) {
    // Z.AI / 智谱 GLM：流式 delta 带 reasoning_content，无 developer 角色；
    // 推理控制（2026-09-14 实测 glm-5.3-flash）：认 reasoning_effort，也认 thinking:{type:enabled|disabled}
    return {
      developerRole: false,
      streamUsage: true,
      reasoningEffort: true,
      thinkingToggle: true,
      reasoningContent: true,
      prefill: true,
    };
  }
  if (host.includes('deepseek')) {
    return {
      developerRole: false,
      streamUsage: true,
      reasoningEffort: false,
      reasoningContent: true,
      prefill: true,
    };
  }
  // 其他端点：只默认打开 include_usage，其余交给实测/用户
  return { streamUsage: true };
}

function resolveQuirks(conn: Connection): Record<string, boolean> {
  return { ...detectQuirks(conn.baseUrl), ...conn.quirks };
}

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  /** PDF：`file_data` 是 data URL（官方 Chat Completions 的 file content part） */
  | { type: 'file'; file: { filename: string; file_data: string } };

interface OpenAiMessage {
  role: string;
  content: string | OpenAiContentPart[];
  /** 说话人名：ST `names_behavior: COMPLETION` 与示例对话（example_user / example_assistant） */
  name?: string;
}

/**
 * 渲染一条消息的 content。图片 / PDF 只能出现在 user 消息里
 * （system / developer / assistant 的 content 只接受文本），其他角色里的媒体丢弃并告警。
 * 没有媒体块时退化为纯字符串（多段文本用 `\n` 连接）。
 */
function renderParts(
  parts: readonly Part[],
  role: ChatMessage['role'],
  media: MediaRenderer,
  warnings: string[],
): string | OpenAiContentPart[] {
  const out: OpenAiContentPart[] = [];
  let hasNonText = false;
  const roleCtx = { accepts: role === 'user', role };
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        out.push({ type: 'text', text: part.text });
        break;
      case 'image':
      case 'document': {
        const rendered = media.render(part, roleCtx);
        if (!rendered) break;
        if (rendered.kind === 'text') {
          out.push({ type: 'text', text: rendered.text });
        } else if (rendered.kind === 'image') {
          hasNonText = true;
          out.push({ type: 'image_url', image_url: { url: sourceUrl(rendered.source) } });
        } else {
          hasNonText = true;
          out.push({
            type: 'file',
            file: { filename: rendered.filename, file_data: sourceUrl(rendered.source) },
          });
        }
        break;
      }
      case 'reasoning_opaque':
        warnings.push('OpenAI Chat 端点无法回传推理块，已丢弃');
        break;
    }
  }
  if (!hasNonText) {
    return out.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  }
  return out;
}

function mapRole(msg: ChatMessage, quirks: Record<string, boolean>): string {
  if (msg.role === 'system' && quirks.developerRole) return 'developer';
  return msg.role;
}

interface OpenAiBody {
  model: string;
  messages: OpenAiMessage[];
  stream: true;
  [k: string]: unknown;
}

function buildRequest(
  ir: PromptIR,
  conn: Connection,
  model: string,
  opts?: BuildOptions,
): ProviderRequest {
  const warnings: string[] = [];
  const quirks = resolveQuirks(conn);
  const caps = capabilities(model, conn);

  // strict 布局默认不合并相邻同角色（ST 从不合并）；`Segment.name` 默认带到 `name` 字段
  const flat = irToChatMessages(ir, { systemPlacement: 'inline' });
  const messages = [...flat.messages];
  // 支持 prefill 的端点（DeepSeek 等）保留末尾 assistant 段；不支持的补一条 user
  const tail = messages[messages.length - 1];
  if (caps.prefill === false && tail?.role !== 'user') {
    if (tail?.role === 'assistant') {
      warnings.push('该模型不支持 assistant prefill，已在末尾补一条 user 消息');
    }
    messages.push({
      role: 'user',
      parts: [{ type: 'text', text: OPENAI_LAST_USER_FALLBACK }],
      segmentIds: [],
    });
  }

  const media = createMediaRenderer({
    resolveAsset: opts?.resolveAsset,
    label: 'OpenAI Chat',
    warnings,
  });
  const rendered: OpenAiMessage[] = messages.map((msg) => ({
    role: mapRole(msg, quirks),
    content: renderParts(msg.parts, msg.role, media, warnings),
    ...(msg.name === undefined ? {} : { name: msg.name }),
  }));
  media.flush();

  const s = ir.sampling;
  const body: OpenAiBody = {
    model,
    messages: rendered,
    stream: true,
    max_tokens: s.maxTokens ?? defaultMaxTokens(caps),
  };
  if (s.temperature !== undefined) body.temperature = s.temperature;
  if (s.topP !== undefined) body.top_p = s.topP;
  if (s.frequencyPenalty !== undefined) body.frequency_penalty = s.frequencyPenalty;
  if (s.presencePenalty !== undefined) body.presence_penalty = s.presencePenalty;
  if (s.seed !== undefined) body.seed = s.seed;
  if (s.stop && s.stop.length > 0) body.stop = s.stop;
  if (s.topK !== undefined) warnings.push('OpenAI Chat 不支持 top_k，已丢弃');
  if (s.minP !== undefined) warnings.push('OpenAI Chat 不支持 min_p，已丢弃');
  if (s.repetitionPenalty !== undefined)
    warnings.push('OpenAI Chat 不支持 repetition_penalty，已丢弃');

  if (quirks.streamUsage !== false) body.stream_options = { include_usage: true };

  // 生图：OpenRouter 形态 `modalities: ['image','text']`，缺省在 caps.imageOut 时开
  if (resolveImageOutput(opts, caps, caps.imageOut, model, warnings)) {
    body.modalities = ['image', 'text'];
  }

  // 推理控制：会话覆盖 > IR 扩展 > 预设 reasoning_effort（见 thinking.ts）
  const resolved = resolveThinking(ir, opts);
  const thinkingOpt: ThinkingOptions = resolved.stEffort
    ? {
        effort: quirks.claudeCodeThinking
          ? resolved.stEffort === 'min'
            ? 'low'
            : resolved.stEffort
          : stEffortToOpenAI(resolved.stEffort, model),
      }
    : resolved.thinking;
  const sendsEffort = caps.thinking === 'effort' && quirks.reasoningEffort !== false;
  if (thinkingOpt.enabled === false) {
    if (!canDisableThinking(caps)) {
      if (caps.thinking !== 'none') warnings.push(`模型 ${model} 不支持关闭推理，已按默认处理`);
    } else if (quirks.thinkingToggle) {
      // Z.AI GLM 等：`thinking:{type:'disabled'}` 开关
      body.thinking = { type: 'disabled' };
    } else if (sendsEffort && (caps.effortLevels ?? []).includes('none')) {
      body.reasoning_effort = 'none';
    } else {
      warnings.push(`端点没有可用的关闭推理参数（thinkingToggle / effort=none），已按默认处理`);
    }
  } else if (thinkingOpt.effort !== undefined) {
    const effort = thinkingOpt.effort;
    if (sendsEffort) {
      body.reasoning_effort = effort;
      if (caps.effortLevels && !caps.effortLevels.includes(effort)) {
        warnings.push(`effort=${effort} 不在 ${model} 的已知档位内，仍按原样发送`);
      }
    } else if (caps.thinking !== 'effort') {
      warnings.push(`模型 ${model} 不支持 reasoning_effort，已丢弃 effort=${effort}`);
    } else {
      warnings.push(`连接的 reasoningEffort quirk 已关闭，已丢弃 effort=${effort}`);
    }
  }
  if (thinkingOpt.budgetTokens !== undefined && thinkingOpt.enabled !== false) {
    if (quirks.claudeCodeThinking && caps.thinking === 'budget') {
      body.thinking = { type: 'enabled', budget_tokens: thinkingOpt.budgetTokens };
    } else {
      warnings.push('OpenAI Chat 用 reasoning_effort 档位控制推理，budgetTokens 已丢弃');
    }
  } else if (quirks.claudeCodeThinking && thinkingOpt.enabled === true) {
    body.thinking = { type: 'enabled' };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(conn.apiKey ? { authorization: `Bearer ${conn.apiKey}` } : {}),
    ...conn.headers,
  };

  return {
    method: 'POST',
    url: `${trimTrailingSlash(conn.baseUrl)}/chat/completions`,
    headers,
    body,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function capabilities(model: string, conn: Connection): ModelCapabilities {
  const caps = lookupCapabilities('openai-chat', model, conn.modelOverrides?.[model]);
  const quirks = resolveQuirks(conn);
  // quirks 显式声明时压过目录
  if (typeof conn.quirks?.prefill === 'boolean') caps.prefill = conn.quirks.prefill;
  else if (typeof quirks.prefill === 'boolean') caps.prefill = quirks.prefill;
  return caps;
}

function normalizeError(e: unknown): ProviderError {
  const err = normalizeUnknownError(e);
  // OpenAI 的 400 常把上下文超限写在 code 里
  const detail = err.detail as { error?: { code?: unknown } } | undefined;
  const code = detail?.error?.code;
  if (typeof code === 'string') {
    const kind = errorTypeToKind(code);
    if (kind) return { ...err, kind, retryable: kind === 'rateLimit' || kind === 'overloaded' };
  }
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
    throw normalizeErrorAsError(e);
  }
}

/** listModels 需要抛异常；把 ProviderError 包成 Error 以便 throw */
function normalizeErrorAsError(e: unknown): Error & { providerError: ProviderError } {
  const pe = normalizeError(e);
  const err = new Error(pe.message) as Error & { providerError: ProviderError };
  err.name = 'ProviderErrorException';
  err.providerError = pe;
  return err;
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

function toUsageEvent(u: OpenAiUsage): Extract<GenEvent, { type: 'usage' }> {
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = u.prompt_tokens ?? 0;
  return {
    type: 'usage',
    // OpenAI 的 prompt_tokens 含缓存命中，减去后 input + cacheRead + cacheWrite = 总输入
    input: Math.max(0, prompt - cacheRead),
    output: u.completion_tokens ?? 0,
    cacheRead,
    cacheWrite: 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

function mapFinishReason(reason: string | null | undefined): Extract<GenEvent, { type: 'stop' }> {
  switch (reason) {
    case 'length':
      return { type: 'stop', reason: 'length' };
    case 'content_filter':
      return { type: 'stop', reason: 'filter' };
    case 'tool_calls':
    case 'function_call':
      return { type: 'stop', reason: 'tool' };
    case 'stop':
    default:
      return { type: 'stop', reason: 'end', ...(reason ? { detail: reason } : {}) };
  }
}

/** 生图元素的 URL：`{ type:'image_url', image_url:{ url } }`，兼容 `image_url` 直接是字符串 / 顶层 `url` */
function imageUrlOf(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const item = raw as { image_url?: unknown; url?: unknown };
  if (typeof item.image_url === 'string') return item.image_url;
  if (typeof item.image_url === 'object' && item.image_url !== null) {
    const url = (item.image_url as { url?: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return typeof item.url === 'string' ? item.url : undefined;
}

/**
 * OpenRouter 形态的图片数组 → 事件。
 * data URL → `image`；http(s) 链接 `image` 事件表达不了（服务端要落盘 base64），
 * 告警并把链接作为 Markdown 图片文本输出。
 */
function imageEvents(images: readonly unknown[], sawText: boolean): GenEvent[] {
  const out: GenEvent[] = [];
  let needGap = sawText;
  for (const raw of images) {
    const url = imageUrlOf(raw);
    if (url === undefined || url === '') continue;
    const parsed = parseDataUrl(url);
    if (parsed) {
      out.push({ type: 'image', mime: parsed.mime, data: parsed.base64 });
    } else if (/^https?:\/\//i.test(url)) {
      out.push({
        type: 'warning',
        message: `模型返回的是图片链接而不是内联数据，已作为 Markdown 图片文本输出：${url}`,
      });
      out.push({ type: 'text.delta', text: `${needGap ? '\n\n' : ''}![image](${url})` });
      needGap = true;
    } else {
      out.push({ type: 'warning', message: '模型返回了无法识别的图片地址，已忽略' });
    }
  }
  return out;
}

async function* stream(
  conn: Connection,
  req: ProviderRequest,
  signal: AbortSignal,
): AsyncGenerator<GenEvent, void, undefined> {
  let usage: Extract<GenEvent, { type: 'usage' }> | undefined;
  let stopEvent: Extract<GenEvent, { type: 'stop' }> | undefined;
  /** 已输出过正文：http 图片链接降级成 Markdown 时要先空一行 */
  let sawText = false;

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

      // 有的中转站把错误塞进流里
      if (chunk.error) {
        const pe = normalizeError(new Error(JSON.stringify(chunk.error)));
        yield { type: 'error', error: pe, retryable: pe.retryable };
        return;
      }

      if (chunk.usage) usage = toUsageEvent(chunk.usage as OpenAiUsage);

      const choices = chunk.choices;
      if (!Array.isArray(choices)) continue;
      for (const raw of choices) {
        const choice = raw as {
          delta?: Record<string, unknown>;
          message?: Record<string, unknown>;
          finish_reason?: string | null;
        };
        const delta = choice.delta ?? choice.message;
        if (delta) {
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === 'string' && reasoning !== '') {
            yield { type: 'reasoning.delta', text: reasoning };
          }
          const content = delta.content;
          if (typeof content === 'string' && content !== '') {
            sawText = true;
            yield { type: 'text.delta', text: content };
          } else if (Array.isArray(content)) {
            for (const c of content) {
              const block = c as { type?: string; text?: unknown };
              if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
                sawText = true;
                yield { type: 'text.delta', text: block.text };
              }
            }
          }
          // OpenRouter 生图：流式 `delta.images[]`、非流式 `message.images[]`
          if (Array.isArray(delta.images)) {
            for (const ev of imageEvents(delta.images, sawText)) {
              if (ev.type === 'text.delta') sawText = true;
              yield ev;
            }
          }
          const toolCalls = delta.tool_calls;
          if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
              const call = tc as {
                id?: string;
                function?: { name?: string; arguments?: string };
              };
              yield {
                type: 'tool.call',
                id: call.id ?? '',
                name: call.function?.name ?? '',
                argsDelta: call.function?.arguments ?? '',
              };
            }
          }
        }
        if (choice.finish_reason) stopEvent = mapFinishReason(choice.finish_reason);
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
  yield stopEvent ?? { type: 'stop', reason: 'end' };
}

export const openaiChatAdapter: ProviderAdapter = {
  id: 'openai-chat',
  listModels,
  capabilities,
  buildRequest,
  stream,
  normalizeError,
};
