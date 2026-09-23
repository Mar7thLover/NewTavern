import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CAPITAL_FORMAT,
  drain,
  joinToolCalls,
  makeToolIr,
  sseResponse,
  toolHistory,
} from '../test-tools.js';
import type { Connection } from '../types.js';
import { openaiResponsesAdapter } from './openai-responses.js';

/** M6 契约 §1.2 / §1.6：openai-responses 工具调用契约回放 */

const conn: Connection = {
  id: 'c1',
  provider: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
};
const req = { method: 'POST' as const, url: 'https://x/responses', headers: {}, body: {} };

afterEach(() => {
  vi.unstubAllGlobals();
});

function body(ir: ReturnType<typeof makeToolIr>): Record<string, unknown> {
  return openaiResponsesAdapter.buildRequest(ir, conn, 'gpt-5').body as Record<string, unknown>;
}

describe('openai-responses 工具：请求渲染', () => {
  it('tools（strict 显式写出）/ tool_choice / function_call 与 function_call_output 输入项', () => {
    const b = body(makeToolIr('gpt-5', toolHistory(), { toolChoice: { name: 'get_time' } }));
    expect(b.tools).toEqual([
      expect.objectContaining({ type: 'function', name: 'get_weather', strict: false }),
      expect.objectContaining({ type: 'function', name: 'get_time', strict: true }),
    ]);
    expect(b.tool_choice).toEqual({ type: 'function', name: 'get_time' });
    expect(b.instructions).toBe('You are helpful.');
    expect(b.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Weather and time in Paris?' }] },
      { role: 'assistant', content: [{ type: 'output_text', text: 'Let me check.' }] },
      {
        type: 'function_call',
        call_id: 'call_A',
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
      },
      { type: 'function_call', call_id: 'call_B', name: 'get_time', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call_A', output: '{"temp":14}' },
      {
        type: 'function_call_output',
        call_id: 'call_B',
        output: 'Error: timezone lookup failed',
      },
    ]);
  });

  it('与 image_generation 工具并存', () => {
    const r = openaiResponsesAdapter.buildRequest(
      makeToolIr('gpt-5', toolHistory()),
      conn,
      'gpt-5',
      {
        imageOutput: true,
      },
    );
    const tools = (r.body as { tools: { type: string }[] }).tools.map((t) => t.type);
    expect(tools).toEqual(['function', 'function', 'image_generation']);
  });

  it('responseFormat → text.format json_schema', () => {
    const b = body(
      makeToolIr('gpt-5', toolHistory(), { tools: [], responseFormat: CAPITAL_FORMAT }),
    );
    expect(b.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'capital_info',
        schema: CAPITAL_FORMAT.schema,
        strict: true,
      },
    });
    expect(b).not.toHaveProperty('tools');
  });
});

describe('openai-responses 工具：流式解析', () => {
  const added = (outputIndex: number, id: string, callId: string, name: string) => ({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: { type: 'function_call', id, call_id: callId, name, arguments: '' },
  });
  const delta = (outputIndex: number, itemId: string, d: string) => ({
    type: 'response.function_call_arguments.delta',
    output_index: outputIndex,
    item_id: itemId,
    delta: d,
  });
  const completed = {
    type: 'response.completed',
    response: { usage: { input_tokens: 5, output_tokens: 3 } },
  };

  it('单个调用：added 给 id / name，增量只带 item_id，照样回填', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            added(0, 'fc_1', 'call_1', 'get_weather'),
            delta(0, 'fc_1', '{"city":'),
            delta(0, 'fc_1', '"Paris"}'),
            {
              type: 'response.function_call_arguments.done',
              output_index: 0,
              item_id: 'fc_1',
              arguments: '{"city":"Paris"}',
            },
            completed,
          ]),
        ),
      ),
    );
    const events = await drain(openaiResponsesAdapter, conn, req);
    for (const e of events.filter((x) => x.type === 'tool.call')) {
      expect(e).toMatchObject({ id: 'call_1', name: 'get_weather' });
    }
    expect(joinToolCalls(events)).toEqual([
      { id: 'call_1', name: 'get_weather', args: '{"city":"Paris"}' },
    ]);
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'tool' });
  });

  it('并行两个调用：增量交错也各归各的', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            added(1, 'fc_1', 'call_1', 'get_weather'),
            added(2, 'fc_2', 'call_2', 'get_time'),
            delta(1, 'fc_1', '{"city":"Paris"}'),
            delta(2, 'fc_2', '{"city":'),
            delta(2, 'fc_2', '"Tokyo"}'),
            completed,
          ]),
        ),
      ),
    );
    const events = await drain(openaiResponsesAdapter, conn, req);
    expect(joinToolCalls(events)).toEqual([
      { id: 'call_1', name: 'get_weather', args: '{"city":"Paris"}' },
      { id: 'call_2', name: 'get_time', args: '{"city":"Tokyo"}' },
    ]);
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'tool' });
  });

  it('没有增量的中转：output_item.done 的完整参数兜底', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            {
              type: 'response.output_item.done',
              output_index: 0,
              item: {
                type: 'function_call',
                id: 'fc_9',
                call_id: 'call_9',
                name: 'get_weather',
                arguments: '{"city":"Rome"}',
              },
            },
            completed,
          ]),
        ),
      ),
    );
    const events = await drain(openaiResponsesAdapter, conn, req);
    expect(joinToolCalls(events)).toEqual([
      { id: 'call_9', name: 'get_weather', args: '{"city":"Rome"}' },
    ]);
  });
});
