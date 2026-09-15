import type { Part, PromptIR, Role, Segment } from '@newtavern/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '../http.js';
import type { Connection, GenEvent } from '../types.js';
import { googleAdapter } from './google.js';

/** 默认测试模型：gemini-3* → thinking='level' */
const LEVEL_MODEL = 'gemini-3-pro-preview';
/** thinking='budget' 的 2.5 系列 */
const BUDGET_MODEL = 'gemini-2.5-pro';
/** thinking='none'（目录里 2.0 没写 thinking） */
const NO_THINKING_MODEL = 'gemini-2.0-flash';

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

function makeIr(
  segments: Segment[],
  cachePlan: PromptIR['cachePlan'] = { breakpoints: [] },
  sampling: PromptIR['sampling'] = {},
): PromptIR {
  return {
    model: LEVEL_MODEL,
    sampling,
    segments,
    cachePlan,
    meta: {
      chatId: 'chat-1',
      presetId: 'preset-1',
      layoutMode: 'cache-aware',
      activations: [],
      warnings: [],
      tokenEstimate: 0,
    },
  };
}

const conn: Connection = {
  id: 'c1',
  provider: 'google',
  baseUrl: 'https://generativelanguage.googleapis.com/',
  apiKey: 'AIza-test',
};

interface GPart {
  text?: string;
  thoughtSignature?: string;
}

interface Body {
  contents: { role: string; parts: GPart[] }[];
  safetySettings: { category: string; threshold: string }[];
  generationConfig: Record<string, unknown>;
  systemInstruction?: { parts: GPart[] };
}

function body(
  ir: PromptIR,
  model = LEVEL_MODEL,
  opts?: Parameters<typeof googleAdapter.buildRequest>[3],
) {
  const req = googleAdapter.buildRequest(ir, conn, model, opts);
  return { req, body: req.body as Body };
}

async function drain(it: AsyncIterable<GenEvent>): Promise<GenEvent[]> {
  const out: GenEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('google buildRequest', () => {
  it('URL / 鉴权头 / systemInstruction 抽取 / contents 角色映射', () => {
    const ir = makeIr([
      text('s1', 'system', '预设', 'system'),
      text('s2', 'system', '角色卡', 'system'),
      text('h1', 'user', 'u1'),
      text('h2', 'assistant', 'a1'),
      text('h3', 'user', 'u2'),
    ]);
    const { req, body: b } = body(ir);

    expect(req.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse',
    );
    expect(req.headers).toEqual({
      'content-type': 'application/json',
      'x-goog-api-key': 'AIza-test',
    });
    expect(b.systemInstruction).toEqual({ parts: [{ text: '预设' }, { text: '角色卡' }] });
    expect(b.contents).toEqual([
      { role: 'user', parts: [{ text: 'u1' }] },
      { role: 'model', parts: [{ text: 'a1' }] },
      { role: 'user', parts: [{ text: 'u2' }] },
    ]);
    expect(b.generationConfig.maxOutputTokens).toBe(4096);
    expect(req.warnings).toBeUndefined();
  });

  it('safetySettings 全部类别 BLOCK_NONE', () => {
    const { body: b } = body(makeIr([text('h1', 'user', 'u')]));
    expect(b.safetySettings).toEqual([
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
    ]);
  });

  it('中途的 system 段降级为 user 并与两侧 user 合并', () => {
    const ir = makeIr([
      text('s1', 'system', 'SYS', 'system'),
      text('h1', 'user', 'u1'),
      text('inj', 'system', '深度注入'),
      text('h2', 'user', 'u2'),
    ]);
    expect(body(ir).body.contents).toEqual([
      { role: 'user', parts: [{ text: 'u1\n\n深度注入\n\nu2' }] },
    ]);
  });

  it('同角色合并：相邻 assistant 段用 \\n\\n 连接后成为一个 model content', () => {
    const ir = makeIr([
      text('h1', 'user', 'u'),
      text('h2', 'assistant', 'A'),
      text('h3', 'assistant', 'B'),
      text('h4', 'user', 'u2'),
    ]);
    expect(body(ir).body.contents[1]).toEqual({ role: 'model', parts: [{ text: 'A\n\nB' }] });
  });

  it('首条是 assistant 时前插 user [Start]', () => {
    const ir = makeIr([
      text('s1', 'system', 'SYS', 'system'),
      text('h1', 'assistant', '初次问候'),
      text('h2', 'user', 'hi'),
    ]);
    const { body: b } = body(ir);
    expect(b.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(b.contents[0]?.parts).toEqual([{ text: '[Start]' }]);
  });

  it('末尾是 assistant 时追加 user [Continue]', () => {
    const ir = makeIr([text('h1', 'user', 'u'), text('h2', 'assistant', '半句')]);
    const { body: b } = body(ir);
    expect(b.contents.map((c) => c.role)).toEqual(['user', 'model', 'user']);
    expect(b.contents[2]?.parts).toEqual([{ text: '[Continue]' }]);
  });

  it('只有 system 段时兜底为一条 user [Continue]，systemInstruction 照常', () => {
    const ir = makeIr([text('s1', 'system', 'SYS', 'system')]);
    const { body: b } = body(ir);
    expect(b.contents).toEqual([{ role: 'user', parts: [{ text: '[Continue]' }] }]);
    expect(b.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
  });

  it("thinking='level'：缺省 high，可指定 low，非法值回退 high 并告警", () => {
    const ir = makeIr([text('h1', 'user', 'u')]);
    expect(body(ir, LEVEL_MODEL).body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'high',
      includeThoughts: true,
    });
    expect(
      body(ir, LEVEL_MODEL, { thinking: { effort: 'low' } }).body.generationConfig.thinkingConfig,
    ).toEqual({ thinkingLevel: 'low', includeThoughts: true });

    const bad = body(ir, LEVEL_MODEL, { thinking: { effort: 'ultra' } });
    expect(bad.body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'high',
      includeThoughts: true,
    });
    expect(bad.req.warnings?.some((w) => w.includes('thinkingLevel=ultra'))).toBe(true);
  });

  it("thinking='budget'：缺省 -1，可指定预算；effort 被丢弃并告警", () => {
    const ir = makeIr([text('h1', 'user', 'u')]);
    expect(body(ir, BUDGET_MODEL).body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: -1,
      includeThoughts: true,
    });
    const withBudget = body(ir, BUDGET_MODEL, {
      thinking: { budgetTokens: 8192, effort: 'high' },
    });
    expect(withBudget.body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 8192,
      includeThoughts: true,
    });
    expect(withBudget.req.warnings?.some((w) => w.includes('thinkingBudget 控制推理'))).toBe(true);
  });

  it("thinking='none' 不带 thinkingConfig，给了推理参数则告警", () => {
    const ir = makeIr([text('h1', 'user', 'u')]);
    const { req, body: b } = body(ir, NO_THINKING_MODEL, { thinking: { effort: 'high' } });
    expect(b.generationConfig.thinkingConfig).toBeUndefined();
    expect(req.warnings?.some((w) => w.includes('不支持推理参数'))).toBe(true);
  });

  it('采样参数映射进 generationConfig，min_p / repetition_penalty 丢弃并告警', () => {
    const ir = makeIr(
      [text('h1', 'user', 'u')],
      { breakpoints: [] },
      {
        temperature: 0.8,
        topP: 0.95,
        topK: 40,
        seed: 7,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        maxTokens: 2048,
        stop: ['\nUser:'],
        minP: 0.05,
        repetitionPenalty: 1.1,
      },
    );
    const { req, body: b } = body(ir);
    expect(b.generationConfig).toMatchObject({
      temperature: 0.8,
      topP: 0.95,
      topK: 40,
      seed: 7,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      maxOutputTokens: 2048,
      stopSequences: ['\nUser:'],
    });
    expect(req.warnings).toContain('Gemini 不支持 min_p，已丢弃');
    expect(req.warnings).toContain('Gemini 不支持 repetition_penalty，已丢弃');
  });

  it('图片 / 文档 part 渲染为 asset: 占位文本并告警', () => {
    const ir = makeIr([
      seg('h1', 'user', [
        { type: 'text', text: '看图' },
        { type: 'image', assetId: 'img1', mime: 'image/png' },
        { type: 'document', assetId: 'doc1', mime: 'application/pdf' },
      ]),
    ]);
    const { req, body: b } = body(ir);
    expect(b.contents[0]?.parts).toEqual([
      { text: '看图' },
      { text: 'asset:img1' },
      { text: 'asset:doc1' },
    ]);
    expect(req.warnings).toEqual([
      '图片 img1 以 asset: 占位文本渲染，需由服务端替换为 inlineData',
      '文档 doc1 以 asset: 占位文本渲染，需由服务端替换为 inlineData',
    ]);
  });

  it('历史里的 reasoning_opaque：thoughtSignature 附着到该 model content 的文本 part 上', () => {
    const ir = makeIr([
      text('h1', 'user', 'u1'),
      seg('h2', 'assistant', [
        {
          type: 'reasoning_opaque',
          provider: 'google',
          model: LEVEL_MODEL,
          payload: { type: 'thoughtSignature', thoughtSignature: 'SIG123', partIndex: 1 },
        },
        { type: 'text', text: 'a1' },
      ]),
      text('h3', 'user', 'u2'),
    ]);
    expect(body(ir).body.contents[1]).toEqual({
      role: 'model',
      parts: [{ text: 'a1', thoughtSignature: 'SIG123' }],
    });
  });

  it('模型不匹配的 reasoning_opaque 被丢弃并告警', () => {
    const ir = makeIr([
      text('h1', 'user', 'u1'),
      seg('h2', 'assistant', [
        {
          type: 'reasoning_opaque',
          provider: 'google',
          model: BUDGET_MODEL,
          payload: { thoughtSignature: 'SIG' },
        },
        { type: 'text', text: 'a1' },
      ]),
      text('h3', 'user', 'u2'),
    ]);
    const { req, body: b } = body(ir, LEVEL_MODEL);
    expect(b.contents[1]).toEqual({ role: 'model', parts: [{ text: 'a1' }] });
    expect(req.warnings?.some((w) => w.includes('与当前模型不符'))).toBe(true);
  });

  it('没有可附着文本 part 的签名被丢弃并告警', () => {
    const ir = makeIr([
      text('h1', 'user', 'u1'),
      seg('h2', 'assistant', [
        {
          type: 'reasoning_opaque',
          provider: 'google',
          model: LEVEL_MODEL,
          payload: { thoughtSignature: 'SIG' },
        },
      ]),
      text('h3', 'user', 'u2'),
    ]);
    const { req, body: b } = body(ir);
    expect(b.contents[1]).toEqual({ role: 'model', parts: [] });
    expect(req.warnings?.some((w) => w.includes('没有可附着的文本 part'))).toBe(true);
  });

  it('ir.sampling.thinking 与 opts.thinking 都能提供 effort（opts 优先）', () => {
    const ir = makeIr([text('h1', 'user', 'u')]);
    (ir.sampling as Record<string, unknown>).thinking = { effort: 'low' };
    expect(body(ir).body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'low',
      includeThoughts: true,
    });
    expect(
      body(ir, LEVEL_MODEL, { thinking: { effort: 'high' } }).body.generationConfig.thinkingConfig,
    ).toEqual({ thinkingLevel: 'high', includeThoughts: true });
  });

  it('关闭推理：2.5 Flash thinkingBudget=0；2.5 Pro / 3.x 不可关，告警并按默认', () => {
    const ir = makeIr([text('h1', 'user', 'u')]);
    expect(
      body(ir, 'gemini-2.5-flash', { thinking: { enabled: false } }).body.generationConfig
        .thinkingConfig,
    ).toEqual({ thinkingBudget: 0, includeThoughts: false });
    const pro = body(ir, BUDGET_MODEL, { thinking: { enabled: false } });
    expect(pro.body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: -1,
      includeThoughts: true,
    });
    expect(pro.req.warnings).toContain(`模型 ${BUDGET_MODEL} 不支持关闭推理，已按默认处理`);
    const level = body(ir, LEVEL_MODEL, { thinking: { enabled: false } });
    expect(level.body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'high',
      includeThoughts: true,
    });
  });

  it('预设 reasoning_effort（ST 语义）：3 Pro 档位、2.5 Pro 按 maxOutputTokens 比例', () => {
    const ir = makeIr(
      [text('h1', 'user', 'u')],
      { breakpoints: [] },
      { maxTokens: 8192, reasoningEffort: 'medium' },
    );
    expect(body(ir, LEVEL_MODEL).body.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: 'low',
      includeThoughts: true,
    });
    expect(body(ir, BUDGET_MODEL).body.generationConfig.thinkingConfig).toEqual({
      thinkingBudget: 2048,
      includeThoughts: true,
    });
  });

  it('是纯函数：不改动 IR，两次结果一致', () => {
    const ir = makeIr([text('s1', 'system', 'SYS', 'system'), text('h1', 'user', 'u')], {
      breakpoints: [0],
    });
    const snapshot = JSON.stringify(ir);
    expect(body(ir).req).toEqual(body(ir).req);
    expect(JSON.stringify(ir)).toBe(snapshot);
  });

  it('baseUrl 尾斜杠被去掉，conn.headers 合并', () => {
    const custom: Connection = {
      ...conn,
      baseUrl: 'https://gemini.example.com/proxy//',
      headers: { 'x-extra': '1' },
    };
    const req = googleAdapter.buildRequest(makeIr([text('h1', 'user', 'u')]), custom, LEVEL_MODEL);
    expect(req.url).toBe(
      'https://gemini.example.com/proxy/v1beta/models/gemini-3-pro-preview:streamGenerateContent?alt=sse',
    );
    expect(req.headers['x-extra']).toBe('1');
  });
});

describe('google stream', () => {
  const req = {
    method: 'POST' as const,
    url: `https://x/v1beta/models/${LEVEL_MODEL}:streamGenerateContent?alt=sse`,
    headers: {},
    body: {},
  };

  function sse(lines: string[]): Response {
    return new Response(lines.join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  function stub(lines: string[]): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sse(lines))),
    );
  }

  it('回放：thought part → reasoning.delta，普通 text → text.delta，签名与 usage 在末尾', async () => {
    stub([
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"先想","thought":true}]}}],"usageMetadata":{"promptTokenCount":100}}',
      '',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"一下","thought":true}]}}]}',
      '',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"你好"}]}}]}',
      '',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"，世界","thoughtSignature":"SIG-A"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":30,"candidatesTokenCount":12,"thoughtsTokenCount":7,"totalTokenCount":119}}',
      '',
      '',
    ]);

    const events = await drain(googleAdapter.stream(conn, req, new AbortController().signal));
    expect(events).toEqual([
      { type: 'reasoning.delta', text: '先想' },
      { type: 'reasoning.delta', text: '一下' },
      { type: 'text.delta', text: '你好' },
      { type: 'text.delta', text: '，世界' },
      {
        type: 'reasoning.opaque',
        provider: 'google',
        model: LEVEL_MODEL,
        payload: { type: 'thoughtSignature', thoughtSignature: 'SIG-A', partIndex: 0 },
      },
      { type: 'usage', input: 70, output: 12, cacheRead: 30, cacheWrite: 0, reasoning: 7 },
      { type: 'stop', reason: 'end' },
    ]);
    const usage = events[5] as Extract<GenEvent, { type: 'usage' }>;
    expect(usage.input + usage.cacheRead + usage.cacheWrite).toBe(100);
  });

  it('重复出现的同一个 thoughtSignature 只 yield 一次 opaque', async () => {
    stub([
      'data: {"candidates":[{"content":{"parts":[{"text":"a","thoughtSignature":"SIG"}]}}]}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":"b","thoughtSignature":"SIG"}]},"finishReason":"STOP"}]}',
      '',
      '',
    ]);
    const events = await drain(googleAdapter.stream(conn, req, new AbortController().signal));
    expect(events.filter((e) => e.type === 'reasoning.opaque')).toHaveLength(1);
  });

  it('MAX_TOKENS → stop:length', async () => {
    stub([
      'data: {"candidates":[{"content":{"parts":[{"text":"半句"}]},"finishReason":"MAX_TOKENS"}]}',
      '',
      '',
    ]);
    const events = await drain(googleAdapter.stream(conn, req, new AbortController().signal));
    expect(events).toEqual([
      { type: 'text.delta', text: '半句' },
      { type: 'stop', reason: 'length' },
    ]);
  });

  it('finishReason=SAFETY → stop:filter，detail 写原因', async () => {
    stub(['data: {"candidates":[{"content":{"parts":[]},"finishReason":"SAFETY"}]}', '', '']);
    expect(await drain(googleAdapter.stream(conn, req, new AbortController().signal))).toEqual([
      { type: 'stop', reason: 'filter', detail: 'SAFETY' },
    ]);
  });

  it('未知 finishReason → stop:end 并带 detail', async () => {
    stub(['data: {"candidates":[{"content":{"parts":[]},"finishReason":"OTHER"}]}', '', '']);
    expect(await drain(googleAdapter.stream(conn, req, new AbortController().signal))).toEqual([
      { type: 'stop', reason: 'end', detail: 'OTHER' },
    ]);
  });

  it('promptFeedback.blockReason 且无候选 → stop:filter', async () => {
    stub([
      'data: {"promptFeedback":{"blockReason":"PROHIBITED_CONTENT","safetyRatings":[]},"usageMetadata":{"promptTokenCount":42}}',
      '',
      '',
    ]);
    expect(await drain(googleAdapter.stream(conn, req, new AbortController().signal))).toEqual([
      { type: 'usage', input: 42, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      { type: 'stop', reason: 'filter', detail: 'PROHIBITED_CONTENT' },
    ]);
  });

  it('inlineData → image 事件', async () => {
    stub([
      'data: {"candidates":[{"content":{"parts":[{"inlineData":{"mimeType":"image/png","data":"BASE64=="}}]},"finishReason":"STOP"}]}',
      '',
      '',
    ]);
    expect(await drain(googleAdapter.stream(conn, req, new AbortController().signal))).toEqual([
      { type: 'image', mime: 'image/png', data: 'BASE64==' },
      { type: 'stop', reason: 'end' },
    ]);
  });

  it('流内 error 体归一化为 rateLimit', async () => {
    stub([
      'data: {"error":{"code":429,"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED"}}',
      '',
      '',
    ]);
    const events = await drain(googleAdapter.stream(conn, req, new AbortController().signal));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      retryable: true,
      error: { kind: 'rateLimit', message: 'Quota exceeded', status: 429 },
    });
  });

  it('HTTP 429 错误体 → error 事件 kind rateLimit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            '{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}',
            { status: 429 },
          ),
        ),
      ),
    );
    const events = await drain(googleAdapter.stream(conn, req, new AbortController().signal));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      retryable: true,
      error: { kind: 'rateLimit', status: 429, message: 'Resource has been exhausted' },
    });
  });

  it('abort → stop:abort', async () => {
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
    expect(await drain(googleAdapter.stream(conn, req, ctrl.signal))).toEqual([
      { type: 'stop', reason: 'abort' },
    ]);
  });

  it('没有 finishReason 也以 stop:end 收尾', async () => {
    stub(['data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}', '', '']);
    const events = await drain(googleAdapter.stream(conn, req, new AbortController().signal));
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'end' });
  });
});

describe('google listModels / normalizeError', () => {
  it('剥掉 models/ 前缀、过滤不支持 generateContent 的、映射 token 上限', async () => {
    const fetchMock = vi.fn((..._args: unknown[]) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            models: [
              {
                name: 'models/gemini-3-pro-preview',
                displayName: 'Gemini 3 Pro Preview',
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ['generateContent', 'countTokens'],
              },
              {
                name: 'models/text-embedding-004',
                displayName: 'Embedding 004',
                supportedGenerationMethods: ['embedContent'],
              },
              { displayName: '没有 name', supportedGenerationMethods: ['generateContent'] },
              {
                name: 'models/gemini-2.5-flash',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(googleAdapter.listModels(conn)).resolves.toEqual([
      {
        id: 'gemini-3-pro-preview',
        name: 'Gemini 3 Pro Preview',
        contextLength: 1048576,
        maxOutput: 65536,
      },
      { id: 'gemini-2.5-flash' },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
    );
    const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers['x-goog-api-key']).toBe('AIza-test');
  });

  it('listModels 403 抛出 providerError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            '{"error":{"code":403,"message":"API key not valid","status":"PERMISSION_DENIED"}}',
            { status: 403 },
          ),
        ),
      ),
    );
    await expect(googleAdapter.listModels(conn)).rejects.toMatchObject({
      name: 'ProviderErrorException',
      providerError: { kind: 'auth', message: 'API key not valid', retryable: false },
    });
  });

  it('normalizeError 映射 Google status 字段', () => {
    expect(
      googleAdapter.normalizeError(
        new HttpError(
          429,
          '{"error":{"code":429,"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED"}}',
        ),
      ),
    ).toMatchObject({ kind: 'rateLimit', retryable: true, status: 429 });
    expect(
      googleAdapter.normalizeError(
        new HttpError(503, '{"error":{"code":503,"message":"overloaded","status":"UNAVAILABLE"}}'),
      ),
    ).toMatchObject({ kind: 'overloaded', retryable: true });
    expect(
      googleAdapter.normalizeError(
        new HttpError(
          401,
          '{"error":{"code":401,"message":"missing key","status":"UNAUTHENTICATED"}}',
        ),
      ),
    ).toMatchObject({ kind: 'auth', retryable: false });
    expect(
      googleAdapter.normalizeError(
        new HttpError(
          400,
          '{"error":{"code":400,"message":"The input token count (2000000) exceeds the maximum","status":"INVALID_ARGUMENT"}}',
        ),
      ),
    ).toMatchObject({ kind: 'contextLength', retryable: false });
    expect(
      googleAdapter.normalizeError(
        new HttpError(
          400,
          '{"error":{"code":400,"message":"Invalid JSON payload","status":"INVALID_ARGUMENT"}}',
        ),
      ),
    ).toMatchObject({ kind: 'invalid', retryable: false });
    expect(googleAdapter.normalizeError(new HttpError(500, 'plain text'))).toMatchObject({
      kind: 'overloaded',
    });
  });

  it('capabilities 读目录并接受 modelOverrides', () => {
    expect(googleAdapter.capabilities(LEVEL_MODEL, conn)).toMatchObject({
      thinking: 'level',
      effortLevels: ['low', 'high'],
      reasoningRoundtrip: 'thoughtSignature',
      maxContext: 1000000,
    });
    expect(googleAdapter.capabilities(BUDGET_MODEL, conn).thinking).toBe('budget');
    expect(
      googleAdapter.capabilities(LEVEL_MODEL, {
        ...conn,
        modelOverrides: { [LEVEL_MODEL]: { maxOutput: 1024 } },
      }).maxOutput,
    ).toBe(1024);
  });
});
