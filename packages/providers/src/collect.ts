import type {
  Connection,
  GenEvent,
  ProviderAdapter,
  ProviderError,
  ProviderRequest,
} from './types.js';

/**
 * 把适配器的事件流收成一次性结果（M6 契约 §1.4）。
 * AI 协作者、写作、立绘分类、前端卡 generate 等「要整段结果」的调用方共用；
 * 需要边收边推时传 `onEvent`，事件原样转发（结构化输出的模拟工具调用转成 text.delta）。
 */

export interface CollectedToolCall {
  id: string;
  name: string;
  /** 参数 JSON 字符串（各片段按到达顺序拼接；空参数记为 `{}`） */
  args: string;
  /** args 解析成功时的值 */
  parsed?: unknown;
  /** args 不是合法 JSON 时的错误信息 */
  parseError?: string;
}

export interface CollectedResult {
  text: string;
  reasoning: string;
  opaque: { provider: string; model: string; payload: unknown }[];
  images: { mime: string; data: string }[];
  toolCalls: CollectedToolCall[];
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
  stop: { reason: 'end' | 'length' | 'refusal' | 'filter' | 'tool' | 'abort'; detail?: string };
  warnings: string[];
  error?: ProviderError;
}

/** 解析工具参数：填 parsed 或 parseError */
export function finalizeToolCall(call: {
  id: string;
  name: string;
  args: string;
}): CollectedToolCall {
  const args = call.args.trim() === '' ? '{}' : call.args;
  try {
    return { id: call.id, name: call.name, args, parsed: JSON.parse(args) as unknown };
  } catch (e) {
    return { id: call.id, name: call.name, args, parseError: (e as Error).message };
  }
}

export async function collectStream(
  adapter: ProviderAdapter,
  conn: Connection,
  req: ProviderRequest,
  signal: AbortSignal,
  onEvent?: (e: GenEvent) => void,
): Promise<CollectedResult> {
  const structuredTool = req.structuredOutputTool;
  let text = '';
  let reasoning = '';
  const opaque: CollectedResult['opaque'] = [];
  const images: CollectedResult['images'] = [];
  /** 按首次出现的顺序；同一 id 的片段拼到一起 */
  const calls = new Map<string, { id: string; name: string; args: string }>();
  /** 结构化输出模拟工具的参数（还原为正文） */
  let structured: string | undefined;
  let usage: CollectedResult['usage'];
  let stop: CollectedResult['stop'] | undefined;
  const warnings: string[] = [...(req.warnings ?? [])];
  let error: ProviderError | undefined;

  const emit = (e: GenEvent) => {
    if (!onEvent) return;
    try {
      onEvent(e);
    } catch {
      // 转发方的异常不影响收集
    }
  };

  try {
    for await (const ev of adapter.stream(conn, req, signal)) {
      switch (ev.type) {
        case 'text.delta':
          text += ev.text;
          emit(ev);
          break;
        case 'reasoning.delta':
          reasoning += ev.text;
          emit(ev);
          break;
        case 'reasoning.opaque':
          opaque.push({ provider: ev.provider, model: ev.model, payload: ev.payload });
          emit(ev);
          break;
        case 'image':
          images.push({ mime: ev.mime, data: ev.data });
          emit(ev);
          break;
        case 'warning':
          warnings.push(ev.message);
          emit(ev);
          break;
        case 'tool.call': {
          if (structuredTool !== undefined && ev.name === structuredTool) {
            structured = (structured ?? '') + ev.argsDelta;
            if (ev.argsDelta !== '') emit({ type: 'text.delta', text: ev.argsDelta });
            break;
          }
          const existing = calls.get(ev.id);
          if (existing) {
            existing.args += ev.argsDelta;
            if (existing.name === '' && ev.name !== '') existing.name = ev.name;
          } else {
            calls.set(ev.id, { id: ev.id, name: ev.name, args: ev.argsDelta });
          }
          emit(ev);
          break;
        }
        case 'usage':
          usage = {
            input: ev.input,
            output: ev.output,
            cacheRead: ev.cacheRead,
            cacheWrite: ev.cacheWrite,
            reasoning: ev.reasoning,
          };
          emit(ev);
          break;
        case 'stop':
          stop = { reason: ev.reason, ...(ev.detail === undefined ? {} : { detail: ev.detail }) };
          emit(ev);
          break;
        case 'error':
          error = ev.error;
          emit(ev);
          break;
      }
    }
  } catch (e) {
    // 适配器约定不抛异常（错误走 error 事件）；万一抛了，按同样的形状收进来
    if (!signal.aborted) {
      error = adapter.normalizeError(e);
      emit({ type: 'error', error, retryable: error.retryable });
    }
  }

  const toolCalls = [...calls.values()].map(finalizeToolCall);
  if (structured !== undefined) {
    // 模拟工具的参数就是结构化结果；模型在它之前说的话不是 JSON，丢弃
    text = structured.trim() === '' ? '{}' : structured;
    if (stop?.reason === 'tool' && toolCalls.length === 0) stop = { reason: 'end' };
  }
  if (!stop) {
    stop = signal.aborted
      ? { reason: 'abort' }
      : error
        ? { reason: 'end', detail: 'error' }
        : { reason: toolCalls.length > 0 ? 'tool' : 'end' };
  }

  return {
    text,
    reasoning,
    opaque,
    images,
    toolCalls,
    ...(usage ? { usage } : {}),
    stop,
    warnings,
    ...(error ? { error } : {}),
  };
}
