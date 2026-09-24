import type { StudioKind } from '../../../lib/api-studio';
import { parseSseStream, type SseMessage } from '../../chat/useGeneration';
import type { StudioPatchOp } from '../types';

/*
 * AI 协作者的请求与 SSE 解析（M6 §3.1；实际形态以 §6「修正（ST-assist）」为准）。
 * `POST /api/studio/assist`：请求校验失败 / 实体不存在 / 没有连接在开流前以 JSON 400 / 404 返回；
 * 正常结束 patch → usage → done，上游出错 patch → usage → error（不发 done，patch 仍可接受）。
 */

export type AssistMode = 'edit' | 'generate';

export interface AssistRequest {
  connectionId?: string;
  model?: string;
  target: { kind: StudioKind; id?: string };
  draft: Record<string, unknown>;
  conversation: { role: 'user' | 'assistant'; content: string }[];
  instruction: string;
  mode: AssistMode;
  testChatId?: string;
  lang: 'zh-CN' | 'en';
}

export interface AssistUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export type AssistEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool'; id: string; name: string; args: unknown; summary: string }
  | { type: 'tool_result'; id: string; ok: boolean; summary: string; content: string }
  | { type: 'patch'; ops: StudioPatchOp[] }
  | { type: 'usage'; usage: AssistUsage }
  | { type: 'done'; steps: number; stopReason: 'end' | 'max_steps' }
  | { type: 'error'; message: string; kind?: string };

/** 开流前的 HTTP 错误（400 / 404 等） */
export class AssistHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'AssistHttpError';
  }
}

type Json = Record<string, unknown>;

function parseJson(raw: string): Json | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Json)
      : null;
  } catch {
    return null;
  }
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** 一条 SSE 消息 → 协作事件；认不出的事件返回 null（忽略） */
export function toAssistEvent(message: SseMessage): AssistEvent | null {
  const data = parseJson(message.data);
  if (!data) return null;
  switch (message.event) {
    case 'text':
    case 'reasoning':
      return { type: message.event, delta: str(data.delta) };
    case 'tool':
      return {
        type: 'tool',
        id: str(data.id),
        name: str(data.name),
        args: data.args,
        summary: str(data.summary),
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        id: str(data.id),
        ok: data.ok === true,
        summary: str(data.summary),
        content: str(data.content),
      };
    case 'patch':
      return {
        type: 'patch',
        ops: (Array.isArray(data.ops) ? data.ops : []).filter(
          (op): op is StudioPatchOp =>
            typeof op === 'object' &&
            op !== null &&
            ['set', 'add_entry', 'update_entry', 'delete_entry'].includes(
              (op as Json).op as string,
            ),
        ),
      };
    case 'usage':
      return {
        type: 'usage',
        usage: {
          input: num(data.input),
          output: num(data.output),
          cacheRead: num(data.cacheRead),
          cacheWrite: num(data.cacheWrite),
          reasoning: num(data.reasoning),
        },
      };
    case 'done':
      return {
        type: 'done',
        steps: num(data.steps),
        stopReason: data.stopReason === 'max_steps' ? 'max_steps' : 'end',
      };
    case 'error':
      return {
        type: 'error',
        message: str(data.message),
        ...(typeof data.kind === 'string' ? { kind: data.kind } : {}),
      };
    default:
      return null;
  }
}

/** 发起一轮协作，逐个产出事件；HTTP 错误抛 AssistHttpError，中止时抛 AbortError */
export async function* streamAssist(
  request: AssistRequest,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): AsyncGenerator<AssistEvent> {
  const response = await fetcher('/api/studio/assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = parseJson(await response.text().catch(() => ''));
    throw new AssistHttpError(
      str(body?.message) || str(body?.error) || `HTTP ${response.status}`,
      response.status,
      typeof body?.error === 'string' ? body.error : undefined,
    );
  }
  for await (const message of parseSseStream(response.body)) {
    const event = toAssistEvent(message);
    if (event) yield event;
  }
}
