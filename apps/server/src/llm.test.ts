import fs from 'node:fs';

import type { PromptIR, Segment } from '@newtavern/core';
import type { GenEvent, ProviderAdapter } from '@newtavern/providers';
import { afterAll, describe, expect, it } from 'vitest';

import { schema } from './db/client.js';
import { callLlm, streamLlm } from './services/llm.js';
import { ProviderServiceError } from './services/providers.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  registerFakeAdapter,
  type FakeAdapterOptions,
} from './test-helpers.js';

/** M6 契约 §1.5：services/llm.ts（callLlm / streamLlm） */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function seg(id: string, role: Segment['role'], text: string): Segment {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    origin: { kind: role === 'system' ? 'global_system' : 'history' },
    anchor: { slot: role === 'system' ? 'system' : 'history', order: 0 },
    stability: role === 'system' ? 'static' : 'history',
  };
}

function makeIr(extra: Partial<PromptIR> = {}): PromptIR {
  return {
    model: 'fake-model-1',
    sampling: {},
    segments: [seg('sys', 'system', '你是助手。'), seg('u1', 'user', '巴黎天气？')],
    cachePlan: { breakpoints: [] },
    meta: {
      chatId: '',
      presetId: '',
      layoutMode: 'cache-aware',
      activations: [],
      warnings: [],
      tokenEstimate: 0,
    },
    tools: [
      {
        name: 'get_weather',
        description: '查天气',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
    ...extra,
  };
}

let seq = 0;
/** 每个用例一个独立的假适配器 + 连接（registry 是进程级的） */
function setup(options: Omit<FakeAdapterOptions, 'id'>, keys?: string[]) {
  const { db } = makeTestApp(dataDir);
  const id = `fake-llm-${(seq += 1)}`;
  const requests: unknown[] = [];
  const adapter = registerFakeAdapter({ id, renderMessages: true, ...options });
  const original = adapter.buildRequest.bind(adapter);
  adapter.buildRequest = (ir, conn, model, opts) => {
    const req = original(ir, conn, model, opts);
    requests.push(req.body);
    return req;
  };
  const conn = insertConnection(db, dataDir, id, keys);
  return { db, adapter, connectionId: conn.id, requests };
}

describe('callLlm', () => {
  it('原生工具：收齐并行调用、转发事件、写 generation_log（nodeId 为空）', async () => {
    const events: GenEvent[] = [
      { type: 'text.delta', text: '查一下。' },
      { type: 'tool.call', id: 'c1', name: 'get_weather', argsDelta: '{"city":' },
      { type: 'tool.call', id: 'c2', name: 'get_weather', argsDelta: '{"city":"东京"}' },
      { type: 'tool.call', id: 'c1', name: 'get_weather', argsDelta: '"巴黎"}' },
      { type: 'usage', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      { type: 'stop', reason: 'tool' },
    ];
    const { db, connectionId } = setup({ events, capabilities: { tools: true } });
    const seen: GenEvent[] = [];
    const r = await callLlm(db, dataDir, {
      connectionId,
      model: 'fake-model-1',
      ir: makeIr(),
      onEvent: (e) => seen.push(e),
    });
    expect(r.text).toBe('查一下。');
    expect(r.toolCalls).toEqual([
      { id: 'c1', name: 'get_weather', args: '{"city":"巴黎"}', parsed: { city: '巴黎' } },
      { id: 'c2', name: 'get_weather', args: '{"city":"东京"}', parsed: { city: '东京' } },
    ]);
    expect(r.stop).toEqual({ reason: 'tool' });
    expect(seen).toEqual(events);
    const logs = db.select().from(schema.generationLog).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      nodeId: null,
      model: 'fake-model-1',
      layoutMode: 'cache-aware',
      usage: { input: 10, output: 5 },
    });
  });

  it('不支持工具：套文本协议，解析 ```tool_call 代码块，流式正文滤掉代码块', async () => {
    const reply = '好的。\n```tool_call\n{"name":"get_weather","arguments":{"city":"巴黎"}}\n```';
    const { db, connectionId, requests } = setup({
      capabilities: { tools: false },
      events: [
        { type: 'text.delta', text: reply.slice(0, 10) },
        { type: 'text.delta', text: reply.slice(10) },
        { type: 'stop', reason: 'end' },
      ],
    });
    const seen: GenEvent[] = [];
    const r = await callLlm(db, dataDir, {
      connectionId,
      model: 'fake-model-1',
      ir: makeIr({ toolChoice: 'required' }),
      onEvent: (e) => seen.push(e),
    });
    // 请求里带协议段、没有 tools
    const body = requests[0] as { messages: { role: string; content: string }[] };
    expect(body.messages[0]?.content).toContain('```tool_call');
    expect(body.messages[0]?.content).toContain('本轮必须至少调用一个工具');
    expect(r.text).toBe('好的。');
    expect(r.toolCalls).toEqual([
      { id: 'call_0', name: 'get_weather', args: '{"city":"巴黎"}', parsed: { city: '巴黎' } },
    ]);
    expect(r.stop).toEqual({ reason: 'tool' });
    expect(r.warnings.some((w) => w.includes('文本协议'))).toBe(true);
    // 转发：正文不含代码块；补发 tool.call 后再发 stop
    const text = seen.flatMap((e) => (e.type === 'text.delta' ? [e.text] : [])).join('');
    expect(text.trim()).toBe('好的。');
    expect(seen.slice(-2)).toEqual([
      { type: 'tool.call', id: 'call_0', name: 'get_weather', argsDelta: '{"city":"巴黎"}' },
      { type: 'stop', reason: 'tool' },
    ]);
  });

  it('不支持结构化输出：附 schema 说明，从回复里抽第一个 JSON', async () => {
    const { db, connectionId, requests } = setup({
      capabilities: { structuredOutput: false },
      events: [
        { type: 'text.delta', text: '结果如下：\n```json\n{"capital":"巴黎"}\n```' },
        { type: 'stop', reason: 'end' },
      ],
    });
    const r = await callLlm(db, dataDir, {
      connectionId,
      model: 'fake-model-1',
      ir: makeIr({
        tools: undefined,
        responseFormat: { name: 'capital', schema: { type: 'object' } },
      }),
    });
    const body = requests[0] as { messages: { content: string }[] };
    expect(body.messages[0]?.content).toContain('JSON Schema');
    expect(r.text).toBe('{"capital":"巴黎"}');
  });

  it('多 Key 连接：首事件鉴权错误换下一个 Key 重试一次，错误不外泄', async () => {
    const keysSeen: string[] = [];
    const stream: ProviderAdapter['stream'] = async function* (conn) {
      keysSeen.push(conn.apiKey ?? '');
      if (conn.apiKey === 'sk-bad') {
        yield {
          type: 'error',
          error: { kind: 'auth', message: 'bad key', retryable: false },
          retryable: false,
        };
        return;
      }
      yield { type: 'text.delta', text: 'ok' };
      yield { type: 'stop', reason: 'end' };
    };
    const { db, connectionId } = setup({ stream }, ['sk-bad', 'sk-good']);
    const seen: GenEvent[] = [];
    const r = await callLlm(db, dataDir, {
      connectionId,
      model: 'fake-model-1',
      ir: makeIr({ tools: undefined }),
      onEvent: (e) => seen.push(e),
    });
    expect(keysSeen).toEqual(['sk-bad', 'sk-good']);
    expect(r.text).toBe('ok');
    expect(r.error).toBeUndefined();
    expect(seen.some((e) => e.type === 'error')).toBe(false);
  });

  it('上游错误放在 result.error，不抛；连接不存在则抛 ProviderServiceError', async () => {
    const { db, connectionId } = setup({
      events: [
        {
          type: 'error',
          error: { kind: 'overloaded', message: 'busy', retryable: true },
          retryable: true,
        },
      ],
    });
    const r = await callLlm(db, dataDir, { connectionId, model: 'fake-model-1', ir: makeIr() });
    expect(r.error?.kind).toBe('overloaded');
    await expect(
      callLlm(db, dataDir, { connectionId: 'missing', model: 'x', ir: makeIr() }),
    ).rejects.toBeInstanceOf(ProviderServiceError);
  });
});

describe('streamLlm', () => {
  it('边收边推，流结束后迭代结束', async () => {
    const events: GenEvent[] = [
      { type: 'reasoning.delta', text: '想' },
      { type: 'text.delta', text: '从前' },
      { type: 'text.delta', text: '有座山' },
      { type: 'stop', reason: 'end' },
    ];
    const { db, connectionId } = setup({ events, capabilities: { tools: true } });
    const got: GenEvent[] = [];
    for await (const ev of streamLlm(db, dataDir, {
      connectionId,
      model: 'fake-model-1',
      ir: makeIr({ tools: undefined }),
    })) {
      got.push(ev);
    }
    expect(got).toEqual(events);
  });

  it('提前 break 会中止上游', async () => {
    let aborted = false;
    const stream: ProviderAdapter['stream'] = async function* (_conn, _req, signal) {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      yield { type: 'text.delta', text: 'a' };
      await new Promise((resolve) => setTimeout(resolve, 20));
      yield { type: 'text.delta', text: 'b' };
    };
    const { db, connectionId } = setup({ stream });
    for await (const ev of streamLlm(db, dataDir, {
      connectionId,
      model: 'fake-model-1',
      ir: makeIr({ tools: undefined }),
    })) {
      expect(ev).toEqual({ type: 'text.delta', text: 'a' });
      break;
    }
    expect(aborted).toBe(true);
  });

  it('连接不存在：迭代时抛出', async () => {
    const { db } = setup({ events: [] });
    const iterate = async () => {
      for await (const _ev of streamLlm(db, dataDir, {
        connectionId: 'missing',
        model: 'x',
        ir: makeIr(),
      })) {
        // 不会走到
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(ProviderServiceError);
  });
});
