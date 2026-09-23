import { afterEach, describe, expect, it, vi } from 'vitest';

import { collectStream } from '../collect.js';
import {
  CAPITAL_FORMAT,
  drain,
  joinToolCalls,
  makeToolIr,
  seg,
  sseResponse,
  toolHistory,
} from '../test-tools.js';
import type { Connection } from '../types.js';
import { anthropicAdapter } from './anthropic.js';

/** M6 契约 §1.2 / §1.6：anthropic 工具调用契约回放 */

const conn: Connection = {
  id: 'c1',
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant',
};
const MODEL = 'claude-haiku-4-5';
const req = {
  method: 'POST' as const,
  url: 'https://x/v1/messages',
  headers: {},
  body: { model: MODEL },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function build(ir: ReturnType<typeof makeToolIr>, model = MODEL) {
  return anthropicAdapter.buildRequest(ir, conn, model);
}

describe('anthropic 工具：请求渲染', () => {
  it('tools（input_schema）/ tool_choice / tool_use 与 tool_result 块', () => {
    const r = build(makeToolIr(MODEL, toolHistory(), { toolChoice: 'required' }));
    const b = r.body as Record<string, unknown>;
    expect(b.tools).toEqual([
      {
        name: 'get_weather',
        description: 'Get the current weather for a city.',
        input_schema: expect.objectContaining({ type: 'object' }) as unknown,
      },
      {
        name: 'get_time',
        description: 'Get the local time of a city.',
        input_schema: expect.any(Object) as unknown,
        strict: true,
      },
    ]);
    expect(b.tool_choice).toEqual({ type: 'any' });
    expect(b.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Weather and time in Paris?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool_use', id: 'call_A', name: 'get_weather', input: { city: 'Paris' } },
          { type: 'tool_use', id: 'call_B', name: 'get_time', input: { city: 'Paris' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_A', content: '{"temp":14}' },
          {
            type: 'tool_result',
            tool_use_id: 'call_B',
            content: 'timezone lookup failed',
            is_error: true,
          },
        ],
      },
    ]);
    expect(r.structuredOutputTool).toBeUndefined();
  });

  it('tool_result 排在 user content 最前面（合并进来的正文在后）', () => {
    const r = build(
      makeToolIr(MODEL, [
        seg('u1', 'user', [{ type: 'text', text: 'hi' }]),
        seg('a1', 'assistant', [
          { type: 'tool_call', id: 't1', name: 'get_weather', args: 'oops' },
        ]),
        seg('r1', 'user', [
          { type: 'text', text: 'note first' },
          { type: 'tool_result', callId: 't1', name: 'get_weather', content: 'ok' },
        ]),
      ]),
    );
    const messages = (r.body as { messages: { content: { type: string }[] }[] }).messages;
    expect(messages[2]?.content.map((c) => c.type)).toEqual(['tool_result', 'text']);
    // 参数不是 JSON 对象：用 {} 顶上并告警
    expect(messages[1]?.content[0]).toMatchObject({ type: 'tool_use', input: {} });
    expect(r.warnings?.some((w) => w.includes('不是 JSON 对象'))).toBe(true);
  });

  it('toolChoice 映射：auto / none / { name }', () => {
    const choice = (c: Parameters<typeof makeToolIr>[2]) =>
      (build(makeToolIr(MODEL, toolHistory(), c)).body as { tool_choice?: unknown }).tool_choice;
    expect(choice({ toolChoice: 'auto' })).toEqual({ type: 'auto' });
    expect(choice({ toolChoice: 'none' })).toEqual({ type: 'none' });
    expect(choice({ toolChoice: { name: 'get_weather' } })).toEqual({
      type: 'tool',
      name: 'get_weather',
    });
    expect(choice({})).toBeUndefined();
  });

  it('结构化输出：强制调用同名单工具模拟，并在请求上标注 structuredOutputTool', () => {
    const r = build(
      makeToolIr(MODEL, toolHistory().slice(0, 2), { tools: [], responseFormat: CAPITAL_FORMAT }),
    );
    const b = r.body as Record<string, unknown>;
    expect(b.tools).toEqual([
      expect.objectContaining({
        name: 'capital_info',
        input_schema: CAPITAL_FORMAT.schema,
        strict: true,
      }),
    ]);
    expect(b.tool_choice).toEqual({ type: 'tool', name: 'capital_info' });
    expect(r.structuredOutputTool).toBe('capital_info');
  });

  it('结构化输出 + 其他工具：tool_choice=any 并告警', () => {
    const r = build(makeToolIr(MODEL, toolHistory(), { responseFormat: CAPITAL_FORMAT }));
    expect((r.body as { tool_choice: unknown }).tool_choice).toEqual({ type: 'any' });
    expect((r.body as { tools: unknown[] }).tools).toHaveLength(3);
    expect(r.warnings?.some((w) => w.includes('tool_choice 改为 any'))).toBe(true);
  });

  it('强制工具调用与推理不兼容：能关推理就关，不能关则退回 auto', () => {
    const glm = build(
      makeToolIr('glm-5.3-flash', toolHistory(), { toolChoice: 'required' }),
      'glm-5.3-flash',
    );
    expect((glm.body as { thinking: unknown }).thinking).toEqual({ type: 'disabled' });
    expect((glm.body as { tool_choice: unknown }).tool_choice).toEqual({ type: 'any' });

    const fable = build(
      makeToolIr('claude-fable-5', toolHistory(), { toolChoice: { name: 'get_weather' } }),
      'claude-fable-5',
    );
    expect((fable.body as { thinking: unknown }).thinking).toEqual({ type: 'adaptive' });
    expect((fable.body as { tool_choice: unknown }).tool_choice).toEqual({ type: 'auto' });
    expect(fable.warnings?.some((w) => w.includes('退回 auto'))).toBe(true);
  });
});

describe('anthropic 工具：流式解析', () => {
  const start = (index: number, id: string, name: string) => ({
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  });
  const json = (index: number, partial: string) => ({
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partial },
  });
  const stop = (index: number) => ({ type: 'content_block_stop', index });
  const end = (reason: string) => [
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ];

  it('单个调用：content_block_start(tool_use) + input_json_delta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            { type: 'message_start', message: { usage: { input_tokens: 10 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Checking.' },
            },
            stop(0),
            start(1, 'toolu_1', 'get_weather'),
            json(1, ''),
            json(1, '{"city": "Pa'),
            json(1, 'ris"}'),
            stop(1),
            ...end('tool_use'),
          ]),
        ),
      ),
    );
    const events = await drain(anthropicAdapter, conn, req);
    expect(joinToolCalls(events)).toEqual([
      { id: 'toolu_1', name: 'get_weather', args: '{"city": "Paris"}' },
    ]);
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'tool' });
  });

  it('并行两个调用', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            start(0, 'toolu_1', 'get_weather'),
            json(0, '{"city":"Paris"}'),
            stop(0),
            start(1, 'toolu_2', 'get_time'),
            json(1, '{"city":'),
            json(1, '"Tokyo"}'),
            stop(1),
            ...end('tool_use'),
          ]),
        ),
      ),
    );
    const events = await drain(anthropicAdapter, conn, req);
    expect(joinToolCalls(events)).toEqual([
      { id: 'toolu_1', name: 'get_weather', args: '{"city":"Paris"}' },
      { id: 'toolu_2', name: 'get_time', args: '{"city":"Tokyo"}' },
    ]);
  });

  it('结构化输出模拟：collectStream 把输出工具的参数还原为正文，stop 归一化为 end', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            start(0, 'toolu_9', 'capital_info'),
            json(0, '{"capital":'),
            json(0, '"Paris"}'),
            stop(0),
            ...end('tool_use'),
          ]),
        ),
      ),
    );
    const r = build(
      makeToolIr(MODEL, toolHistory().slice(0, 2), { tools: [], responseFormat: CAPITAL_FORMAT }),
    );
    const forwarded: string[] = [];
    const result = await collectStream(
      anthropicAdapter,
      conn,
      r,
      new AbortController().signal,
      (e) => {
        if (e.type === 'text.delta') forwarded.push(e.text);
        expect(e.type).not.toBe('tool.call');
      },
    );
    expect(result.text).toBe('{"capital":"Paris"}');
    expect(forwarded.join('')).toBe('{"capital":"Paris"}');
    expect(result.toolCalls).toEqual([]);
    expect(result.stop).toEqual({ reason: 'end' });
  });
});
