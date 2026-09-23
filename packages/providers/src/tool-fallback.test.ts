import { describe, expect, it } from 'vitest';

import { makeToolIr, seg, toolHistory } from './test-tools.js';
import {
  applyTextResponseFormat,
  applyTextToolProtocol,
  createToolCallTextFilter,
  extractFirstJson,
  parseTextToolCalls,
} from './tool-fallback.js';
import { sanitizeGoogleSchema } from './tools.js';

/** M6 契约 §1.3：文本降级协议 */

describe('applyTextToolProtocol', () => {
  it('去掉 tools，在最后一个 system 段后插协议段，历史里的工具 part 渲染成文本，不改原 IR', () => {
    const ir = makeToolIr('m', toolHistory(), {
      toolChoice: 'required',
      cachePlan: { breakpoints: [0, 2] },
    });
    const before = JSON.stringify(ir);
    const out = applyTextToolProtocol(ir, 'zh-CN');
    expect(JSON.stringify(ir)).toBe(before);
    expect(out.tools).toBeUndefined();
    expect(out.toolChoice).toBeUndefined();
    expect(out.segments.map((s) => s.id)).toEqual(['sys', 'tool_protocol', 'u1', 'a1', 'r1']);
    // 断点下标随插入平移
    expect(out.cachePlan.breakpoints).toEqual([0, 3]);
    const protocol = out.segments[1];
    expect(protocol?.role).toBe('system');
    const text = protocol?.parts[0]?.type === 'text' ? protocol.parts[0].text : '';
    expect(text).toContain('```tool_call');
    expect(text).toContain('### get_weather');
    expect(text).toContain('本轮必须至少调用一个工具');
    // 工具 part 全部变成文本
    for (const s of out.segments) {
      for (const p of s.parts) expect(['text']).toContain(p.type);
    }
    const a1 =
      out.segments[3]?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') ?? '';
    expect(a1).toContain('Let me check.');
    expect(a1).toContain('```tool_call\n{"name":"get_weather","arguments":{"city":"Paris"}}\n```');
    const r1 =
      out.segments[4]?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') ?? '';
    expect(r1).toContain('```tool_result get_weather\n{"temp":14}\n```');
    expect(r1).toContain('```tool_result get_time error\ntimezone lookup failed\n```');
  });

  it('没有 system 段时协议段放最前；toolChoice=none 只渲染历史不加协议', () => {
    const noSys = applyTextToolProtocol(makeToolIr('m', toolHistory().slice(1)), 'en');
    expect(noSys.segments[0]?.id).toBe('tool_protocol');
    const t = noSys.segments[0]?.parts[0];
    expect(t?.type === 'text' && t.text.startsWith('# Tool use')).toBe(true);

    const none = applyTextToolProtocol(
      makeToolIr('m', toolHistory(), { toolChoice: 'none' }),
      'en',
    );
    expect(none.segments.map((s) => s.id)).toEqual(['sys', 'u1', 'a1', 'r1']);
  });

  it('内容里有 ``` 时用更长的围栏', () => {
    const out = applyTextToolProtocol(
      makeToolIr('m', [
        seg('r', 'user', [
          { type: 'tool_result', callId: 'x', name: 'read', content: 'a\n```js\ncode\n```' },
        ]),
      ]),
      'en',
    );
    const text = out.segments.find((s) => s.id === 'r')?.parts[0];
    expect(text?.type === 'text' && text.text.startsWith('````tool_result read')).toBe(true);
  });
});

describe('parseTextToolCalls', () => {
  it('解析多个代码块，rest 为去掉代码块后的正文', () => {
    const text =
      '我来查一下。\n\n```tool_call\n{"name": "get_weather", "arguments": {"city": "巴黎"}}\n```\n\n```tool_call\n{"name":"get_time","arguments":"{\\"city\\":\\"东京\\"}"}\n```\n稍等。';
    const { toolCalls, rest } = parseTextToolCalls(text);
    expect(toolCalls).toEqual([
      { id: 'call_0', name: 'get_weather', args: '{"city":"巴黎"}', parsed: { city: '巴黎' } },
      { id: 'call_1', name: 'get_time', args: '{"city":"东京"}', parsed: { city: '东京' } },
    ]);
    expect(rest).toBe('我来查一下。\n\n稍等。');
  });

  it('未闭合的末尾代码块照样解析；坏 JSON 给 parseError；普通代码块不动', () => {
    const { toolCalls, rest } = parseTextToolCalls(
      '```js\nlet a = 1;\n```\n```tool_call\nnot json\n```\n```tool_call\n{"name":"x","arguments":{}}',
    );
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ id: 'call_0', name: '' });
    expect(toolCalls[0]?.parseError).toBeTruthy();
    expect(toolCalls[1]).toEqual({ id: 'call_1', name: 'x', args: '{}', parsed: {} });
    expect(rest).toBe('```js\nlet a = 1;\n```');
  });

  it('没有代码块：原文返回', () => {
    expect(parseTextToolCalls('  just text ')).toEqual({ toolCalls: [], rest: 'just text' });
  });
});

describe('结构化输出降级', () => {
  it('applyTextResponseFormat：去掉 responseFormat，附 schema 说明', () => {
    const ir = makeToolIr('m', toolHistory(), {
      tools: undefined,
      responseFormat: { name: 'card', schema: { type: 'object' } },
    });
    const out = applyTextResponseFormat(ir, 'zh-CN');
    expect(out.responseFormat).toBeUndefined();
    expect(ir.responseFormat).toBeDefined();
    const seg1 = out.segments[1];
    expect(seg1?.id).toBe('response_format');
    const t = seg1?.parts[0];
    expect(
      t?.type === 'text' && t.text.includes('JSON Schema') && t.text.includes('"object"'),
    ).toBe(true);
  });

  it('extractFirstJson：```json 代码块优先；否则括号配对，跳过字符串里的括号与坏候选', () => {
    expect(extractFirstJson('x\n```json\n{"a": [1, 2]}\n```')?.value).toEqual({ a: [1, 2] });
    expect(extractFirstJson('答案是 {"s": "a}b{"} 以上')).toEqual({
      json: '{"s": "a}b{"}',
      value: { s: 'a}b{' },
    });
    expect(extractFirstJson('{oops} then [1,2]')?.value).toEqual([1, 2]);
    expect(extractFirstJson('no json here')).toBeUndefined();
  });
});

describe('createToolCallTextFilter', () => {
  it('滤掉跨 chunk 的 tool_call 代码块，保留正文与普通代码块', () => {
    const f = createToolCallTextFilter();
    const chunks = [
      '好的`',
      '``tool',
      '_call\n{"name":"a",',
      '"arguments":{}}\n`',
      '``\n再见 ``',
      '`js\nx\n```',
    ];
    const out = chunks.map((c) => f.push(c)).join('') + f.flush();
    expect(out).toBe('好的\n再见 ```js\nx\n```');
  });

  it('未闭合的代码块在 flush 时丢弃', () => {
    const f = createToolCallTextFilter();
    const out = f.push('hi ```tool_call\n{"name":') + f.flush();
    expect(out).toBe('hi ');
  });
});

describe('sanitizeGoogleSchema', () => {
  it('剔除不支持的关键字；const → enum；properties 的字段名不当关键字；多类型联合 → anyOf', () => {
    const dropped = new Set<string>();
    const out = sanitizeGoogleSchema(
      {
        $schema: 'x',
        type: 'object',
        additionalProperties: false,
        properties: {
          additionalProperties: { type: 'string', const: 'k' },
          list: { type: 'array', items: { type: 'object', oneOf: [], properties: {} } },
          both: { type: ['string', 'number'] },
        },
      },
      dropped,
    );
    expect(out).toEqual({
      type: 'object',
      properties: {
        additionalProperties: { type: 'string', enum: ['k'] },
        list: { type: 'array', items: { type: 'object', properties: {} } },
        both: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      },
    });
    expect([...dropped].sort()).toEqual(['$schema', 'additionalProperties', 'oneOf']);
  });
});
