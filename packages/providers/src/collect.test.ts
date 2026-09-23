import { describe, expect, it } from 'vitest';

import { collectStream } from './collect.js';
import type { Connection, GenEvent, ProviderAdapter, ProviderRequest } from './types.js';

/** M6 契约 §1.4：collectStream */

const conn: Connection = { id: 'c', provider: 'openai-chat', baseUrl: 'https://x' };
const req: ProviderRequest = {
  method: 'POST',
  url: 'https://x',
  headers: {},
  body: {},
  warnings: ['w0'],
};

function fakeAdapter(events: GenEvent[] | (() => AsyncGenerator<GenEvent>)): ProviderAdapter {
  return {
    id: 'openai-chat',
    listModels: () => Promise.resolve([]),
    capabilities: () => {
      throw new Error('unused');
    },
    buildRequest: () => req,
    stream:
      typeof events === 'function'
        ? events
        : async function* () {
            for (const e of events) yield e;
          },
    normalizeError: (e) => ({ kind: 'network', message: String(e), retryable: false }),
  };
}

describe('collectStream', () => {
  it('收齐文本 / 推理 / opaque / 图片 / 工具调用 / usage / stop / 告警，并逐个转发', async () => {
    const events: GenEvent[] = [
      { type: 'reasoning.delta', text: 'think ' },
      { type: 'reasoning.delta', text: 'more' },
      { type: 'text.delta', text: 'Hello' },
      { type: 'text.delta', text: ' world' },
      { type: 'reasoning.opaque', provider: 'anthropic', model: 'm', payload: { sig: 1 } },
      { type: 'image', mime: 'image/png', data: 'AAAA' },
      { type: 'warning', message: 'w1' },
      { type: 'tool.call', id: 'a', name: 'get_weather', argsDelta: '{"city":' },
      { type: 'tool.call', id: 'b', name: 'get_time', argsDelta: '' },
      { type: 'tool.call', id: 'a', name: 'get_weather', argsDelta: '"Paris"}' },
      { type: 'tool.call', id: 'b', name: 'get_time', argsDelta: '{bad' },
      { type: 'usage', input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
      { type: 'stop', reason: 'tool' },
    ];
    const seen: GenEvent[] = [];
    const r = await collectStream(
      fakeAdapter(events),
      conn,
      req,
      new AbortController().signal,
      (e) => seen.push(e),
    );
    expect(seen).toEqual(events);
    expect(r.text).toBe('Hello world');
    expect(r.reasoning).toBe('think more');
    expect(r.opaque).toEqual([{ provider: 'anthropic', model: 'm', payload: { sig: 1 } }]);
    expect(r.images).toEqual([{ mime: 'image/png', data: 'AAAA' }]);
    expect(r.warnings).toEqual(['w0', 'w1']);
    expect(r.usage).toEqual({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5 });
    expect(r.stop).toEqual({ reason: 'tool' });
    expect(r.toolCalls[0]).toEqual({
      id: 'a',
      name: 'get_weather',
      args: '{"city":"Paris"}',
      parsed: { city: 'Paris' },
    });
    expect(r.toolCalls[1]).toMatchObject({ id: 'b', name: 'get_time', args: '{bad' });
    expect(r.toolCalls[1]?.parseError).toBeTruthy();
    expect(r.error).toBeUndefined();
  });

  it('空参数记为 {}', async () => {
    const r = await collectStream(
      fakeAdapter([{ type: 'tool.call', id: 'a', name: 'ping', argsDelta: '' }]),
      conn,
      req,
      new AbortController().signal,
    );
    expect(r.toolCalls).toEqual([{ id: 'a', name: 'ping', args: '{}', parsed: {} }]);
    // 没有 stop 事件：有工具调用就是 tool
    expect(r.stop).toEqual({ reason: 'tool' });
  });

  it('error 事件进 result.error；适配器抛异常也按 error 收', async () => {
    const r1 = await collectStream(
      fakeAdapter([
        {
          type: 'error',
          error: { kind: 'rateLimit', message: 'slow down', retryable: true },
          retryable: true,
        },
      ]),
      conn,
      req,
      new AbortController().signal,
    );
    expect(r1.error?.kind).toBe('rateLimit');
    expect(r1.stop).toEqual({ reason: 'end', detail: 'error' });

    const r2 = await collectStream(
      fakeAdapter(async function* () {
        yield { type: 'text.delta', text: 'partial' };
        throw new Error('boom');
      }),
      conn,
      req,
      new AbortController().signal,
    );
    expect(r2.text).toBe('partial');
    expect(r2.error).toMatchObject({ kind: 'network', message: 'Error: boom' });
  });

  it('中止：没有 stop 事件时记 abort', async () => {
    const ac = new AbortController();
    const r = await collectStream(
      fakeAdapter(async function* () {
        yield { type: 'text.delta', text: 'a' };
        ac.abort();
      }),
      conn,
      req,
      ac.signal,
    );
    expect(r.stop).toEqual({ reason: 'abort' });
  });

  it('结构化输出模拟工具：参数还原为正文，转发时变成 text.delta', async () => {
    const seen: GenEvent[] = [];
    const r = await collectStream(
      fakeAdapter([
        { type: 'text.delta', text: 'Sure:' },
        { type: 'tool.call', id: 't', name: 'out', argsDelta: '' },
        { type: 'tool.call', id: 't', name: 'out', argsDelta: '{"a":1}' },
        { type: 'stop', reason: 'tool' },
      ]),
      conn,
      { ...req, structuredOutputTool: 'out' },
      new AbortController().signal,
      (e) => seen.push(e),
    );
    expect(r.text).toBe('{"a":1}');
    expect(r.toolCalls).toEqual([]);
    expect(r.stop).toEqual({ reason: 'end' });
    expect(seen.filter((e) => e.type === 'tool.call')).toEqual([]);
    expect(seen).toContainEqual({ type: 'text.delta', text: '{"a":1}' });
  });
});
