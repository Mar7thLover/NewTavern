import type { PromptIR } from '@newtavern/core';
import {
  applyTextResponseFormat,
  applyTextToolProtocol,
  collectStream,
  createToolCallTextFilter,
  extractFirstJson,
  irHasToolParts,
  parseTextToolCalls,
  type CollectedResult,
  type FallbackLang,
  type GenEvent,
} from '@newtavern/providers';

import { schema, type Db } from '../db/client.js';
import { createAssetsService, type AssetsService } from './assets.js';
import { createAssetResolver } from './media.js';
import { buildProviderRequest, type ThinkingOptions } from './provider-request.js';
import {
  createProviderService,
  type ProviderService,
  type ResolvedConnection,
} from './providers.js';
import { createSecrets } from './secrets.js';

/**
 * 服务端一次性 LLM 调用（M6 契约 §1.5）：AI 协作者、写作、立绘分类、前端卡 generate tools 共用。
 *
 * 流程：解析连接 + 解密 Key + 能力 → 必要时套 §1.3 文本降级（工具 / 结构化输出）
 * → buildProviderRequest → collectStream（降级时再 parseTextToolCalls / 抽 JSON）→ 写 generation_log。
 * 不写消息树、不碰世界书时间态与变量；IR 由调用方直接构造。
 */

export interface LlmCallInput {
  connectionId: string;
  model: string;
  ir: PromptIR;
  thinking?: ThinkingOptions;
  signal?: AbortSignal;
  /** 需要流式转发时（AI 协作者、写作） */
  onEvent?: (e: GenEvent) => void;
  /** 降级协议说明的语言；缺省按 IR 正文是否含中日韩字符推断 */
  lang?: FallbackLang;
}

interface LlmServices {
  providers: ProviderService;
  assets: AssetsService;
}

/**
 * 每个库实例复用同一组服务：Key 轮换计数器在 ProviderService 里（进程内），
 * 每次调用都新建会让多 Key 连接永远只用第一个。
 */
const servicesByDb = new WeakMap<Db, LlmServices>();

function servicesFor(db: Db, dataDir: string): LlmServices {
  let services = servicesByDb.get(db);
  if (!services) {
    services = {
      providers: createProviderService(db, createSecrets(dataDir)),
      assets: createAssetsService(db, dataDir),
    };
    servicesByDb.set(db, services);
  }
  return services;
}

const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/;

function detectLang(ir: PromptIR): FallbackLang {
  for (const seg of ir.segments) {
    for (const part of seg.parts) {
      if (part.type === 'text' && CJK_RE.test(part.text)) return 'zh-CN';
    }
  }
  return 'en';
}

/** 首事件就是鉴权 / 限流错误、且连接有多个 Key 时换下一个 Key 重试一次（同 chats 的生成路径） */
function shouldRetryWithNextKey(result: CollectedResult, sawOutput: boolean): boolean {
  const kind = result.error?.kind;
  return !sawOutput && (kind === 'auth' || kind === 'rateLimit');
}

/**
 * 核心实现：`emit` 收到转发给调用方的事件（降级时 text.delta 已滤掉 ```tool_call 代码块，
 * 解析出的调用在流末以 tool.call 补发，stop 随后发出）。
 */
async function runLlm(
  db: Db,
  dataDir: string,
  input: LlmCallInput,
  emit: (e: GenEvent) => void,
): Promise<CollectedResult> {
  const { providers, assets } = servicesFor(db, dataDir);
  const startedAt = Date.now();
  let resolved: ResolvedConnection = await providers.resolveConnection(input.connectionId);
  const { model } = input;
  const caps = resolved.adapter.capabilities(model, resolved.conn);
  const lang = input.lang ?? detectLang(input.ir);

  // 1. 降级：模型不支持原生工具 / 结构化输出时改写 IR
  let ir = input.ir;
  const hasTools = (ir.tools ?? []).length > 0;
  const toolFallback = !caps.tools && (hasTools || irHasToolParts(ir));
  if (toolFallback) ir = applyTextToolProtocol(ir, lang);
  const formatFallback = ir.responseFormat !== undefined && !caps.structuredOutput;
  if (formatFallback) ir = applyTextResponseFormat(ir, lang);
  const fallbackWarnings = [
    ...(toolFallback && hasTools ? [`模型 ${model} 不支持原生工具调用，已改用文本协议`] : []),
    ...(formatFallback ? [`模型 ${model} 不支持结构化输出，已改用文本说明并抽取 JSON`] : []),
  ];

  const resolveAsset = createAssetResolver(assets, ir);
  const signal = input.signal ?? new AbortController().signal;

  // 2. 请求 + 收集；首事件鉴权 / 限流错误换 Key 重试一次
  const maxAttempts = resolved.keyCount > 1 ? 2 : 1;
  let result: CollectedResult | undefined;
  let request = buildProviderRequest(resolved.adapter, ir, resolved.conn, model, input.thinking, {
    resolveAsset,
  });
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      resolved = await providers.resolveConnection(input.connectionId);
      request = buildProviderRequest(resolved.adapter, ir, resolved.conn, model, input.thinking, {
        resolveAsset,
      });
    }
    const filter = toolFallback ? createToolCallTextFilter() : undefined;
    let sawOutput = false;
    /** 可重试的首个错误先扣下，确定不重试再发 */
    const held: GenEvent[] = [];
    const retryPossible = attempt + 1 < maxAttempts;
    result = await collectStream(resolved.adapter, resolved.conn, request, signal, (ev) => {
      if (ev.type === 'error' && !sawOutput && retryPossible) {
        held.push(ev);
        return;
      }
      if (ev.type !== 'usage' && ev.type !== 'warning') sawOutput = true;
      if (ev.type === 'text.delta' && filter) {
        const text = filter.push(ev.text);
        if (text !== '') emit({ type: 'text.delta', text });
        return;
      }
      // 降级时 stop 要等解析完工具调用再发
      if (ev.type === 'stop' && toolFallback) return;
      emit(ev);
    });
    if (retryPossible && shouldRetryWithNextKey(result, sawOutput)) continue;
    for (const ev of held) emit(ev);
    if (filter) {
      const tail = filter.flush();
      if (tail !== '') emit({ type: 'text.delta', text: tail });
    }
    break;
  }
  if (!result) throw new Error('LLM 调用没有结果');

  // 3. 降级结果还原
  result = { ...result, warnings: [...fallbackWarnings, ...result.warnings] };
  if (toolFallback) {
    const parsed = parseTextToolCalls(result.text);
    const toolCalls = [...result.toolCalls, ...parsed.toolCalls];
    let stop = result.stop;
    if (parsed.toolCalls.length > 0 && (stop.reason === 'end' || stop.reason === 'length')) {
      stop = { reason: 'tool' };
    }
    for (const call of parsed.toolCalls) {
      emit({ type: 'tool.call', id: call.id, name: call.name, argsDelta: call.args });
    }
    emit({ type: 'stop', reason: stop.reason, ...(stop.detail ? { detail: stop.detail } : {}) });
    result = { ...result, text: parsed.rest, toolCalls, stop };
  }
  if (formatFallback) {
    const found = extractFirstJson(result.text);
    if (found) result = { ...result, text: found.json };
    else result = { ...result, warnings: [...result.warnings, '回复里没有找到 JSON'] };
  }

  // 4. generation_log（不挂节点）
  db.insert(schema.generationLog)
    .values({
      nodeId: null,
      provider: resolved.conn.provider,
      model,
      usage: result.usage ?? undefined,
      latencyMs: Date.now() - startedAt,
      layoutMode: input.ir.meta.layoutMode,
    })
    .run();

  return result;
}

/** 解析连接 + 解密 Key + 能力 → 必要时套 §1.3 降级 → buildProviderRequest → collectStream（降级时再 parseTextToolCalls）。
 *  写 generation_log（nodeId 为空，layoutMode 取 ir.meta.layoutMode）。
 *  连接不存在 / 适配器未注册时抛 ProviderServiceError；上游错误不抛，放在 `result.error`。 */
export async function callLlm(
  db: Db,
  dataDir: string,
  input: LlmCallInput,
): Promise<CollectedResult> {
  const onEvent = input.onEvent;
  return runLlm(db, dataDir, input, (e) => {
    if (!onEvent) return;
    try {
      onEvent(e);
    } catch {
      // 转发方的异常不影响调用
    }
  });
}

/** 同上但返回事件流（写作续写要边收边推）。连接解析失败时迭代抛出 ProviderServiceError。 */
export function streamLlm(db: Db, dataDir: string, input: LlmCallInput): AsyncIterable<GenEvent> {
  return {
    [Symbol.asyncIterator]: () => {
      const queue: GenEvent[] = [];
      let done = false;
      let failure: unknown;
      let wake: (() => void) | null = null;
      const notify = () => {
        const w = wake;
        wake = null;
        w?.();
      };
      // 消费方提前退出（break / return）时中止上游请求
      const ac = new AbortController();
      const outer = input.signal;
      if (outer?.aborted) ac.abort();
      else outer?.addEventListener('abort', () => ac.abort(), { once: true });
      const run = runLlm(db, dataDir, { ...input, signal: ac.signal }, (e) => {
        queue.push(e);
        try {
          input.onEvent?.(e);
        } catch {
          // 同 callLlm
        }
        notify();
      }).then(
        () => {
          done = true;
          notify();
        },
        (e: unknown) => {
          failure = e;
          done = true;
          notify();
        },
      );
      void run;
      return {
        async next(): Promise<IteratorResult<GenEvent>> {
          for (;;) {
            const ev = queue.shift();
            if (ev) return { value: ev, done: false };
            if (done) {
              if (failure !== undefined) {
                const err = failure;
                failure = undefined;
                throw err;
              }
              return { value: undefined, done: true };
            }
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
        return(): Promise<IteratorResult<GenEvent>> {
          if (!done) ac.abort();
          queue.length = 0;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
