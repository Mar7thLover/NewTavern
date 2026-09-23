import type { Part, PromptIR, Role, Segment, ToolDef } from '@newtavern/core';

import type { Connection, GenEvent, ProviderAdapter, ProviderRequest } from './types.js';

/**
 * 工具调用契约回放测试的共用夹具（M6 契约 §1.6）。生产代码不引用本文件。
 */

export function seg(id: string, role: Role, parts: Part[], slot?: 'system' | 'history'): Segment {
  const s = slot ?? (role === 'system' ? 'system' : 'history');
  return {
    id,
    role,
    parts,
    origin: { kind: s === 'system' ? 'global_system' : 'history' },
    anchor: { slot: s, order: 0 },
    stability: s === 'system' ? 'static' : 'history',
  };
}

export const WEATHER_TOOL: ToolDef = {
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
      unit: { type: ['string', 'null'], enum: ['c', 'f'] },
    },
    required: ['city'],
    additionalProperties: false,
  },
};

export const TIME_TOOL: ToolDef = {
  name: 'get_time',
  description: 'Get the local time of a city.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  strict: true,
};

export const CAPITAL_FORMAT = {
  name: 'capital_info',
  schema: {
    type: 'object',
    properties: { capital: { type: 'string' }, population: { type: 'number' } },
    required: ['capital'],
    additionalProperties: false,
  },
  strict: true,
};

/** 一轮完整的工具往返历史：user 提问 → assistant 并行调用两个工具 → user 回传两个结果 */
export function toolHistory(): Segment[] {
  return [
    seg('sys', 'system', [{ type: 'text', text: 'You are helpful.' }]),
    seg('u1', 'user', [{ type: 'text', text: 'Weather and time in Paris?' }]),
    seg('a1', 'assistant', [
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_call', id: 'call_A', name: 'get_weather', args: '{"city":"Paris"}' },
      { type: 'tool_call', id: 'call_B', name: 'get_time', args: '{"city":"Paris"}' },
    ]),
    seg('r1', 'user', [
      { type: 'tool_result', callId: 'call_A', name: 'get_weather', content: '{"temp":14}' },
      {
        type: 'tool_result',
        callId: 'call_B',
        name: 'get_time',
        content: 'timezone lookup failed',
        isError: true,
      },
    ]),
  ];
}

export function makeToolIr(
  model: string,
  segments: Segment[],
  extra: Partial<PromptIR> = {},
): PromptIR {
  return {
    model,
    sampling: {},
    segments,
    cachePlan: { breakpoints: [] },
    meta: {
      chatId: '',
      presetId: '',
      layoutMode: 'cache-aware',
      activations: [],
      warnings: [],
      tokenEstimate: 0,
    },
    tools: [WEATHER_TOOL, TIME_TOOL],
    ...extra,
  };
}

/** SSE 响应体：每个元素一条 `data:`（可带 event 名） */
export function sseResponse(events: (unknown | { event: string; data: unknown })[]): Response {
  const body = events
    .map((e) => {
      if (typeof e === 'object' && e !== null && 'event' in e && 'data' in e) {
        const ev = e as { event: string; data: unknown };
        return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
      }
      return `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`;
    })
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export async function drain(
  adapter: ProviderAdapter,
  conn: Connection,
  req: ProviderRequest,
): Promise<GenEvent[]> {
  const out: GenEvent[] = [];
  for await (const ev of adapter.stream(conn, req, new AbortController().signal)) out.push(ev);
  return out;
}

/** 把 tool.call 事件按 id 拼成 { id, name, args }，顺带断言每个事件都带 id 与 name */
export function joinToolCalls(events: GenEvent[]): { id: string; name: string; args: string }[] {
  const map = new Map<string, { id: string; name: string; args: string }>();
  for (const ev of events) {
    if (ev.type !== 'tool.call') continue;
    if (ev.id === '' || ev.name === '')
      throw new Error(`tool.call 缺 id 或 name：${JSON.stringify(ev)}`);
    const cur = map.get(ev.id);
    if (cur) {
      if (cur.name !== ev.name) throw new Error(`同一 id 的 name 不一致：${ev.id}`);
      cur.args += ev.argsDelta;
    } else {
      map.set(ev.id, { id: ev.id, name: ev.name, args: ev.argsDelta });
    }
  }
  return [...map.values()];
}
