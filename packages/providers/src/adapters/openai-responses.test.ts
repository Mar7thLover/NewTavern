import type { Part, PromptIR, Role, Segment } from '@newtavern/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '../http.js';
import type { Connection, GenEvent } from '../types.js';
import { openaiResponsesAdapter } from './openai-responses.js';

function seg(
  id: string,
  role: Role,
  parts: Part[],
  slot: 'system' | 'history' = 'history',
): Segment {
  return {
    id,
    role,
    parts,
    origin: { kind: slot === 'system' ? 'preset' : 'history' },
    anchor: { slot, order: 0 },
    stability: slot === 'system' ? 'static' : 'history',
  };
}

function text(id: string, role: Role, t: string, slot: 'system' | 'history' = 'history'): Segment {
  return seg(id, role, [{ type: 'text', text: t }], slot);
}

function makeIr(segments: Segment[], extra: Partial<PromptIR> = {}): PromptIR {
  return {
    model: 'gpt-5',
    sampling: { temperature: 0.8, topP: 0.95, topK: 40, maxTokens: undefined },
    segments,
    cachePlan: { breakpoints: [] },
    meta: {
      chatId: 'chat-1',
      presetId: 'preset-1',
      layoutMode: 'strict',
      activations: [],
      warnings: [],
      tokenEstimate: 0,
    },
    ...extra,
  };
}

const conn: Connection = {
  id: 'c1',
  provider: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1/',
  apiKey: 'sk-test',
};

function sseResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

/** Responses 的 SSE：`event:` 名与 data.type 一致 */
function sse(events: { type: string; [k: string]: unknown }[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n') + '\n';
}

async function drain(it: AsyncIterable<GenEvent>): Promise<GenEvent[]> {
  const out: GenEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('openai-responses buildRequest', () => {
  it('instructions 抽取、input_text/output_text、store/include/prompt_cache_key、图片占位', () => {
    const ir = makeIr([
      text('s1', 'system', 'SYS1', 'system'),
      text('s2', 'system', 'SYS2', 'system'),
      text('h1', 'user', 'hello'),
      text('h2', 'assistant', 'hi'),
      seg('h3', 'user', [
        { type: 'text', text: 'look' },
        { type: 'image', assetId: 'a1', mime: 'image/png' },
      ]),
    ]);
    // gpt-4.1 在 openai-responses 目录里 thinking='none'，采样参数照常带上
    const req = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-4.1');

    expect(req.url).toBe('https://api.openai.com/v1/responses');
    expect(req.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    });
    expect(req.body).toEqual({
      model: 'gpt-4.1',
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
      max_output_tokens: 4096,
      instructions: 'SYS1\n\nSYS2',
      prompt_cache_key: 'chat-1',
      temperature: 0.8,
      top_p: 0.95,
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'asset:a1' },
          ],
        },
      ],
    });
    expect(req.warnings).toEqual([
      '图片 a1 以 asset: 占位 URL 渲染，需由服务端替换为 data URL',
      'Responses 不支持 top_k，已丢弃',
    ]);
  });

  it('中途 system 段降级为 developer 角色', () => {
    const ir = makeIr([
      text('s1', 'system', 'SYS', 'system'),
      text('h1', 'user', 'hi'),
      text('h2', 'system', 'depth note'),
      text('h3', 'user', 'again'),
    ]);
    const body = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-4.1').body as {
      instructions: string;
      input: { role: string; content: { type: string }[] }[];
    };
    expect(body.instructions).toBe('SYS');
    expect(body.input.map((i) => i.role)).toEqual(['user', 'developer', 'user']);
    // developer 同样用 input_text
    expect(body.input[1]?.content[0]?.type).toBe('input_text');
  });

  it('没有 system 段时不带 instructions', () => {
    const ir = makeIr([text('h1', 'user', 'hi')]);
    const body = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-4.1').body as Record<
      string,
      unknown
    >;
    expect(body.instructions).toBeUndefined();
  });

  it('推理模型：reasoning 参数写入且丢弃 temperature/top_p', () => {
    const ir = makeIr([text('h1', 'user', 'hi')]);
    const req = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-5');
    const body = req.body as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.max_output_tokens).toBe(4096);
    expect(req.warnings).toEqual([
      '推理模型 gpt-5 不接受 temperature/top_p，已丢弃',
      'Responses 不支持 top_k，已丢弃',
    ]);
  });

  it('effort 来自 opts / ir.sampling.thinking，opts 优先', () => {
    const ir = makeIr([text('h1', 'user', 'hi')]);
    (ir.sampling as Record<string, unknown>).thinking = { effort: 'low' };
    const fromIr = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-5').body as Record<
      string,
      unknown
    >;
    expect(fromIr.reasoning).toEqual({ effort: 'low', summary: 'auto' });

    const fromOpts = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-5', {
      thinking: { effort: 'high' },
    }).body as Record<string, unknown>;
    expect(fromOpts.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('非法 / 不在档位内的 effort 回退 medium 并 warning', () => {
    const ir = makeIr([text('h1', 'user', 'hi')]);
    const bogus = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-5', {
      thinking: { effort: 'ultra' },
    });
    expect((bogus.body as Record<string, unknown>).reasoning).toEqual({
      effort: 'medium',
      summary: 'auto',
    });
    expect(bogus.warnings).toContain('effort=ultra 不是合法档位，已回退 medium');

    // xhigh 是合法档位，但 gpt-5 的 effortLevels 里没有
    const notAllowed = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-5', {
      thinking: { effort: 'xhigh' },
    });
    expect((notAllowed.body as Record<string, unknown>).reasoning).toEqual({
      effort: 'medium',
      summary: 'auto',
    });
    expect(notAllowed.warnings).toContain('effort=xhigh 不在 gpt-5 的可用档位内，已回退 medium');
  });

  it('非推理模型给了 effort 时丢弃并 warning', () => {
    const ir = makeIr([text('h1', 'user', 'hi')]);
    const req = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-4.1', {
      thinking: { effort: 'high' },
    });
    expect((req.body as Record<string, unknown>).reasoning).toBeUndefined();
    expect(req.warnings).toContain('模型 gpt-4.1 不支持推理参数，thinking 配置已丢弃');
  });

  it('历史加密推理项作为独立 input 项放在对应 assistant 之前', () => {
    const payload = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'ENC',
      summary: [{ type: 'summary_text', text: '思考' }],
    };
    const ir = makeIr([
      text('h1', 'user', 'q'),
      seg('h2', 'assistant', [
        { type: 'reasoning_opaque', provider: 'openai-responses', model: 'gpt-5', payload },
        { type: 'text', text: 'a' },
      ]),
      text('h3', 'user', 'q2'),
    ]);
    const body = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-5').body as {
      input: Record<string, unknown>[];
    };
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
      payload,
      { role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
      { role: 'user', content: [{ type: 'input_text', text: 'q2' }] },
    ]);
  });

  it('缺 summary 的推理项补成空数组；模型不符的推理项丢弃', () => {
    const ir = makeIr([
      text('h1', 'user', 'q'),
      seg('h2', 'assistant', [
        {
          type: 'reasoning_opaque',
          provider: 'openai-responses',
          model: 'gpt-5',
          payload: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' },
        },
        { type: 'reasoning_opaque', provider: 'anthropic', model: 'claude-opus-5', payload: {} },
        { type: 'text', text: 'a' },
      ]),
      text('h3', 'user', 'q2'),
    ]);
    const req = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-5');
    const body = req.body as { input: Record<string, unknown>[] };
    expect(body.input[1]).toEqual({
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'ENC',
      summary: [],
    });
    expect(req.warnings).toContain('推理块来自 anthropic/claude-opus-5，与当前模型不符，已丢弃');
  });

  it('文档 part 以 input_file 占位并 warning', () => {
    const ir = makeIr([
      seg('h1', 'user', [{ type: 'document', assetId: 'd1', mime: 'application/pdf' }]),
    ]);
    const req = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-4.1');
    const body = req.body as { input: { content: unknown[] }[] };
    expect(body.input[0]?.content).toEqual([{ type: 'input_file', file_id: 'asset:d1' }]);
    expect(req.warnings).toContain('文档 d1 以 asset: 占位 file_id 渲染，需由服务端上传后替换');
  });

  it('末尾是 assistant 时补一条 user 占位', () => {
    const ir = makeIr([text('h1', 'user', 'hi'), text('h2', 'assistant', '好的，')]);
    const req = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-4.1');
    const body = req.body as { input: { role: string; content: { text: string }[] }[] };
    expect(body.input.map((i) => i.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.input[2]?.content[0]?.text).toBe('[Continue]');
    expect(req.warnings).toContain('Responses 不支持 assistant prefill，已在末尾补一条 user 消息');
  });

  it('不支持的采样参数逐条 warning', () => {
    const ir = makeIr([text('h1', 'user', 'hi')], {
      sampling: {
        maxTokens: 1000,
        stop: ['END'],
        seed: 7,
        minP: 0.1,
        frequencyPenalty: 0.2,
        presencePenalty: 0.3,
        repetitionPenalty: 1.1,
      },
    });
    const req = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-4.1');
    expect((req.body as Record<string, unknown>).max_output_tokens).toBe(1000);
    expect(req.warnings).toEqual([
      'Responses 不支持 stop 序列，已丢弃',
      'Responses 不支持 seed，已丢弃',
      'Responses 不支持 min_p，已丢弃',
      'Responses 不支持 frequency_penalty，已丢弃',
      'Responses 不支持 presence_penalty，已丢弃',
      'Responses 不支持 repetition_penalty，已丢弃',
    ]);
  });

  it('是纯函数：同一 IR 两次调用结果 deep-equal 且不改动 IR', () => {
    const ir = makeIr([
      text('s1', 'system', 'SYS', 'system'),
      text('h1', 'user', 'hi'),
      seg('h2', 'assistant', [
        {
          type: 'reasoning_opaque',
          provider: 'openai-responses',
          model: 'gpt-5',
          payload: { type: 'reasoning', id: 'rs_1' },
        },
        { type: 'text', text: 'a' },
      ]),
      text('h3', 'user', 'again'),
    ]);
    const snapshot = JSON.stringify(ir);
    const a = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-5');
    const b = openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-5');
    expect(a).toEqual(b);
    expect(JSON.stringify(ir)).toBe(snapshot);
  });
});

describe('openai-responses stream', () => {
  const req = {
    method: 'POST' as const,
    url: 'https://api.openai.com/v1/responses',
    headers: {},
    body: { model: 'gpt-5' },
  };

  it('回放 SSE：reasoning summary → reasoning 项 → 文本 → usage → stop', async () => {
    const reasoningItem = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'ENC',
      summary: [{ type: 'summary_text', text: '思考' }],
    };
    const body = sse([
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } },
      { type: 'response.reasoning_summary_text.delta', delta: '思' },
      { type: 'response.reasoning_summary_text.delta', delta: '考' },
      { type: 'response.output_item.done', item: reasoningItem },
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ' world' },
      {
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 20 },
            output_tokens: 8,
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(body))),
    );

    const events = await drain(
      openaiResponsesAdapter.stream(conn, req, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: 'reasoning.delta', text: '思' },
      { type: 'reasoning.delta', text: '考' },
      {
        type: 'reasoning.opaque',
        provider: 'openai-responses',
        model: 'gpt-5',
        payload: reasoningItem,
      },
      { type: 'text.delta', text: 'Hello' },
      { type: 'text.delta', text: ' world' },
      { type: 'usage', input: 100, output: 8, cacheRead: 20, cacheWrite: 0, reasoning: 3 },
      { type: 'stop', reason: 'end' },
    ]);
    const usage = events[5] as Extract<GenEvent, { type: 'usage' }>;
    expect(usage.input + usage.cacheRead + usage.cacheWrite).toBe(120);
  });

  it('response.incomplete(max_output_tokens) → usage + stop:length', async () => {
    const body = sse([
      { type: 'response.output_text.delta', delta: 'abc' },
      {
        type: 'response.incomplete',
        response: {
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 50, output_tokens: 4096 },
        },
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(body))),
    );
    const events = await drain(
      openaiResponsesAdapter.stream(conn, req, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: 'text.delta', text: 'abc' },
      { type: 'usage', input: 50, output: 4096, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      { type: 'stop', reason: 'length' },
    ]);
  });

  it('response.incomplete(content_filter) → stop:filter', async () => {
    const body = sse([
      {
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'content_filter' } },
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(body))),
    );
    const events = await drain(
      openaiResponsesAdapter.stream(conn, req, new AbortController().signal),
    );
    expect(events).toEqual([{ type: 'stop', reason: 'filter' }]);
  });

  it('response.failed → error 事件', async () => {
    const body = sse([
      {
        type: 'response.failed',
        response: { error: { code: 'rate_limit_error', message: '太快了' } },
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(body))),
    );
    const events = await drain(
      openaiResponsesAdapter.stream(conn, req, new AbortController().signal),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      retryable: true,
      error: { kind: 'rateLimit', message: '太快了' },
    });
  });

  it('error 事件 → error', async () => {
    const body = sse([{ type: 'error', code: 'invalid_api_key', message: 'bad key' }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(body))),
    );
    const events = await drain(
      openaiResponsesAdapter.stream(conn, req, new AbortController().signal),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'auth', message: 'bad key' } });
  });

  it('refusal → stop:refusal，文本放 detail', async () => {
    const body = sse([
      { type: 'response.refusal.delta', delta: '抱歉，' },
      { type: 'response.refusal.delta', delta: '不能帮你。' },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 2 } } },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(body))),
    );
    const events = await drain(
      openaiResponsesAdapter.stream(conn, req, new AbortController().signal),
    );
    expect(events[events.length - 1]).toEqual({
      type: 'stop',
      reason: 'refusal',
      detail: '抱歉，不能帮你。',
    });
  });

  it('image_generation_call 输出项映射为 image 事件', async () => {
    const body = sse([
      {
        type: 'response.output_item.done',
        item: { type: 'image_generation_call', id: 'ig_1', result: 'BASE64PNG' },
      },
      { type: 'response.completed', response: {} },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(body))),
    );
    const events = await drain(
      openaiResponsesAdapter.stream(conn, req, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: 'image', mime: 'image/png', data: 'BASE64PNG' },
      { type: 'stop', reason: 'end' },
    ]);
  });

  it('没有任何终止事件时也以 stop:end 收尾', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse(
            'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"a"}\n\n',
          ),
        ),
      ),
    );
    const events = await drain(
      openaiResponsesAdapter.stream(conn, req, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: 'text.delta', text: 'a' },
      { type: 'stop', reason: 'end' },
    ]);
  });

  it('HTTP 401 归一化为 error kind auth', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              error: { message: 'nope', type: 'invalid_request_error', code: 'invalid_api_key' },
            }),
            { status: 401 },
          ),
        ),
      ),
    );
    const events = await drain(
      openaiResponsesAdapter.stream(conn, req, new AbortController().signal),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      retryable: false,
      error: { kind: 'auth', message: 'nope', status: 401 },
    });
  });

  it('abort 时 yield stop:abort', async () => {
    const ctrl = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        ctrl.abort();
        const e = new Error('aborted');
        e.name = 'AbortError';
        return Promise.reject(e);
      }),
    );
    const events = await drain(openaiResponsesAdapter.stream(conn, req, ctrl.signal));
    expect(events).toEqual([{ type: 'stop', reason: 'abort' }]);
  });
});

describe('openai-responses listModels / normalizeError / capabilities', () => {
  it('listModels 解析 GET /models', async () => {
    const fetchMock = vi.fn((..._args: unknown[]) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'o3', context_length: 200000 }, {}] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(openaiResponsesAdapter.listModels(conn)).resolves.toEqual([
      { id: 'gpt-5' },
      { id: 'o3', contextLength: 200000 },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/models');
  });

  it('listModels 失败时抛出带 providerError 的异常', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(new Response('{"error":{"message":"bad key"}}', { status: 403 })),
      ),
    );
    await expect(openaiResponsesAdapter.listModels(conn)).rejects.toMatchObject({
      providerError: { kind: 'auth', status: 403 },
    });
  });

  it('normalizeError：429 → rateLimit、500 → overloaded、context 超限 → contextLength', () => {
    expect(
      openaiResponsesAdapter.normalizeError(
        new HttpError(429, '{"error":{"message":"slow down","type":"rate_limit_error"}}'),
      ),
    ).toMatchObject({ kind: 'rateLimit', retryable: true, message: 'slow down' });

    expect(openaiResponsesAdapter.normalizeError(new HttpError(500, 'oops'))).toMatchObject({
      kind: 'overloaded',
      retryable: true,
    });

    expect(
      openaiResponsesAdapter.normalizeError(
        new HttpError(
          400,
          '{"error":{"message":"too long","code":"context_length_exceeded","type":"invalid_request_error"}}',
        ),
      ),
    ).toMatchObject({ kind: 'contextLength', retryable: false });

    expect(openaiResponsesAdapter.normalizeError(new TypeError('fetch failed'))).toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });

  it('capabilities 走 openai-responses 目录，modelOverrides 优先', () => {
    const caps = openaiResponsesAdapter.capabilities('gpt-5', conn);
    expect(caps.thinking).toBe('effort');
    expect(caps.reasoningRoundtrip).toBe('encrypted');
    expect(caps.prefill).toBe(false);

    const overridden = openaiResponsesAdapter.capabilities('gpt-5', {
      ...conn,
      modelOverrides: { 'gpt-5': { maxOutput: 1024 } },
    });
    expect(overridden.maxOutput).toBe(1024);
  });
});
