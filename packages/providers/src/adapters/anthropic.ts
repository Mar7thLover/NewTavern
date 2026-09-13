import type { Part, PromptIR } from '@newtavern/core';

import { defaultMaxTokens, globMatch, lookupCapabilities } from '../catalog.js';
import { errorTypeToKind, isAbortError, normalizeUnknownError } from '../errors.js';
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
  ProviderRequest,
} from '../types.js';

/**
 * Anthropic Messages 适配器。
 * 要点：system 抽到顶层 system[]；cache_control 断点 ≤ maxBreakpoints；
 * thinking 块签名原样回传；4.6+ 无 prefill；同角色合并、首末消息约束。
 */

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';

/** 开头必须是 user 时的占位（沿用 ST 的做法） */
const START_PLACEHOLDER = '[Start]';
const CONTINUE_PLACEHOLDER = '[Continue]';
const INSTRUCTION_PREFIX = '[Instruction]';

/**
 * 这些模型已移除 temperature / top_p / top_k（传了直接 400）。
 * `ModelCapabilities` 目前没有表达"采样参数是否可用"的字段，先在适配器内按 glob 兜底，
 * 待契约 §5 协调后改为目录字段。
 */
const NO_SAMPLING_PATTERNS = [
  'claude-fable-5*',
  'claude-mythos-5*',
  'claude-opus-5*',
  'claude-opus-4-8*',
  'claude-opus-4-7*',
  'claude-sonnet-5*',
];

function rejectsSamplingParams(model: string): boolean {
  return NO_SAMPLING_PATTERNS.some((p) => globMatch(p, model));
}

type AnthropicBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'image'; source: { type: 'url'; url: string } }
  | { type: 'document'; source: { type: 'url'; url: string } }
  | Record<string, unknown>;

interface CacheControl {
  type: 'ephemeral';
  ttl?: '1h';
}

interface AnthropicMessage {
  role: string;
  content: AnthropicBlock[];
}

function renderParts(parts: readonly Part[], model: string, warnings: string[]): AnthropicBlock[] {
  const head: AnthropicBlock[] = [];
  const body: AnthropicBlock[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        body.push({ type: 'text', text: part.text });
        break;
      case 'image':
        // assetId 占位，由服务端在 M4 替换为 base64 / 可访问 URL
        body.push({ type: 'image', source: { type: 'url', url: `asset:${part.assetId}` } });
        warnings.push(`图片 ${part.assetId} 以 asset: 占位 URL 渲染，需由服务端替换为图片源`);
        break;
      case 'document':
        body.push({ type: 'document', source: { type: 'url', url: `asset:${part.assetId}` } });
        warnings.push(`文档 ${part.assetId} 以 asset: 占位 URL 渲染，需由服务端替换为文档源`);
        break;
      case 'reasoning_opaque':
        // 历史里的 thinking / redacted_thinking 块必须原样、且放在 assistant content 开头
        if (part.provider !== 'anthropic' || part.model !== model) {
          warnings.push(`推理块来自 ${part.provider}/${part.model}，与当前模型不符，已丢弃`);
          break;
        }
        if (typeof part.payload === 'object' && part.payload !== null) {
          head.push(part.payload as Record<string, unknown>);
        }
        break;
    }
  }
  return [...head, ...body];
}

function lastTextIndex(blocks: readonly AnthropicBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if ((blocks[i] as { type?: string }).type === 'text') return i;
  }
  return blocks.length - 1;
}

function applyCacheControl(blocks: AnthropicBlock[], cc: CacheControl): boolean {
  const idx = lastTextIndex(blocks);
  const block = blocks[idx];
  if (!block) return false;
  (block as Record<string, unknown>).cache_control = cc;
  return true;
}

/** 把 system 消息按 Anthropic 的约束降级：只有"末条"或"后面接 assistant"才能保留 role:'system' */
function normalizeSystemRoles(messages: ChatMessage[], systemInMessages: boolean): ChatMessage[] {
  return messages.map((msg, i) => {
    if (msg.role !== 'system') return msg;
    const next = messages[i + 1];
    const ok = systemInMessages && (next === undefined || next.role === 'assistant');
    return ok ? msg : { ...msg, role: 'user' as const };
  });
}

function irThinking(ir: PromptIR): { effort?: string; budgetTokens?: number } {
  const ext = (ir.sampling as Record<string, unknown>).thinking;
  if (typeof ext !== 'object' || ext === null) return {};
  const obj = ext as { effort?: unknown; budgetTokens?: unknown };
  return {
    ...(typeof obj.effort === 'string' ? { effort: obj.effort } : {}),
    ...(typeof obj.budgetTokens === 'number' ? { budgetTokens: obj.budgetTokens } : {}),
  };
}

interface AnthropicBody {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
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
  const caps = capabilities(model, conn);
  const ttl: CacheControl =
    ir.cachePlan?.ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

  const { systemBlocks, messages } = irToChatMessages(ir, {
    systemPlacement: 'top',
    mergeSameRole: true,
  });

  let working = [...messages];

  // 1. prefill：末段是 assistant 而模型不支持 prefill 时降级为 depth-0 指令
  const lastIdx = working.length - 1;
  const last = working[lastIdx];
  if (last && last.role === 'assistant' && !caps.prefill) {
    if (caps.systemInMessages) {
      working[lastIdx] = { ...last, role: 'system' };
      warnings.push('该模型不支持 assistant prefill，末段已转为 messages 内的 system 指令');
    } else {
      working[lastIdx] = {
        ...last,
        role: 'user',
        parts: last.parts.map((p) =>
          p.type === 'text' ? { type: 'text', text: `${INSTRUCTION_PREFIX}\n${p.text}` } : p,
        ),
      };
      warnings.push(
        `该模型不支持 assistant prefill，末段已转为 user 并用 ${INSTRUCTION_PREFIX} 包裹`,
      );
    }
  }

  // 2. system 消息降级 + 再次合并同角色
  working = mergeAdjacentSameRole(normalizeSystemRoles(working, caps.systemInMessages));

  // 3. 首条必须是 user
  if (working.length === 0) {
    working = [
      { role: 'user', parts: [{ type: 'text', text: CONTINUE_PLACEHOLDER }], segmentIds: [] },
    ];
  } else if (working[0]?.role !== 'user') {
    working.unshift({
      role: 'user',
      parts: [{ type: 'text', text: START_PLACEHOLDER }],
      segmentIds: [],
    });
  }

  // 4. 末尾必须是 user（assistant prefill 与末位 system 指令是合法例外）
  const tail = working[working.length - 1];
  if (tail && tail.role === 'assistant' && !caps.prefill) {
    working.push({
      role: 'user',
      parts: [{ type: 'text', text: CONTINUE_PLACEHOLDER }],
      segmentIds: [],
    });
  }

  const renderedSystem: AnthropicBlock[][] = systemBlocks.map((b) =>
    renderParts(b.parts, model, warnings),
  );
  const renderedMessages: AnthropicMessage[] = working.map((msg) => ({
    role: msg.role,
    content: renderParts(msg.parts, model, warnings),
  }));

  // 5. 缓存断点：system 在前、messages 在后，靠前优先，数量 ≤ maxBreakpoints
  if (caps.caching === 'breakpoints') {
    const maxBp = caps.maxBreakpoints ?? 4;
    let used = 0;
    for (const [i, block] of systemBlocks.entries()) {
      if (!block.cacheBreakpoint) continue;
      if (used >= maxBp) {
        warnings.push(`缓存断点超过 ${maxBp} 个，已忽略靠后的断点`);
        break;
      }
      const blocks = renderedSystem[i];
      if (blocks && applyCacheControl(blocks, ttl)) used += 1;
    }
    for (const [i, msg] of working.entries()) {
      if (!msg.cacheBreakpoint) continue;
      if (used >= maxBp) {
        warnings.push(`缓存断点超过 ${maxBp} 个，已忽略靠后的断点`);
        break;
      }
      const rendered = renderedMessages[i];
      if (rendered && applyCacheControl(rendered.content, ttl)) used += 1;
    }
  }

  const systemFlat = renderedSystem.flat();

  const s = ir.sampling;
  const body: AnthropicBody = {
    model,
    max_tokens: s.maxTokens ?? defaultMaxTokens(caps),
    messages: renderedMessages,
    stream: true,
  };
  if (systemFlat.length > 0) body.system = systemFlat;

  // 6. thinking
  const thinkingOpt = { ...irThinking(ir), ...opts?.thinking };
  let samplingLocked = false;
  if (caps.thinking === 'adaptive') {
    body.thinking = { type: 'adaptive' };
    if (thinkingOpt.effort !== undefined) {
      if (caps.effortLevels && !caps.effortLevels.includes(thinkingOpt.effort)) {
        warnings.push(`effort=${thinkingOpt.effort} 不在 ${model} 的已知档位内，仍按原样发送`);
      }
      body.output_config = { effort: thinkingOpt.effort };
    }
    if (thinkingOpt.budgetTokens !== undefined) {
      warnings.push('该模型使用 adaptive thinking，budget_tokens 已丢弃（传了会 400）');
    }
  } else if (caps.thinking === 'budget' && thinkingOpt.budgetTokens !== undefined) {
    const budget = Math.max(1024, thinkingOpt.budgetTokens);
    if (body.max_tokens <= budget) {
      body.max_tokens = Math.min(caps.maxOutput, budget + 1024);
      warnings.push(`max_tokens 必须大于 budget_tokens，已抬高到 ${body.max_tokens}`);
    }
    body.thinking = { type: 'enabled', budget_tokens: budget };
    samplingLocked = true;
  } else if (thinkingOpt.effort !== undefined || thinkingOpt.budgetTokens !== undefined) {
    warnings.push(`模型 ${model} 不支持推理参数，thinking 配置已丢弃`);
  }

  // 7. 采样参数
  const noSampling = rejectsSamplingParams(model);
  if (samplingLocked) {
    body.temperature = 1;
    if (s.temperature !== undefined && s.temperature !== 1)
      warnings.push('开启 budget thinking 时 temperature 必须为 1，已覆盖');
    if (s.topP !== undefined) warnings.push('开启 budget thinking 时不能传 top_p，已丢弃');
    if (s.topK !== undefined) warnings.push('开启 budget thinking 时不能传 top_k，已丢弃');
  } else if (noSampling) {
    if (s.temperature !== undefined || s.topP !== undefined || s.topK !== undefined)
      warnings.push(`模型 ${model} 已移除 temperature/top_p/top_k，采样参数全部丢弃`);
  } else {
    if (s.temperature !== undefined) body.temperature = s.temperature;
    if (s.topP !== undefined) body.top_p = s.topP;
    if (s.topK !== undefined) body.top_k = s.topK;
  }
  if (s.stop && s.stop.length > 0) body.stop_sequences = s.stop;
  if (s.minP !== undefined) warnings.push('Anthropic 不支持 min_p，已丢弃');
  if (s.frequencyPenalty !== undefined) warnings.push('Anthropic 不支持 frequency_penalty，已丢弃');
  if (s.presencePenalty !== undefined) warnings.push('Anthropic 不支持 presence_penalty，已丢弃');
  if (s.repetitionPenalty !== undefined)
    warnings.push('Anthropic 不支持 repetition_penalty，已丢弃');
  if (s.seed !== undefined) warnings.push('Anthropic 不支持 seed，已丢弃');

  return {
    method: 'POST',
    url: `${trimTrailingSlash(conn.baseUrl)}/v1/messages`,
    headers: anthropicHeaders(conn),
    body,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

function anthropicHeaders(conn: Connection): Record<string, string> {
  return {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    ...(conn.apiKey ? { 'x-api-key': conn.apiKey } : {}),
    ...conn.headers,
  };
}

function capabilities(model: string, conn: Connection): ModelCapabilities {
  return lookupCapabilities('anthropic', model, conn.modelOverrides?.[model]);
}

function normalizeError(e: unknown): ProviderError {
  const err = normalizeUnknownError(e);
  const detail = err.detail as { error?: { type?: unknown } } | undefined;
  const type = detail?.error?.type;
  if (typeof type === 'string') {
    const kind = errorTypeToKind(type);
    if (kind) return { ...err, kind, retryable: kind === 'rateLimit' || kind === 'overloaded' };
  }
  if (err.status === 529) return { ...err, kind: 'overloaded', retryable: true };
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
    const json = await providerGet(
      conn,
      `${trimTrailingSlash(conn.baseUrl)}/v1/models?limit=1000`,
      anthropicHeaders(conn),
    );
    const data = (json as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    return data
      .map((m): ModelInfo | null => {
        const row = m as Record<string, unknown>;
        const id = typeof row.id === 'string' ? row.id : null;
        if (!id) return null;
        const caps = lookupCapabilities('anthropic', id);
        return {
          id,
          ...(typeof row.display_name === 'string' ? { name: row.display_name } : {}),
          contextLength: caps.maxContext,
          maxOutput: caps.maxOutput,
        };
      })
      .filter((m): m is ModelInfo => m !== null);
  } catch (e) {
    throw toProviderException(e);
  }
}

async function countTokens(conn: Connection, req: ProviderRequest): Promise<number> {
  const body = { ...(req.body as Record<string, unknown>) };
  delete body.stream;
  delete body.max_tokens;
  delete body.output_config;
  const res = await providerFetch(conn, {
    method: 'POST',
    url: `${trimTrailingSlash(conn.baseUrl)}/v1/messages/count_tokens`,
    headers: anthropicHeaders(conn),
    body,
  });
  const json = (await res.json()) as { input_tokens?: number };
  return json.input_tokens ?? 0;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function mapStopReason(reason: string | null | undefined): Extract<GenEvent, { type: 'stop' }> {
  switch (reason) {
    case 'max_tokens':
      return { type: 'stop', reason: 'length' };
    case 'refusal':
      return { type: 'stop', reason: 'refusal' };
    case 'tool_use':
      return { type: 'stop', reason: 'tool' };
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return { type: 'stop', reason: 'end', detail: reason };
    default:
      return { type: 'stop', reason: 'end', ...(reason ? { detail: reason } : {}) };
  }
}

interface BlockState {
  type: string;
  thinking: string;
  signature: string;
  data?: string;
}

async function* stream(
  conn: Connection,
  req: ProviderRequest,
  signal: AbortSignal,
): AsyncGenerator<GenEvent, void, undefined> {
  const model = (req.body as { model?: string }).model ?? '';
  const blocks = new Map<number, BlockState>();
  const usage: Required<AnthropicUsage> = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  let sawUsage = false;
  let stopEvent: Extract<GenEvent, { type: 'stop' }> | undefined;

  function absorbUsage(u: AnthropicUsage | undefined): void {
    if (!u) return;
    sawUsage = true;
    if (typeof u.input_tokens === 'number') usage.input_tokens = u.input_tokens;
    if (typeof u.output_tokens === 'number') usage.output_tokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === 'number')
      usage.cache_read_input_tokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === 'number')
      usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
  }

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
      const type = (typeof chunk.type === 'string' ? chunk.type : ev.event) ?? '';

      switch (type) {
        case 'message_start': {
          const message = chunk.message as { usage?: AnthropicUsage } | undefined;
          absorbUsage(message?.usage);
          break;
        }
        case 'content_block_start': {
          const index = chunk.index as number;
          const cb = (chunk.content_block ?? {}) as Record<string, unknown>;
          blocks.set(index, {
            type: typeof cb.type === 'string' ? cb.type : 'text',
            thinking: typeof cb.thinking === 'string' ? cb.thinking : '',
            signature: typeof cb.signature === 'string' ? cb.signature : '',
            ...(typeof cb.data === 'string' ? { data: cb.data } : {}),
          });
          break;
        }
        case 'content_block_delta': {
          const index = chunk.index as number;
          const delta = (chunk.delta ?? {}) as Record<string, unknown>;
          const state = blocks.get(index);
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            if (delta.text !== '') yield { type: 'text.delta', text: delta.text };
          } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            if (state) state.thinking += delta.thinking;
            if (delta.thinking !== '') yield { type: 'reasoning.delta', text: delta.thinking };
          } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
            if (state) state.signature += delta.signature;
          }
          break;
        }
        case 'content_block_stop': {
          const index = chunk.index as number;
          const state = blocks.get(index);
          blocks.delete(index);
          if (!state) break;
          if (state.type === 'thinking') {
            yield {
              type: 'reasoning.opaque',
              provider: 'anthropic',
              model,
              payload: {
                type: 'thinking',
                thinking: state.thinking,
                signature: state.signature,
              },
            };
          } else if (state.type === 'redacted_thinking') {
            yield {
              type: 'reasoning.opaque',
              provider: 'anthropic',
              model,
              payload: { type: 'redacted_thinking', data: state.data ?? '' },
            };
          }
          break;
        }
        case 'message_delta': {
          absorbUsage(chunk.usage as AnthropicUsage | undefined);
          const delta = (chunk.delta ?? {}) as { stop_reason?: string | null };
          if (delta.stop_reason) stopEvent = mapStopReason(delta.stop_reason);
          break;
        }
        case 'error': {
          const pe = normalizeError(new Error(JSON.stringify(chunk.error ?? chunk)));
          const errObj = chunk.error as { type?: string; message?: string } | undefined;
          const kind = errorTypeToKind(errObj?.type) ?? pe.kind;
          const final: ProviderError = {
            kind,
            message: errObj?.message ?? pe.message,
            retryable: kind === 'rateLimit' || kind === 'overloaded',
          };
          yield { type: 'error', error: final, retryable: final.retryable };
          return;
        }
        case 'message_stop':
        case 'ping':
        default:
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

  if (sawUsage) {
    yield {
      type: 'usage',
      // Anthropic 的 input_tokens 已排除缓存读写，直接相加即总输入
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      reasoning: 0,
    };
  }
  yield stopEvent ?? { type: 'stop', reason: 'end' };
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  listModels,
  capabilities,
  buildRequest,
  stream,
  countTokens,
  normalizeError,
};
