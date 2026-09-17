import type { Part, PromptIR, Role, Segment } from '@newtavern/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '../http.js';
import { PDF_DATA_URL, PNG_B64, PNG_DATA_URL, resolveAsset, TXT_CONTENT } from '../test-media.js';
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

  it('api.z.ai：reasoning_content、无 developer 角色、认 reasoning_effort 与 thinking 开关', () => {
    expect(detectQuirks('https://api.z.ai/api/coding/paas/v4')).toMatchObject({
      reasoningContent: true,
      streamUsage: true,
      developerRole: false,
      reasoningEffort: true,
      thinkingToggle: true,
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
    // 没有 resolver 就是预览：占位本身不告警
    expect(req.warnings).toEqual(['OpenAI Chat 不支持 top_k，已丢弃']);
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

  it('关闭推理：gpt-5 不可关，告警且不带 reasoning_effort；预设 min → minimal', () => {
    const ir = makeIr([text('h1', 'user', 'hi')]);
    const off = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5', { thinking: { enabled: false } });
    expect((off.body as Record<string, unknown>).reasoning_effort).toBeUndefined();
    expect(off.warnings).toContain('模型 gpt-5 不支持关闭推理，已按默认处理');

    const preset = makeIr([text('h1', 'user', 'hi')], { sampling: { reasoningEffort: 'min' } });
    const body = openaiChatAdapter.buildRequest(preset, conn, 'gpt-5').body as Record<
      string,
      unknown
    >;
    expect(body.reasoning_effort).toBe('minimal');
  });

  it('Z.AI GLM：关闭发 thinking:disabled，档位发 reasoning_effort，不设则两者都不带', () => {
    const zai: Connection = {
      id: 'z',
      provider: 'openai-chat',
      baseUrl: 'https://api.z.ai/api/coding/paas/v4',
      apiKey: 'k',
    };
    const ir = makeIr([text('h1', 'user', 'hi')]);
    const off = openaiChatAdapter.buildRequest(ir, zai, 'glm-5.3-flash', {
      thinking: { enabled: false },
    }).body as Record<string, unknown>;
    expect(off.thinking).toEqual({ type: 'disabled' });
    expect(off.reasoning_effort).toBeUndefined();

    const high = openaiChatAdapter.buildRequest(ir, zai, 'glm-5.3-flash', {
      thinking: { effort: 'high' },
    });
    expect((high.body as Record<string, unknown>).reasoning_effort).toBe('high');
    expect((high.body as Record<string, unknown>).thinking).toBeUndefined();
    expect(high.warnings ?? []).not.toContain(expect.stringContaining('effort'));

    const plain = openaiChatAdapter.buildRequest(ir, zai, 'glm-5.3-flash').body as Record<
      string,
      unknown
    >;
    expect(plain.thinking).toBeUndefined();
    expect(plain.reasoning_effort).toBeUndefined();

    // 预设 low：ST 原样发送 low（GLM 上等同不推理），不在已知档位内给提示
    const low = openaiChatAdapter.buildRequest(
      makeIr([text('h1', 'user', 'hi')], { sampling: { reasoningEffort: 'low' } }),
      zai,
      'glm-5.3-flash',
    );
    expect((low.body as Record<string, unknown>).reasoning_effort).toBe('low');
    expect(low.warnings).toContain('effort=low 不在 glm-5.3-flash 的已知档位内，仍按原样发送');
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

  it('Segment.name 写进消息的 name 字段，且带 name 的段不与他人合并（契约 §9 AS-8）', () => {
    const ir = makeIr([
      { ...text('e1', 'system', 'hi', 'system'), name: 'example_user' },
      { ...text('e2', 'system', 'yo', 'system'), name: 'example_assistant' },
      text('s1', 'system', 'SYS', 'system'),
      text('h1', 'user', 'hello'),
    ]);
    const body = openaiChatAdapter.buildRequest(
      ir,
      { ...conn, baseUrl: 'https://api.deepseek.com' },
      'deepseek-chat',
    ).body as { messages: { role: string; content: unknown; name?: string }[] };
    expect(body.messages).toEqual([
      { role: 'system', content: 'hi', name: 'example_user' },
      { role: 'system', content: 'yo', name: 'example_assistant' },
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('strict 默认不合并相邻同角色；cache-aware 默认合并', () => {
    const segments = [text('s1', 'system', 'A', 'system'), text('s2', 'system', 'B', 'system')];
    const strict = openaiChatAdapter.buildRequest(makeIr(segments), conn, 'gpt-5').body as {
      messages: { content: unknown }[];
    };
    expect(strict.messages.map((m) => m.content)).toEqual(['A', 'B', '[Continue]']);

    const cacheAware = openaiChatAdapter.buildRequest(
      makeIr(segments, { meta: { ...makeIr([]).meta, layoutMode: 'cache-aware' } }),
      conn,
      'gpt-5',
    ).body as { messages: { content: unknown }[] };
    expect(cacheAware.messages.map((m) => m.content)).toEqual(['A\n\nB', '[Continue]']);
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

describe('openai-chat 多模态', () => {
  const plainIr = (segments: Segment[]) => makeIr(segments, { sampling: {} });
  const openrouter: Connection = {
    id: 'or',
    provider: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'k',
  };
  const deepseek: Connection = { ...conn, baseUrl: 'https://api.deepseek.com' };
  const streamReq = {
    method: 'POST' as const,
    url: 'https://x/chat/completions',
    headers: {},
    body: {},
  };

  type Msg = { role: string; content: unknown };
  const messagesOf = (req: { body: unknown }) => (req.body as { messages: Msg[] }).messages;

  it('有 resolver：图片 → image_url data URL，PDF → file（filename + data URL），保持 parts 顺序', () => {
    const ir = plainIr([
      seg('h1', 'user', [
        { type: 'text', text: '看看' },
        { type: 'image', assetId: 'img1', mime: 'image/png' },
        { type: 'document', assetId: 'doc1', mime: 'application/pdf' },
        { type: 'text', text: '结尾' },
      ]),
    ]);
    const req = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5', { resolveAsset });
    expect(messagesOf(req)[0]?.content).toEqual([
      { type: 'text', text: '看看' },
      { type: 'image_url', image_url: { url: PNG_DATA_URL } },
      { type: 'file', file: { filename: '设定集.pdf', file_data: PDF_DATA_URL } },
      { type: 'text', text: '结尾' },
    ]);
    expect(req.warnings).toBeUndefined();
  });

  it('没有 resolver：image_url / file 用 asset: 占位，不告警；PDF 无文件名时用 <id>.pdf', () => {
    const ir = plainIr([
      seg('h1', 'user', [
        { type: 'image', assetId: 'img1', mime: 'image/png' },
        { type: 'document', assetId: 'doc9', mime: 'application/pdf' },
      ]),
    ]);
    const req = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5');
    expect(messagesOf(req)[0]?.content).toEqual([
      { type: 'image_url', image_url: { url: 'asset:img1' } },
      { type: 'file', file: { filename: 'doc9.pdf', file_data: 'asset:doc9' } },
    ]);
    expect(req.warnings).toBeUndefined();
  });

  it('imageIn=false：丢弃全部图片并汇总告警（有无 resolver 都一样）', () => {
    const ir = plainIr([
      seg('h1', 'user', [
        { type: 'text', text: '两张图' },
        { type: 'image', assetId: 'img1', mime: 'image/png' },
        { type: 'image', assetId: 'img2', mime: 'image/jpeg' },
      ]),
    ]);
    for (const opts of [{ resolveAsset }, undefined]) {
      const req = openaiChatAdapter.buildRequest(ir, deepseek, 'deepseek-chat', opts);
      expect(messagesOf(req)[0]?.content).toBe('两张图');
      expect(req.warnings).toEqual(['模型不支持图片输入，已丢弃 2 张图片']);
    }
  });

  it('documentIn=false：PDF 丢弃并告警（未登记模型默认不收 file part）', () => {
    const ir = plainIr([
      seg('h1', 'user', [
        { type: 'text', text: '读一下' },
        { type: 'document', assetId: 'doc1', mime: 'application/pdf' },
      ]),
    ]);
    const req = openaiChatAdapter.buildRequest(ir, openrouter, 'some/unknown-model', {
      resolveAsset,
    });
    expect(messagesOf(req)[0]?.content).toBe('读一下');
    expect(req.warnings).toEqual(['模型不支持 PDF 输入，已丢弃 1 个 PDF']);
  });

  it('assistant / system 消息里的图片丢弃并按角色告警（接口不接受）', () => {
    const ir = plainIr([
      seg(
        's1',
        'system',
        [
          { type: 'text', text: 'SYS' },
          { type: 'image', assetId: 'img1', mime: 'image/png' },
        ],
        'system',
      ),
      text('h1', 'user', '画一张'),
      seg('h2', 'assistant', [
        { type: 'text', text: '画好了' },
        { type: 'image', assetId: 'img1', mime: 'image/png' },
        { type: 'image', assetId: 'img2', mime: 'image/png' },
      ]),
      text('h3', 'user', '再来'),
    ]);
    const req = openaiChatAdapter.buildRequest(ir, deepseek, 'gpt-5', { resolveAsset });
    expect(messagesOf(req).map((m) => m.content)).toEqual(['SYS', '画一张', '画好了', '再来']);
    expect(req.warnings).toEqual([
      'OpenAI Chat 的 system 消息不接受图片 / PDF，已丢弃 1 个',
      'OpenAI Chat 的 assistant 消息不接受图片 / PDF，已丢弃 2 个',
    ]);
  });

  it('resolver 找不到资产：丢弃并告警', () => {
    const ir = plainIr([
      seg('h1', 'user', [
        { type: 'text', text: 'x' },
        { type: 'image', assetId: 'gone', mime: 'image/png' },
      ]),
    ]);
    const req = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5', { resolveAsset });
    expect(messagesOf(req)[0]?.content).toBe('x');
    expect(req.warnings).toEqual(['找不到资产 gone，已丢弃']);
  });

  it('文本类文档万一到达适配器：按 resolver 解码为文本块', () => {
    const ir = plainIr([
      seg('h1', 'user', [
        { type: 'document', assetId: 'txt1', mime: 'text/plain' },
        { type: 'text', text: '总结一下' },
      ]),
    ]);
    const req = openaiChatAdapter.buildRequest(ir, deepseek, 'deepseek-chat', { resolveAsset });
    expect(messagesOf(req)[0]?.content).toBe(`${TXT_CONTENT}\n总结一下`);
    expect(req.warnings).toBeUndefined();
  });

  it('imageOutput：缺省按 caps.imageOut，显式 true / false 覆盖', () => {
    const ir = plainIr([text('h1', 'user', '画一只猫')]);
    const imageModel = 'google/gemini-2.5-flash-image';
    const on = openaiChatAdapter.buildRequest(ir, openrouter, imageModel);
    expect((on.body as Record<string, unknown>).modalities).toEqual(['image', 'text']);

    const off = openaiChatAdapter.buildRequest(ir, openrouter, imageModel, { imageOutput: false });
    expect((off.body as Record<string, unknown>).modalities).toBeUndefined();

    const textModel = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5');
    expect((textModel.body as Record<string, unknown>).modalities).toBeUndefined();

    const forced = openaiChatAdapter.buildRequest(ir, conn, 'gpt-5', { imageOutput: true });
    expect((forced.body as Record<string, unknown>).modalities).toEqual(['image', 'text']);
    expect(forced.warnings).toContain('目录没有标注 gpt-5 支持图片输出，仍按请求开启');
  });

  it('回放 OpenRouter 流式 delta.images：data URL → image 事件，文本照常', async () => {
    const sse = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"给你画好了"}}]}',
      '',
      `data: {"choices":[{"index":0,"delta":{"content":"","images":[{"type":"image_url","image_url":{"url":"${PNG_DATA_URL}"}},{"type":"image_url","image_url":{"url":"data:image/webp;base64,UklGRg=="}}]},"finish_reason":"stop"}]}`,
      '',
      'data: [DONE]',
      '',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(sse))),
    );
    const events = await drain(
      openaiChatAdapter.stream(conn, streamReq, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: 'text.delta', text: '给你画好了' },
      { type: 'image', mime: 'image/png', data: PNG_B64 },
      { type: 'image', mime: 'image/webp', data: 'UklGRg==' },
      { type: 'stop', reason: 'end', detail: 'stop' },
    ]);
  });

  it('非流式 message.images 与 http 链接：链接告警并降级为 Markdown 图片文本', async () => {
    const sse = [
      `data: {"choices":[{"index":0,"message":{"role":"assistant","content":"两张","images":[{"type":"image_url","image_url":{"url":"${PNG_DATA_URL}"}},{"type":"image_url","image_url":{"url":"https://cdn.example.com/a.png"}}]},"finish_reason":"stop"}]}`,
      '',
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sseResponse(sse))),
    );
    const events = await drain(
      openaiChatAdapter.stream(conn, streamReq, new AbortController().signal),
    );
    expect(events).toEqual([
      { type: 'text.delta', text: '两张' },
      { type: 'image', mime: 'image/png', data: PNG_B64 },
      {
        type: 'warning',
        message:
          '模型返回的是图片链接而不是内联数据，已作为 Markdown 图片文本输出：https://cdn.example.com/a.png',
      },
      { type: 'text.delta', text: '\n\n![image](https://cdn.example.com/a.png)' },
      { type: 'stop', reason: 'end', detail: 'stop' },
    ]);
  });
});
