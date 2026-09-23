import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { openaiChatAdapter } from './openai-chat.js';

/** M6 契约 §1.2 / §1.6：openai-chat 工具调用契约回放 */

const conn: Connection = {
  id: 'c1',
  provider: 'openai-chat',
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
};
const req = { method: 'POST' as const, url: 'https://x/chat/completions', headers: {}, body: {} };

afterEach(() => {
  vi.unstubAllGlobals();
});

function body(ir: ReturnType<typeof makeToolIr>): Record<string, unknown> {
  return openaiChatAdapter.buildRequest(ir, conn, 'gpt-5').body as Record<string, unknown>;
}

describe('openai-chat 工具：请求渲染', () => {
  it('tools / tool_choice / 历史里的 tool_call 与 tool_result', () => {
    const b = body(makeToolIr('gpt-5', toolHistory(), { toolChoice: 'required' }));
    expect(b.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city.',
          parameters: expect.objectContaining({ additionalProperties: false }) as unknown,
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_time',
          description: 'Get the local time of a city.',
          parameters: expect.any(Object) as unknown,
          strict: true,
        },
      },
    ]);
    expect(b.tool_choice).toBe('required');
    const messages = b.messages as Record<string, unknown>[];
    // gpt-5 走 developer 角色；tool 结果各自一条 role:'tool'，紧跟 assistant
    expect(messages.slice(1)).toEqual([
      { role: 'user', content: 'Weather and time in Paris?' },
      {
        role: 'assistant',
        content: 'Let me check.',
        tool_calls: [
          {
            id: 'call_A',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
          {
            id: 'call_B',
            type: 'function',
            function: { name: 'get_time', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_A', content: '{"temp":14}' },
      { role: 'tool', tool_call_id: 'call_B', content: 'Error: timezone lookup failed' },
    ]);
  });

  it('只有工具调用的 assistant 消息 content 为 null；tool_result 之后的 user 正文另起一条', () => {
    const ir = makeToolIr('gpt-5', [
      seg('u1', 'user', [{ type: 'text', text: 'hi' }]),
      seg('a1', 'assistant', [
        { type: 'tool_call', id: 'call_A', name: 'get_weather', args: '{}' },
      ]),
      seg('r1', 'user', [
        { type: 'tool_result', callId: 'call_A', name: 'get_weather', content: 'sunny' },
        { type: 'text', text: 'and tomorrow?' },
      ]),
    ]);
    const messages = body(ir).messages as Record<string, unknown>[];
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_A', type: 'function', function: { name: 'get_weather', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_A', content: 'sunny' },
      { role: 'user', content: 'and tomorrow?' },
    ]);
  });

  it('强制调用指定工具 → tool_choice.function.name；不存在的工具名告警', () => {
    const b = body(makeToolIr('gpt-5', toolHistory(), { toolChoice: { name: 'get_weather' } }));
    expect(b.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } });
    const r = openaiChatAdapter.buildRequest(
      makeToolIr('gpt-5', toolHistory(), { toolChoice: { name: 'nope' } }),
      conn,
      'gpt-5',
    );
    expect(r.warnings?.some((w) => w.includes('nope'))).toBe(true);
  });

  it('responseFormat → response_format.json_schema', () => {
    const b = body(
      makeToolIr('gpt-5', toolHistory(), { tools: [], responseFormat: CAPITAL_FORMAT }),
    );
    expect(b.tools).toBeUndefined();
    expect(b.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'capital_info', schema: CAPITAL_FORMAT.schema, strict: true },
    });
  });

  it('没有工具字段时请求体不变（不出现 tools / tool_choice / response_format）', () => {
    const b = body(makeToolIr('gpt-5', toolHistory().slice(0, 2), { tools: undefined }));
    expect(b).not.toHaveProperty('tools');
    expect(b).not.toHaveProperty('tool_choice');
    expect(b).not.toHaveProperty('response_format');
  });
});

describe('openai-chat 工具：流式解析', () => {
  it('单个调用：后续 chunk 的 id / name 为空时按 index 回填', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_x',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"ci' } }] } }],
            },
            {
              choices: [
                { delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Paris"}' } }] } },
              ],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            '[DONE]',
          ]),
        ),
      ),
    );
    const events = await drain(openaiChatAdapter, conn, req);
    const calls = events.filter((e) => e.type === 'tool.call');
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c).toMatchObject({ id: 'call_x', name: 'get_weather' });
    expect(joinToolCalls(events)).toEqual([
      { id: 'call_x', name: 'get_weather', args: '{"city":"Paris"}' },
    ]);
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'tool' });
  });

  it('并行两个调用：按 index 交错到达也各归各的', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '' } },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 1,
                        id: 'call_2',
                        function: { name: 'get_time', arguments: '{"city"' },
                      },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: '{"city":"Paris"}' } },
                      { index: 1, function: { arguments: ':"Tokyo"}' } },
                    ],
                  },
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]),
        ),
      ),
    );
    const events = await drain(openaiChatAdapter, conn, req);
    expect(joinToolCalls(events)).toEqual([
      { id: 'call_1', name: 'get_weather', args: '{"city":"Paris"}' },
      { id: 'call_2', name: 'get_time', args: '{"city":"Tokyo"}' },
    ]);
  });

  it('没有 id 的端点用 call_<n> 生成；同一 index 上来了新 id 视为新调用；finish_reason=stop 也归一化为 tool', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, function: { name: 'get_weather', arguments: '{}' } }],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'g2', function: { name: 'get_time', arguments: '{}' } },
                    ],
                  },
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: 'stop' }] },
          ]),
        ),
      ),
    );
    const events = await drain(openaiChatAdapter, conn, req);
    expect(joinToolCalls(events)).toEqual([
      { id: 'call_0', name: 'get_weather', args: '{}' },
      { id: 'g2', name: 'get_time', args: '{}' },
    ]);
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'tool' });
  });
});
