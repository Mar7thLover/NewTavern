import { describe, expect, it } from 'vitest';

import { parseSseStream, type SseEvent } from './sse.js';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(chunks: string[]): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of parseSseStream(streamOf(chunks))) out.push(ev);
  return out;
}

describe('parseSseStream', () => {
  it('解析基础事件', async () => {
    expect(await collect(['event: ping\ndata: {"a":1}\n\n'])).toEqual([
      { event: 'ping', data: '{"a":1}' },
    ]);
  });

  it('跨 chunk 断句', async () => {
    const events = await collect(['data: hel', 'lo wor', 'ld\n', '\ndata: second\n\n']);
    expect(events.map((e) => e.data)).toEqual(['hello world', 'second']);
  });

  it('跨 chunk 切在 UTF-8 多字节中间也不乱码', async () => {
    const bytes = new TextEncoder().encode('data: 你好\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 8));
        controller.enqueue(bytes.slice(8));
        controller.close();
      },
    });
    const out: SseEvent[] = [];
    for await (const ev of parseSseStream(stream)) out.push(ev);
    expect(out).toEqual([{ data: '你好' }]);
  });

  it('CRLF 行尾', async () => {
    expect(await collect(['event: delta\r\ndata: a\r\ndata: b\r\n\r\n'])).toEqual([
      { event: 'delta', data: 'a\nb' },
    ]);
  });

  it('多行 data 以 \\n 连接，注释行被忽略', async () => {
    const events = await collect([': keep-alive\ndata: line1\ndata: line2\n\n: ping\n\n']);
    expect(events).toEqual([{ data: 'line1\nline2' }]);
  });

  it('冒号后只去掉一个空格，空 data 行保留为空串', async () => {
    expect(await collect(['data:  spaced\ndata:\n\n'])).toEqual([{ data: ' spaced\n' }]);
  });

  it('id / retry 字段', async () => {
    expect(await collect(['id: 7\nretry: 2000\ndata: x\n\n'])).toEqual([
      { data: 'x', id: '7', retry: 2000 },
    ]);
  });

  it('结尾缺少空行时也冲刷出最后一个事件', async () => {
    expect(await collect(['data: [DONE]'])).toEqual([{ data: '[DONE]' }]);
  });

  it('无 data 的块不产生事件', async () => {
    expect(await collect(['event: ping\n\ndata: real\n\n'])).toEqual([{ data: 'real' }]);
  });

  it('可配合 new Response(text).body 回放', async () => {
    const body = new Response('data: a\n\ndata: b\n\n').body;
    expect(body).not.toBeNull();
    const out: string[] = [];
    for await (const ev of parseSseStream(body as ReadableStream<Uint8Array>)) out.push(ev.data);
    expect(out).toEqual(['a', 'b']);
  });
});
