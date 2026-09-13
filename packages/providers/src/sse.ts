/**
 * 极简 SSE 解析器：只用全局 `ReadableStream` / `TextDecoder`，浏览器与 Node 都能跑。
 * 处理多行 data、CRLF、注释行、跨 chunk 断句；`[DONE]` 之类的哨兵由调用方判断。
 */

export interface SseEvent {
  /** `event:` 字段；缺省时由调用方按 data 内容判断 */
  event?: string;
  /** 多行 data 以 `\n` 连接 */
  data: string;
  id?: string;
  /** `retry:` 字段（毫秒） */
  retry?: number;
}

interface EventBuffer {
  event?: string;
  id?: string;
  retry?: number;
  data: string[];
}

function emptyBuffer(): EventBuffer {
  return { data: [] };
}

/** 解析一行；返回 true 表示这是空行（事件边界） */
function feedLine(buf: EventBuffer, rawLine: string): boolean {
  // CRLF：去掉行尾的 \r
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (line === '') return true;
  // 注释行
  if (line.startsWith(':')) return false;

  const colon = line.indexOf(':');
  const field = colon === -1 ? line : line.slice(0, colon);
  let value = colon === -1 ? '' : line.slice(colon + 1);
  // 规范：冒号后最多去掉一个空格
  if (value.startsWith(' ')) value = value.slice(1);

  switch (field) {
    case 'event':
      buf.event = value;
      break;
    case 'data':
      buf.data.push(value);
      break;
    case 'id':
      // 规范：含 NUL 的 id 忽略
      if (!value.includes('\0')) buf.id = value;
      break;
    case 'retry': {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 0) buf.retry = n;
      break;
    }
    default:
      // 未知字段忽略
      break;
  }
  return false;
}

function toEvent(buf: EventBuffer): SseEvent | null {
  if (buf.data.length === 0) return null;
  const ev: SseEvent = { data: buf.data.join('\n') };
  if (buf.event !== undefined && buf.event !== '') ev.event = buf.event;
  if (buf.id !== undefined) ev.id = buf.id;
  if (buf.retry !== undefined) ev.retry = buf.retry;
  return ev;
}

/**
 * 把字节流解析为 SSE 事件序列。调用方负责在结束/中止时不再消费。
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let pending = '';
  let buf = emptyBuffer();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (feedLine(buf, line)) {
          const ev = toEvent(buf);
          buf = emptyBuffer();
          if (ev) yield ev;
        }
        nl = pending.indexOf('\n');
      }
    }

    // 流结束：冲刷解码器与剩余不完整行（有些实现不发结尾空行）
    pending += decoder.decode();
    if (pending !== '') {
      feedLine(buf, pending);
      pending = '';
    }
    const ev = toEvent(buf);
    if (ev) yield ev;
  } finally {
    // 提前 break（如 [DONE]）时释放上游连接
    reader.cancel().catch(() => undefined);
  }
}
