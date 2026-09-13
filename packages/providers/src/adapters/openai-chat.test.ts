import type { Part, PromptIR, Role, Segment } from '@newtavern/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '../http.js';
import type { Connection, GenEvent } from '../types.js';
import { detectQuirks, openaiChatAdapter } from './openai-chat.js';

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
  provider: 'openai-chat',
  baseUrl: 'https://api.openai.com/v1/',
  apiKey: 'sk-test',
};

function sseResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function drain(it: AsyncIterable<GenEvent>): Promise<GenEvent[]> {
  const out: GenEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detectQuirks', () => {
  it('api.openai.com：developer 角色 / include_usage / reasoning_effort', () => {
    expect(detectQuirks('https://api.openai.com/v1')).toEqual({
      developerRole: true,
      streamUsage: true,
      reasoningEffort: true,
      reasoningContent: false,
      prefill: false,
    });
  });

  it('deepseek：reasoning_content', () => {
    expect(detectQuirks('https://api.deepseek.com')).toMatchObject({
      reasoningContent: true,
      developerRole: false,
      prefill: true,
    });
  });

  it('api.z.ai：reasoning_content 且无 developer 角色', () => {
    expect(detectQuirks('https://api.z.ai/api/coding/paas/v4')).toMatchObject({
      reasoningContent: true,
      streamUsage: true,
      developerRole: false,
      reasoningEffort: false,
    });
  });

  it('未知端点只默认 include_usage', () => {
    expect(detectQuirks('http://localhost:11434/v1')).toEqual({ streamUsage: true });
  });

  it('非法 URL 不抛异常', () => {
    expect(() => detectQuirks('not a url')).not.toThrow();
  });
});

describe('openai-chat buildRequest', () => {
  it('system→developer、图片占位、采样与 stream_options', () => {
    const ir = makeIr([
      text('s1', 'system', 'SYS', 'system'),
      text('h1', 'user', 'hello'),
      text('h2', 'assistant', 'hi'),
      seg('h3', 'user', [
        { type: 'text', text: 'look' },
        { type: 'image', assetId: 'a1', mime: 'image/png' },
      ]),
    ]);
    const req = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5');

    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer sk-test',
    });
    expect(req.body).toEqual({
      model: 'gpt-5',
      stream: true,
      max_tokens: 4096,
      temperature: 0.8,
      top_p: 0.95,
      stream_options: { include_usage: true },
      messages: [
        { role: 'developer', content: 'SYS' },
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image_url', image_url: { url: 'asset:a1' } },
          ],
        },
      ],
    });
    expect(req.warnings).toEqual([
      '图片 a1 以 asset: 占位 URL 渲染，需由服务端替换为 data URL',
      'OpenAI Chat 不支持 top_k，已丢弃',
    ]);
  });

  it('是纯函数：同一 IR 两次调用结果 deep-equal 且不改动 IR', () => {
    const ir = makeIr([text('s1', 'system', 'SYS', 'system'), text('h1', 'user', 'hi')]);
    const snapshot = JSON.stringify(ir);
    const a = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5');
    const b = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5');
    expect(a).toEqual(b);
    expect(JSON.stringify(ir)).toBe(snapshot);
  });

  it('末尾不是 user 时补 [Continue]', () => {
    const ir = makeIr([text('h1', 'user', 'hi'), text('h2', 'assistant', 'prefill')]);
    // gpt-5 的 prefill=false → 末段 assistant 先被 ensureLastUser 之后仍是 user 结尾
    const body = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5').body as {
      messages: { role: string; content: unknown }[];
    };
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body.messages[2]?.content).toBe('[Continue]');
  });

  it('reasoning_effort 仅在能力为 effort 且 quirk 未关时写入', () => {
    const ir = makeIr([text('h1', 'user', 'hi')]);
    const withEffort = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5', {
      thinking: { effort: 'high' },
    }).body as Record<string, unknown>;
    expect(withEffort.reasoning_effort).toBe('high');

    const noEffort = openaiChatAdapter.buildRequest(ir, conn, 'gpt-4o', {
      thinking: { effort: 'high' },
    });
    expect((noEffort.body as Record<string, unknown>).reasoning_effort).toBeUndefined();
    expect(noEffort.warnings?.some((w) => w.includes('reasoning_effort'))).toBe(true);

    const quirkOff = openaiChatAdapter.buildRequest(
      ir,
      { ...conn, quirks: { reasoningEffort: false } },
      'gpt-5',
      { thinking: { effort: 'high' } },
    );
    expect((quirkOff.body as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('effort 也可从 ir.sampling.thinking 读取', () => {
    const ir = makeIr([text('h1', 'user', 'hi')]);
    (ir.sampling as Record<string, unknown>).thinking = { effort: 'low' };
    const body = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5').body as Record<string, unknown>;
    expect(body.reasoning_effort).toBe('low');
  });

  it('streamUsage quirk 关闭时不带 stream_options', () => {
    const ir = makeIr([text('h1', 'user', 'hi')]);
    const body = openaiChatAdapter.buildRequest(
      ir,
      { ...conn, quirks: { streamUsage: false } },
      'gpt-5',
    ).body as Record<string, unknown>;
    expect(body.stream_options).toBeUndefined();
  });

  it('非 openai 端点保留 system 角色', () => {
    const ir = makeIr([text('s1', 'system', 'SYS', 'system'), text('h1', 'user', 'hi')]);
    const body = openaiChatAdapter.buildRequest(
      ir,
      { ...conn, baseUrl: 'https://api.deepseek.com' },
      'deepseek-chat',
    ).body as { messages: { role: string }[] };
    expect(body.messages[0]?.role).toBe('system');
  });

  it('支持 prefill 的端点保留末尾 assistant 段', () => {
    const ir = makeIr([text('h1', 'user', 'hi'), text('h2', 'assistant', '好的，')]);
    const body = openaiChatAdapter.buildRequest(
      ir,
      { ...conn, baseUrl: 'https://api.deepseek.com' },
      'deepseek-chat',
    ).body as { messages: { role: string }[] };
    expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

describe('openai-chat stream', () => {
  const req = { method: 'POST' as const, url: 'https://x/chat/completions', headers: {}, body: {} };

  it('回放 SSE：reasoning → text → usage → stop', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"思考"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}',
      '',
      'data: {"choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"length"}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":8,"prompt_tokens_details":{"cached_tokens":20},"completion_tokens_details":{"reasoning_tokens":3}}}',
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(sse))),
    );

    const events = await drain(openaiChatAdapter.stream(conn, req, new AbortController().signal));
    expect(events).toEqual([
      { type: 'reasoning.delta', text: '思考' },
      { type: 'text.delta', text: 'Hello' },
      { type: 'text.delta', text: ' world' },
      { type: 'usage', input: 100, output: 8, cacheRead: 20, cacheWrite: 0, reasoning: 3 },
      { type: 'stop', reason: 'length' },
    ]);
    // input + cacheRead + cacheWrite = prompt_tokens
    const usage = events[3] as Extract<GenEvent, { type: 'usage' }>;
    expect(usage.input + usage.cacheRead + usage.cacheWrite).toBe(120);
  });

  it('没有 usage 与 finish_reason 时也以 stop 收尾', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(sseResponse('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')),
      ),
    );
    const events = await drain(openaiChatAdapter.stream(conn, req, new AbortController().signal));
    expect(events).toEqual([
      { type: 'text.delta', text: 'a' },
      { type: 'stop', reason: 'end' },
    ]);
  });

  it('HTTP 错误归一化为 error 事件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'nope', type: 'invalid_api_key' } }), {
            status: 401,
          }),
        ),
      ),
    );
    const events = await drain(openaiChatAdapter.stream(conn, req, new AbortController().signal));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      retryable: false,
      error: { kind: 'auth', message: 'nope', status: 401 },
    });
  });

  it('流内嵌错误对象也归一化', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(sseResponse('data: {"error":{"message":"boom","type":"api_error"}}\n\n')),
      ),
    );
    const events = await drain(openaiChatAdapter.stream(conn, req, new AbortController().signal));
    expect(events[0]?.type).toBe('error');
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
    const events = await drain(openaiChatAdapter.stream(conn, req, ctrl.signal));
    expect(events).toEqual([{ type: 'stop', reason: 'abort' }]);
  });
});

describe('openai-chat listModels / normalizeError / capabilities', () => {
  it('listModels 解析 /models', async () => {
    const fetchMock = vi.fn((..._args: unknown[]) =>
      Promise.resolve(
        new Response(
          JSON.stringify({ data: [{ id: 'gpt-5' }, { id: 'gpt-4o', context_length: 128000 }, {}] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(openaiChatAdapter.listModels(conn)).resolves.toEqual([
      { id: 'gpt-5' },
      { id: 'gpt-4o', contextLength: 128000 },
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
    await expect(openaiChatAdapter.listModels(conn)).rejects.toMatchObject({
      providerError: { kind: 'auth', status: 403 },
    });
  });

  it('normalizeError：429 → rateLimit、500 → overloaded、context 超限 → contextLength', () => {
    expect(
      openaiChatAdapter.normalizeError(
        new HttpError(429, '{"error":{"message":"slow down","type":"rate_limit_error"}}'),
      ),
    ).toMatchObject({ kind: 'rateLimit', retryable: true, message: 'slow down' });

    expect(openaiChatAdapter.normalizeError(new HttpError(500, 'oops'))).toMatchObject({
      kind: 'overloaded',
      retryable: true,
    });

    expect(
      openaiChatAdapter.normalizeError(
        new HttpError(
          400,
          '{"error":{"message":"This model\'s maximum context length is 128000 tokens","code":"context_length_exceeded"}}',
        ),
      ),
    ).toMatchObject({ kind: 'contextLength', retryable: false });

    expect(openaiChatAdapter.normalizeError(new TypeError('fetch failed'))).toMatchObject({
      kind: 'network',
      retryable: true,
    });
  });

  it('capabilities 受 quirks.prefill 影响', () => {
    expect(openaiChatAdapter.capabilities('gpt-4o', conn).prefill).toBe(false);
    expect(
      openaiChatAdapter.capabilities('gpt-4o', { ...conn, quirks: { prefill: true } }).prefill,
    ).toBe(true);
  });
});
