import type { Part, PromptIR, Role, Segment } from '@newtavern/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '../http.js';
import { PDF_B64, PNG_B64, resolveAsset, TXT_CONTENT } from '../test-media.js';
import type { Connection, GenEvent } from '../types.js';
import { anthropicAdapter } from './anthropic.js';

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
    model: 'claude-opus-5',
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
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com/',
  apiKey: 'sk-ant-test',
};

interface Body {
  model: string;
  max_tokens: number;
  stream: true;
  system?: unknown[];
  messages: { role: string; content: Record<string, unknown>[] }[];
  thinking?: unknown;
  output_config?: unknown;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
}

function body(
  ir: PromptIR,
  model = 'claude-opus-5',
  opts?: Parameters<typeof anthropicAdapter.buildRequest>[3],
) {
  const req = anthropicAdapter.buildRequest(ir, conn, model, opts);
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

describe('anthropic buildRequest', () => {
  it('system 抽到顶层、断点落在 system 末块与历史消息、URL 与鉴权头', () => {
    const ir = makeIr(
      [
        text('s1', 'system', '预设', 'system'),
        text('s2', 'system', '角色卡', 'system'),
        text('h1', 'user', 'u1'),
        text('h2', 'assistant', 'a1'),
        text('h3', 'user', 'u2'),
      ],
      { breakpoints: [1, 3] },
    );
    const { req, body: b } = body(ir);

    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers).toEqual({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'sk-ant-test',
    });
    expect(b.system).toEqual([
      { type: 'text', text: '预设' },
      { type: 'text', text: '角色卡', cache_control: { type: 'ephemeral' } },
    ]);
    expect(b.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'a1', cache_control: { type: 'ephemeral' } }],
      },
      { role: 'user', content: [{ type: 'text', text: 'u2' }] },
    ]);
    expect(b.model).toBe('claude-opus-5');
    expect(b.max_tokens).toBe(4096);
    expect(b.stream).toBe(true);
    expect(b.thinking).toEqual({ type: 'adaptive' });
  });

  it("cachePlan.ttl==='1h' 写入 cache_control.ttl", () => {
    const ir = makeIr([text('s1', 'system', 'SYS', 'system'), text('h1', 'user', 'u')], {
      breakpoints: [0],
      ttl: '1h',
    });
    expect(body(ir).body.system).toEqual([
      { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
  });

  it('断点数超过 maxBreakpoints 时靠前优先并告警', () => {
    const segments = [text('s1', 'system', 'SYS', 'system')];
    for (let i = 0; i < 5; i += 1) {
      segments.push(text(`u${i}`, 'user', `u${i}`));
      segments.push(text(`a${i}`, 'assistant', `a${i}`));
    }
    const ir = makeIr(segments, { breakpoints: [0, 1, 2, 3, 4, 5] });
    const { req, body: b } = body(ir);
    const marked = [...(b.system ?? []), ...b.messages.flatMap((m) => m.content)].filter(
      (blk) => (blk as Record<string, unknown>).cache_control !== undefined,
    );
    expect(marked).toHaveLength(4);
    expect(req.warnings?.some((w) => w.includes('缓存断点超过 4 个'))).toBe(true);
  });

  it('同角色合并：相邻 user 段用 \\n\\n 连接', () => {
    const ir = makeIr([text('h1', 'user', 'A'), text('h2', 'user', 'B')]);
    expect(body(ir).body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'A\n\nB' }] },
    ]);
  });

  it('首条是 assistant 时前插 user [Start]', () => {
    const ir = makeIr([
      text('s1', 'system', 'SYS', 'system'),
      text('h1', 'assistant', '初次问候'),
      text('h2', 'user', 'hi'),
    ]);
    expect(body(ir).body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(body(ir).body.messages[0]?.content).toEqual([{ type: 'text', text: '[Start]' }]);
  });

  it('空消息列表兜底为一条 user [Continue]', () => {
    const ir = makeIr([text('s1', 'system', 'SYS', 'system')]);
    expect(body(ir).body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: '[Continue]' }] },
    ]);
  });

  it("prefill=false 且 systemInMessages=true：末段 assistant → role:'system'", () => {
    const ir = makeIr([
      text('s1', 'system', 'SYS', 'system'),
      text('h1', 'user', 'u1'),
      text('jb', 'assistant', '越狱 prefill'),
    ]);
    const { req, body: b } = body(ir, 'claude-opus-5');
    expect(b.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'u1' }] },
      { role: 'system', content: [{ type: 'text', text: '越狱 prefill' }] },
    ]);
    expect(req.warnings?.some((w) => w.includes('system 指令'))).toBe(true);
  });

  it('prefill=false 且 systemInMessages=false：末段 assistant → user 包 [Instruction]', () => {
    const ir = makeIr([
      text('s1', 'system', 'SYS', 'system'),
      text('h1', 'user', 'u1'),
      text('jb', 'assistant', '越狱 prefill'),
    ]);
    const { req, body: b } = body(ir, 'claude-sonnet-5');
    expect(b.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'u1\n\n[Instruction]\n越狱 prefill' }] },
    ]);
    expect(req.warnings?.some((w) => w.includes('[Instruction]'))).toBe(true);
  });

  it('prefill=true 的老模型保留末段 assistant 作为 prefill', () => {
    const ir = makeIr([text('h1', 'user', 'u1'), text('jb', 'assistant', '好的，')]);
    expect(body(ir, 'claude-haiku-4-5').body.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);
  });

  it('中途的 system 段（后面接 user）降级为 user', () => {
    const ir = makeIr([
      text('s1', 'system', 'SYS', 'system'),
      text('h1', 'user', 'u1'),
      text('inj', 'system', '深度注入'),
      text('h2', 'user', 'u2'),
    ]);
    // system 后面不是 assistant → 降级为 user，再与两侧 user 合并
    expect(body(ir).body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'u1\n\n深度注入\n\nu2' }] },
    ]);
  });

  it('历史里的 reasoning_opaque 放回 assistant content 开头', () => {
    const payload = { type: 'thinking', thinking: '想过了', signature: 'SIG' };
    const ir = makeIr([
      text('h1', 'user', 'u1'),
      seg('h2', 'assistant', [
        { type: 'reasoning_opaque', provider: 'anthropic', model: 'claude-opus-5', payload },
        { type: 'text', text: 'a1' },
      ]),
      text('h3', 'user', 'u2'),
    ]);
    expect(body(ir).body.messages[1]).toEqual({
      role: 'assistant',
      content: [payload, { type: 'text', text: 'a1' }],
    });
  });

  it('模型不匹配的 reasoning_opaque 被丢弃并告警', () => {
    const ir = makeIr([
      text('h1', 'user', 'u1'),
      seg('h2', 'assistant', [
        {
          type: 'reasoning_opaque',
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          payload: { type: 'thinking' },
        },
        { type: 'text', text: 'a1' },
      ]),
      text('h3', 'user', 'u2'),
    ]);
    const { req, body: b } = body(ir, 'claude-opus-5');
    expect(b.messages[1]?.content).toEqual([{ type: 'text', text: 'a1' }]);
    expect(req.warnings?.some((w) => w.includes('与当前模型不符'))).toBe(true);
  });

  it('没有 resolver 时图片 / 文档 part 渲染为 asset: 占位，不告警', () => {
    const ir = makeIr([
      seg('h1', 'user', [
        { type: 'text', text: '看图' },
        { type: 'image', assetId: 'img1', mime: 'image/png' },
        { type: 'document', assetId: 'doc1', mime: 'application/pdf' },
      ]),
    ]);
    const { req, body: b } = body(ir);
    expect(b.messages[0]?.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', source: { type: 'url', url: 'asset:img1' } },
      { type: 'document', source: { type: 'url', url: 'asset:doc1' } },
    ]);
    expect(req.warnings).toBeUndefined();
  });

  it("thinking='adaptive' + effort → output_config.effort", () => {
    const ir = makeIr([text('h1', 'user', 'u')]);
    const { body: b } = body(ir, 'claude-opus-5', { thinking: { effort: 'xhigh' } });
    expect(b.thinking).toEqual({ type: 'adaptive' });
    expect(b.output_config).toEqual({ effort: 'xhigh' });
  });

  it('adaptive 模型丢弃 budget_tokens 与采样参数并告警', () => {
    const ir = makeIr(
      [text('h1', 'user', 'u')],
      { breakpoints: [] },
      {
        temperature: 0.9,
        topP: 0.8,
        topK: 40,
        seed: 7,
        minP: 0.05,
        frequencyPenalty: 0.1,
      },
    );
    const { req, body: b } = body(ir, 'claude-opus-5', { thinking: { budgetTokens: 4096 } });
    expect(b.temperature).toBeUndefined();
    expect(b.top_p).toBeUndefined();
    expect(b.top_k).toBeUndefined();
    expect(req.warnings).toContain(
      '该模型使用 adaptive thinking，budget_tokens 已丢弃（传了会 400）',
    );
    expect(req.warnings?.some((w) => w.includes('已移除 temperature/top_p/top_k'))).toBe(true);
    expect(req.warnings).toContain('Anthropic 不支持 seed，已丢弃');
  });

  it("thinking='budget'：temperature 强制 1、丢弃 top_p/top_k", () => {
    const ir = makeIr(
      [text('h1', 'user', 'u')],
      { breakpoints: [] },
      {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
      },
    );
    const { req, body: b } = body(ir, 'claude-haiku-4-5', { thinking: { budgetTokens: 2048 } });
    expect(b.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(b.temperature).toBe(1);
    expect(b.top_p).toBeUndefined();
    expect(b.top_k).toBeUndefined();
    expect(req.warnings).toContain('开启 budget thinking 时 temperature 必须为 1，已覆盖');
    expect(req.warnings).toContain('开启 budget thinking 时不能传 top_p，已丢弃');
  });

  it('budget_tokens ≥ max_tokens 时抬高 max_tokens', () => {
    const ir = makeIr([text('h1', 'user', 'u')], { breakpoints: [] }, { maxTokens: 2048 });
    const { req, body: b } = body(ir, 'claude-haiku-4-5', { thinking: { budgetTokens: 8192 } });
    expect(b.max_tokens).toBe(9216);
    expect(req.warnings?.some((w) => w.includes('max_tokens 必须大于 budget_tokens'))).toBe(true);
  });

  it('可采样的老模型保留 temperature / top_p / top_k / stop', () => {
    const ir = makeIr(
      [text('h1', 'user', 'u')],
      { breakpoints: [] },
      {
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
        stop: ['\nUser:'],
      },
    );
    const { body: b } = body(ir, 'claude-sonnet-4-6');
    expect(b).toMatchObject({
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['\nUser:'],
    });
  });

  it('ir.sampling.thinking 与 opts.thinking 都能提供 effort（opts 优先）', () => {
    const ir = makeIr([text('h1', 'user', 'u')]);
    (ir.sampling as Record<string, unknown>).thinking = { effort: 'low' };
    expect(body(ir).body.output_config).toEqual({ effort: 'low' });
    expect(body(ir, 'claude-opus-5', { thinking: { effort: 'max' } }).body.output_config).toEqual({
      effort: 'max',
    });
  });

  it('关闭推理：可关的模型发 thinking:disabled，不带 output_config / budget', () => {
    const ir = makeIr([text('h1', 'user', 'u')], { breakpoints: [] }, { temperature: 0.7 });
    const opus = body(ir, 'claude-opus-5', { thinking: { enabled: false, effort: 'max' } });
    expect(opus.body.thinking).toEqual({ type: 'disabled' });
    expect(opus.body.output_config).toBeUndefined();
    const haiku = body(ir, 'claude-haiku-4-5', { thinking: { enabled: false } });
    expect(haiku.body.thinking).toEqual({ type: 'disabled' });
    // 关闭时采样参数不被 budget thinking 锁定
    expect(haiku.body.temperature).toBe(0.7);
    const glm = body(ir, 'glm-5.3-flash', { thinking: { enabled: false } });
    expect(glm.body.thinking).toEqual({ type: 'disabled' });
  });

  it('Z.AI GLM（Anthropic 兼容）：档位走 adaptive + output_config.effort', () => {
    const ir = makeIr([text('h1', 'user', 'u')]);
    const { req, body: b } = body(ir, 'glm-5.3-flash', { thinking: { effort: 'high' } });
    expect(b.thinking).toEqual({ type: 'adaptive' });
    expect(b.output_config).toEqual({ effort: 'high' });
    expect(req.warnings ?? []).toEqual([]);
  });

  it('Fable 系列不可关闭：告警并按默认 adaptive 发送', () => {
    const ir = makeIr([text('h1', 'user', 'u')]);
    const { req, body: b } = body(ir, 'claude-fable-5-1', { thinking: { enabled: false } });
    expect(b.thinking).toEqual({ type: 'adaptive' });
    expect(req.warnings).toContain('模型 claude-fable-5-1 不支持关闭推理，已按默认处理');
  });

  it('预设 reasoning_effort（ST 语义）：adaptive 走档位，budget 按 max_tokens 比例；会话覆盖优先', () => {
    const min = makeIr(
      [text('h1', 'user', 'u')],
      { breakpoints: [] },
      { maxTokens: 8192, reasoningEffort: 'min' },
    );
    expect(body(min, 'claude-opus-5').body.output_config).toEqual({ effort: 'low' });
    const high = makeIr(
      [text('h1', 'user', 'u')],
      { breakpoints: [] },
      { maxTokens: 8192, reasoningEffort: 'high' },
    );
    expect(body(high, 'claude-haiku-4-5').body.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 4096,
    });
    expect(body(high, 'claude-haiku-4-5', { thinking: { enabled: false } }).body.thinking).toEqual({
      type: 'disabled',
    });
  });

  it('Anthropic 无 name 字段：Segment.name 前缀化写进正文且照常合并（契约 §9 AS-8）', () => {
    const ir = makeIr([
      { ...text('h1', 'user', '你好'), name: '旅人' },
      { ...text('h2', 'user', '在吗'), name: '旅人' },
    ]);
    const out = body(ir).body;
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]?.content).toEqual([{ type: 'text', text: '旅人: 你好\n\n旅人: 在吗' }]);
    expect(JSON.stringify(out)).not.toContain('"name"');
  });

  it('是纯函数：不改动 IR，两次结果一致', () => {
    const ir = makeIr([text('s1', 'system', 'SYS', 'system'), text('h1', 'user', 'u')], {
      breakpoints: [0],
    });
    const snapshot = JSON.stringify(ir);
    expect(body(ir).req).toEqual(body(ir).req);
    expect(JSON.stringify(ir)).toBe(snapshot);
  });
});

describe('anthropic stream', () => {
  const req = {
    method: 'POST' as const,
    url: 'https://x/v1/messages',
    headers: {},
    body: { model: 'claude-opus-5' },
  };

  function sse(lines: string[]): Response {
    return new Response(lines.join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  it('回放：thinking 块 → reasoning.delta + reasoning.opaque，然后 text、usage、stop', async () => {
    const lines = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"cache_read_input_tokens":20,"cache_creation_input_tokens":30,"output_tokens":1}}}',
      '',
      'event: ping',
      'data: {"type":"ping"}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想一"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"下"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"你好"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"refusal"},"usage":{"output_tokens":42}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sse(lines))),
    );

    const events = await drain(anthropicAdapter.stream(conn, req, new AbortController().signal));
    expect(events).toEqual([
      { type: 'reasoning.delta', text: '想一' },
      { type: 'reasoning.delta', text: '下' },
      {
        type: 'reasoning.opaque',
        provider: 'anthropic',
        model: 'claude-opus-5',
        payload: { type: 'thinking', thinking: '想一下', signature: 'SIG' },
      },
      { type: 'text.delta', text: '你好' },
      { type: 'usage', input: 100, output: 42, cacheRead: 20, cacheWrite: 30, reasoning: 0 },
      { type: 'stop', reason: 'refusal' },
    ]);
    const usage = events[4] as Extract<GenEvent, { type: 'usage' }>;
    expect(usage.input + usage.cacheRead + usage.cacheWrite).toBe(150);
  });

  it('缺 signature_delta 时 opaque 仍带空签名', async () => {
    const lines = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"x"}}',
      '',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'data: {"type":"message_stop"}',
      '',
      '',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sse(lines))),
    );
    const events = await drain(anthropicAdapter.stream(conn, req, new AbortController().signal));
    expect(events[1]).toEqual({
      type: 'reasoning.opaque',
      provider: 'anthropic',
      model: 'claude-opus-5',
      payload: { type: 'thinking', thinking: 'x', signature: '' },
    });
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'end' });
  });

  it('redacted_thinking 直接 opaque', async () => {
    const lines = [
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"ENC"}}',
      '',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"max_tokens"}}',
      '',
      '',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sse(lines))),
    );
    const events = await drain(anthropicAdapter.stream(conn, req, new AbortController().signal));
    expect(events).toEqual([
      {
        type: 'reasoning.opaque',
        provider: 'anthropic',
        model: 'claude-opus-5',
        payload: { type: 'redacted_thinking', data: 'ENC' },
      },
      { type: 'stop', reason: 'length' },
    ]);
  });

  it('缺 cache_creation 字段时 cacheWrite 归零', async () => {
    const lines = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":5,"output_tokens":0}}}',
      '',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
      '',
      '',
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(sse(lines))),
    );
    const events = await drain(anthropicAdapter.stream(conn, req, new AbortController().signal));
    expect(events[0]).toEqual({
      type: 'usage',
      input: 10,
      output: 3,
      cacheRead: 5,
      cacheWrite: 0,
      reasoning: 0,
    });
    expect(events[1]).toEqual({ type: 'stop', reason: 'end', detail: 'end_turn' });
  });

  it('流内 error 事件归一化为 overloaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sse([
            'event: error',
            'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
            '',
            '',
          ]),
        ),
      ),
    );
    const events = await drain(anthropicAdapter.stream(conn, req, new AbortController().signal));
    expect(events).toEqual([
      {
        type: 'error',
        retryable: true,
        error: { kind: 'overloaded', message: 'Overloaded', retryable: true },
      },
    ]);
  });

  it('529 HTTP → overloaded error 事件', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}', {
            status: 529,
          }),
        ),
      ),
    );
    const events = await drain(anthropicAdapter.stream(conn, req, new AbortController().signal));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'overloaded', status: 529 } });
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
    expect(await drain(anthropicAdapter.stream(conn, req, ctrl.signal))).toEqual([
      { type: 'stop', reason: 'abort' },
    ]);
  });
});

describe('anthropic listModels / normalizeError / countTokens', () => {
  it('listModels 解析 /v1/models 并补上目录里的上下文长度', async () => {
    const fetchMock = vi.fn((..._args: unknown[]) =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
              { id: 'claude-haiku-4-5' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(anthropicAdapter.listModels(conn)).resolves.toEqual([
      { id: 'claude-opus-5', name: 'Claude Opus 5', contextLength: 1000000, maxOutput: 128000 },
      { id: 'claude-haiku-4-5', contextLength: 200000, maxOutput: 64000 },
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.anthropic.com/v1/models?limit=1000',
    );
  });

  it('listModels 401 抛出 providerError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('{"error":{"type":"authentication_error","message":"invalid key"}}', {
            status: 401,
          }),
        ),
      ),
    );
    await expect(anthropicAdapter.listModels(conn)).rejects.toMatchObject({
      providerError: { kind: 'auth', message: 'invalid key' },
    });
  });

  it('normalizeError 映射各家错误类型', () => {
    expect(
      anthropicAdapter.normalizeError(
        new HttpError(529, '{"error":{"type":"overloaded_error","message":"Overloaded"}}'),
      ),
    ).toMatchObject({ kind: 'overloaded', retryable: true });
    expect(
      anthropicAdapter.normalizeError(
        new HttpError(429, '{"error":{"type":"rate_limit_error","message":"slow"}}'),
      ),
    ).toMatchObject({ kind: 'rateLimit', retryable: true });
    expect(
      anthropicAdapter.normalizeError(
        new HttpError(
          400,
          '{"error":{"type":"invalid_request_error","message":"prompt is too long: 300000 tokens"}}',
        ),
      ),
    ).toMatchObject({ kind: 'contextLength', retryable: false });
    expect(anthropicAdapter.normalizeError(new HttpError(529, 'plain text'))).toMatchObject({
      kind: 'overloaded',
    });
  });

  it('countTokens 去掉 stream/max_tokens 后请求 count_tokens', async () => {
    const fetchMock = vi.fn((..._args: unknown[]) =>
      Promise.resolve(
        new Response(JSON.stringify({ input_tokens: 1234 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const ir = makeIr([text('h1', 'user', 'u')]);
    const built = anthropicAdapter.buildRequest(ir, conn, 'claude-opus-5');
    await expect(anthropicAdapter.countTokens?.(conn, built)).resolves.toBe(1234);
    const init = fetchMock.mock.calls[0]?.[1] as { body: string };
    const sent = JSON.parse(init.body) as Record<string, unknown>;
    expect(sent.stream).toBeUndefined();
    expect(sent.max_tokens).toBeUndefined();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.anthropic.com/v1/messages/count_tokens',
    );
  });
});

describe('anthropic 多模态', () => {
  it('有 resolver：base64 image / document 块，保持 parts 原顺序（不把图片挪到文本前）', () => {
    const ir = makeIr([
      seg('h1', 'user', [
        { type: 'text', text: '先看文字' },
        { type: 'image', assetId: 'img2', mime: 'image/jpeg' },
        { type: 'document', assetId: 'doc1', mime: 'application/pdf' },
        { type: 'text', text: '再说' },
      ]),
    ]);
    const { req, body: b } = body(ir, 'claude-opus-5', { resolveAsset });
    expect(b.messages[0]?.content).toEqual([
      { type: 'text', text: '先看文字' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG_B64 } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 },
      },
      { type: 'text', text: '再说' },
    ]);
    expect(req.warnings).toBeUndefined();
  });

  // 目录标着不收图片的模型（`glm-*` 这类整代通配）照样发：收不收由端点说了算
  it('目录标 imageIn / documentIn 为 false 的模型照样发媒体，不告警', () => {
    const ir = makeIr([
      seg('h1', 'user', [
        { type: 'image', assetId: 'img1', mime: 'image/png' },
        { type: 'document', assetId: 'doc1', mime: 'application/pdf' },
      ]),
    ]);
    const { req, body: b } = body(ir, 'glm-5.3-flash', { resolveAsset });
    expect(b.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: PDF_B64 },
          },
        ],
      },
    ]);
    expect(req.warnings).toBeUndefined();
  });

  it('assistant 与顶层 system 里的媒体丢弃并按角色告警', () => {
    const ir = makeIr([
      seg(
        's1',
        'system',
        [
          { type: 'text', text: '预设' },
          { type: 'image', assetId: 'img1', mime: 'image/png' },
        ],
        'system',
      ),
      text('h1', 'user', '画'),
      seg('h2', 'assistant', [
        { type: 'text', text: '好了' },
        { type: 'image', assetId: 'img1', mime: 'image/png' },
      ]),
      seg('h3', 'user', [
        { type: 'text', text: '改一下' },
        { type: 'image', assetId: 'img1', mime: 'image/png' },
      ]),
    ]);
    const { req, body: b } = body(ir, 'claude-opus-5', { resolveAsset });
    expect(b.system).toEqual([{ type: 'text', text: '预设' }]);
    expect(b.messages.map((m) => m.content)).toEqual([
      [{ type: 'text', text: '画' }],
      [{ type: 'text', text: '好了' }],
      [
        { type: 'text', text: '改一下' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
      ],
    ]);
    expect(req.warnings).toEqual([
      'Anthropic 的 system 消息不接受图片 / PDF，已丢弃 1 个',
      'Anthropic 的 assistant 消息不接受图片 / PDF，已丢弃 1 个',
    ]);
  });

  it('没有 resolver 时 assistant 里的图片同样丢弃（预览与真实请求一致）', () => {
    const ir = makeIr([
      text('h1', 'user', '画'),
      seg('h2', 'assistant', [{ type: 'image', assetId: 'img1', mime: 'image/png' }]),
      text('h3', 'user', '好'),
    ]);
    const { req, body: b } = body(ir);
    expect(b.messages[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: '​' }],
    });
    expect(req.warnings).toEqual(['Anthropic 的 assistant 消息不接受图片 / PDF，已丢弃 1 个']);
  });

  it('找不到资产与文本类文档：前者丢弃告警，后者解码为 text 块', () => {
    const ir = makeIr([
      seg('h1', 'user', [
        { type: 'document', assetId: 'txt1', mime: 'text/markdown' },
        { type: 'image', assetId: 'missing', mime: 'image/png' },
        { type: 'text', text: '看附件' },
      ]),
    ]);
    const { req, body: b } = body(ir, 'claude-opus-5', { resolveAsset });
    expect(b.messages[0]?.content).toEqual([
      { type: 'text', text: TXT_CONTENT },
      { type: 'text', text: '看附件' },
    ]);
    expect(req.warnings).toEqual(['找不到资产 missing，已丢弃']);
  });

  it('缓存断点仍落在最后一个 text 块上（图片不抢断点）', () => {
    const ir = makeIr(
      [
        seg('h1', 'user', [
          { type: 'text', text: '看' },
          { type: 'image', assetId: 'img1', mime: 'image/png' },
        ]),
      ],
      { breakpoints: [0] },
    );
    const { body: b } = body(ir, 'claude-opus-5', { resolveAsset });
    expect(b.messages[0]?.content[0]).toEqual({
      type: 'text',
      text: '看',
      cache_control: { type: 'ephemeral' },
    });
    expect(b.messages[0]?.content[1]?.cache_control).toBeUndefined();
  });

  it('imageOutput=true：告警该提供商不支持图片输出，请求体不变', () => {
    const ir = makeIr([text('h1', 'user', '画')]);
    const plain = body(ir);
    const { req, body: b } = body(ir, 'claude-opus-5', { imageOutput: true });
    expect(b).toEqual(plain.body);
    expect(req.warnings).toEqual(['该提供商不支持图片输出，已忽略 imageOutput']);
    expect(body(ir, 'claude-opus-5', { imageOutput: false }).req.warnings).toBeUndefined();
  });
});
