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
import { googleAdapter } from './google.js';

/** M6 契约 §1.2 / §1.6：google 工具调用契约回放 */

const conn: Connection = {
  id: 'c1',
  provider: 'google',
  baseUrl: 'https://generativelanguage.googleapis.com',
  apiKey: 'g-key',
};
const MODEL = 'gemini-2.5-flash';
const req = {
  method: 'POST' as const,
  url: `https://x/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
  headers: {},
  body: {},
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function build(ir: ReturnType<typeof makeToolIr>, model = MODEL) {
  return googleAdapter.buildRequest(ir, conn, model);
}

describe('google 工具：请求渲染', () => {
  it('functionDeclarations（剔除不支持的关键字并告警）/ toolConfig / functionCall 与 functionResponse', () => {
    const r = build(makeToolIr(MODEL, toolHistory(), { toolChoice: { name: 'get_weather' } }));
    const b = r.body as Record<string, unknown>;
    expect(b.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Get the current weather for a city.',
            parameters: {
              type: 'object',
              properties: {
                city: { type: 'string', description: 'City name' },
                // type: ['string','null'] → type + nullable
                unit: { nullable: true, type: 'string', enum: ['c', 'f'] },
              },
              required: ['city'],
            },
          },
          {
            name: 'get_time',
            description: 'Get the local time of a city.',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      },
    ]);
    expect(r.warnings?.some((w) => w.includes('additionalProperties'))).toBe(true);
    expect(b.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] },
    });
    expect(b.contents).toEqual([
      { role: 'user', parts: [{ text: 'Weather and time in Paris?' }] },
      {
        role: 'model',
        parts: [
          { text: 'Let me check.' },
          { functionCall: { name: 'get_weather', args: { city: 'Paris' }, id: 'call_A' } },
          { functionCall: { name: 'get_time', args: { city: 'Paris' }, id: 'call_B' } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'get_weather', response: { temp: 14 }, id: 'call_A' } },
          {
            functionResponse: {
              name: 'get_time',
              response: { error: 'timezone lookup failed' },
              id: 'call_B',
            },
          },
        ],
      },
    ]);
  });

  it('合成的 call_<n> id 不回传；非 JSON 结果包成 { result }；functionResponse 排在 user parts 最前', () => {
    const r = build(
      makeToolIr(MODEL, [
        seg('u1', 'user', [{ type: 'text', text: 'hi' }]),
        seg('a1', 'assistant', [
          { type: 'tool_call', id: 'call_0', name: 'get_weather', args: '{}' },
        ]),
        seg('r1', 'user', [
          { type: 'text', text: 'extra' },
          { type: 'tool_result', callId: 'call_0', name: 'get_weather', content: 'sunny' },
        ]),
      ]),
    );
    const contents = (r.body as { contents: { parts: unknown[] }[] }).contents;
    expect(contents[1]?.parts).toEqual([{ functionCall: { name: 'get_weather', args: {} } }]);
    expect(contents[2]?.parts).toEqual([
      { functionResponse: { name: 'get_weather', response: { result: 'sunny' } } },
      { text: 'extra' },
    ]);
  });

  it('toolChoice 映射：auto / none / required', () => {
    const mode = (c: Parameters<typeof makeToolIr>[2]) =>
      (build(makeToolIr(MODEL, toolHistory(), c)).body as { toolConfig?: unknown }).toolConfig;
    expect(mode({ toolChoice: 'auto' })).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
    expect(mode({ toolChoice: 'none' })).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(mode({ toolChoice: 'required' })).toEqual({ functionCallingConfig: { mode: 'ANY' } });
    expect(mode({})).toBeUndefined();
  });

  it('responseFormat → responseMimeType + responseSchema（清洗后）', () => {
    const r = build(
      makeToolIr(MODEL, toolHistory(), { tools: [], responseFormat: CAPITAL_FORMAT }),
    );
    const cfg = (r.body as { generationConfig: Record<string, unknown> }).generationConfig;
    expect(cfg.responseMimeType).toBe('application/json');
    expect(cfg.responseSchema).toEqual({
      type: 'object',
      properties: { capital: { type: 'string' }, population: { type: 'number' } },
      required: ['capital'],
    });
  });

  it('函数调用与 JSON 输出同时用：Gemini 3 两个都发，更早的模型丢掉 responseFormat 并告警', () => {
    const old = build(makeToolIr(MODEL, toolHistory(), { responseFormat: CAPITAL_FORMAT }));
    expect(
      (old.body as { generationConfig: Record<string, unknown> }).generationConfig,
    ).not.toHaveProperty('responseSchema');
    expect(old.warnings?.some((w) => w.includes('已丢弃 responseFormat'))).toBe(true);
    const g3 = build(
      makeToolIr('gemini-3-pro-preview', toolHistory(), { responseFormat: CAPITAL_FORMAT }),
      'gemini-3-pro-preview',
    );
    expect(
      (g3.body as { generationConfig: Record<string, unknown> }).generationConfig.responseMimeType,
    ).toBe('application/json');
  });

  it('functionCall 上的 thoughtSignature 按 target=tool 挂回原处', () => {
    const r = build(
      makeToolIr(MODEL, [
        seg('u1', 'user', [{ type: 'text', text: 'hi' }]),
        seg('a1', 'assistant', [
          {
            type: 'reasoning_opaque',
            provider: 'google',
            model: MODEL,
            payload: {
              type: 'thoughtSignature',
              thoughtSignature: 'SIG',
              target: 'tool',
              ordinal: 1,
            },
          },
          { type: 'tool_call', id: 'call_0', name: 'get_weather', args: '{}' },
          { type: 'tool_call', id: 'call_1', name: 'get_time', args: '{}' },
        ]),
        seg('r1', 'user', [
          { type: 'tool_result', callId: 'call_0', name: 'get_weather', content: '{}' },
          { type: 'tool_result', callId: 'call_1', name: 'get_time', content: '{}' },
        ]),
      ]),
    );
    const parts = (r.body as { contents: { parts: Record<string, unknown>[] }[] }).contents[1]
      ?.parts;
    expect(parts?.[0]).not.toHaveProperty('thoughtSignature');
    expect(parts?.[1]).toMatchObject({ thoughtSignature: 'SIG' });
  });
});

describe('google 工具：流式解析', () => {
  it('单个调用：functionCall 一次给全参数，stop 归一化为 tool，签名记 target=tool', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            {
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      {
                        functionCall: { name: 'get_weather', args: { city: 'Paris' } },
                        thoughtSignature: 'SIG1',
                      },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
            },
          ]),
        ),
      ),
    );
    const events = await drain(googleAdapter, conn, req);
    expect(joinToolCalls(events)).toEqual([
      { id: 'call_0', name: 'get_weather', args: '{"city":"Paris"}' },
    ]);
    expect(events).toContainEqual({
      type: 'reasoning.opaque',
      provider: 'google',
      model: MODEL,
      payload: {
        type: 'thoughtSignature',
        thoughtSignature: 'SIG1',
        partIndex: 0,
        target: 'tool',
        ordinal: 0,
      },
    });
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'tool' });
  });

  it('并行两个调用：上游给了 id 就用上游的', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          sseResponse([
            {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: { id: 'fc-a', name: 'get_weather', args: { city: 'Paris' } },
                      },
                    ],
                  },
                },
              ],
            },
            {
              candidates: [
                {
                  content: {
                    parts: [
                      { functionCall: { id: 'fc-b', name: 'get_time', args: { city: 'Tokyo' } } },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
            },
          ]),
        ),
      ),
    );
    const events = await drain(googleAdapter, conn, req);
    expect(joinToolCalls(events)).toEqual([
      { id: 'fc-a', name: 'get_weather', args: '{"city":"Paris"}' },
      { id: 'fc-b', name: 'get_time', args: '{"city":"Tokyo"}' },
    ]);
  });
});
