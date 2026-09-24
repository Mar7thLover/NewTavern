import type { StudioPatchOp } from '../types';
import type { AssistEvent, AssistMode, AssistUsage } from './api';

/*
 * 协作对话的状态（纯函数，单测直接测）：一轮 = 用户指令 + 模型的文字 / 推理 / 工具调用 + 补丁卡。
 */

export type AssistItem =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      args: unknown;
      summary: string;
      result?: { ok: boolean; summary: string; content: string };
    };

export type OpDecision = 'pending' | 'accepted' | 'rejected';

export interface AssistTurn {
  id: string;
  instruction: string;
  mode: AssistMode;
  items: AssistItem[];
  /** 本轮改动（整轮结束时到达；可能是空数组） */
  patch: { ops: StudioPatchOp[]; decisions: OpDecision[] } | null;
  usage: AssistUsage | null;
  status: 'running' | 'done' | 'error' | 'aborted';
  error: string | null;
  stopReason: 'end' | 'max_steps' | null;
}

export function newTurn(id: string, instruction: string, mode: AssistMode): AssistTurn {
  return {
    id,
    instruction,
    mode,
    items: [],
    patch: null,
    usage: null,
    status: 'running',
    error: null,
    stopReason: null,
  };
}

/** 把一个 SSE 事件并进这一轮 */
export function applyAssistEvent(turn: AssistTurn, event: AssistEvent): AssistTurn {
  switch (event.type) {
    case 'text':
    case 'reasoning': {
      if (event.delta === '') return turn;
      const last = turn.items[turn.items.length - 1];
      if (last && last.type === event.type) {
        return {
          ...turn,
          items: [...turn.items.slice(0, -1), { ...last, text: last.text + event.delta }],
        };
      }
      return { ...turn, items: [...turn.items, { type: event.type, text: event.delta }] };
    }
    case 'tool':
      return {
        ...turn,
        items: [
          ...turn.items,
          {
            type: 'tool',
            id: event.id,
            name: event.name,
            args: event.args,
            summary: event.summary,
          },
        ],
      };
    case 'tool_result': {
      // 同 id 的最后一次调用
      let index = -1;
      turn.items.forEach((item, i) => {
        if (item.type === 'tool' && item.id === event.id) index = i;
      });
      if (index < 0) return turn;
      const items = [...turn.items];
      const item = items[index] as Extract<AssistItem, { type: 'tool' }>;
      items[index] = {
        ...item,
        result: { ok: event.ok, summary: event.summary, content: event.content },
      };
      return { ...turn, items };
    }
    case 'patch':
      return {
        ...turn,
        patch: { ops: event.ops, decisions: event.ops.map(() => 'pending' as const) },
      };
    case 'usage':
      return { ...turn, usage: event.usage };
    case 'done':
      return { ...turn, status: 'done', stopReason: event.stopReason };
    case 'error':
      return { ...turn, status: 'error', error: event.message || event.kind || 'error' };
  }
}

/** 流结束但没收到 done / error（连接断了）：按出错收尾 */
export function finishTurn(turn: AssistTurn, fallbackError: string): AssistTurn {
  if (turn.status !== 'running') return turn;
  return { ...turn, status: 'error', error: fallbackError };
}

/** 逐条决定；返回新的一轮（只改 pending 的项） */
export function decideOps(
  turn: AssistTurn,
  indexes: readonly number[],
  decision: Exclude<OpDecision, 'pending'>,
): AssistTurn {
  if (!turn.patch) return turn;
  const decisions = [...turn.patch.decisions];
  for (const index of indexes) {
    if (decisions[index] === 'pending') decisions[index] = decision;
  }
  return { ...turn, patch: { ...turn.patch, decisions } };
}

export function pendingIndexes(turn: AssistTurn): number[] {
  if (!turn.patch) return [];
  return turn.patch.decisions.flatMap((decision, index) => (decision === 'pending' ? [index] : []));
}

/** 本轮模型说的话（给下一轮的 conversation） */
export function turnText(turn: AssistTurn): string {
  return turn.items
    .filter((item): item is Extract<AssistItem, { type: 'text' }> => item.type === 'text')
    .map((item) => item.text)
    .join('')
    .trim();
}

/**
 * 之前几轮 → 请求的 `conversation`（纯文本）。模型的回复后面附一句用户对补丁的处理，
 * 免得下一轮它以为改动都已生效。
 */
export function toConversation(
  turns: readonly AssistTurn[],
  describeDecisions: (accepted: number, rejected: number, pending: number) => string,
): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const turn of turns) {
    if (turn.status === 'running') continue;
    let reply = turnText(turn);
    const decisions = turn.patch?.decisions ?? [];
    if (decisions.length > 0) {
      const count = (d: OpDecision) => decisions.filter((item) => item === d).length;
      const note = describeDecisions(count('accepted'), count('rejected'), count('pending'));
      reply = reply ? `${reply}\n\n${note}` : note;
    }
    // 什么都没产出的一轮（开流前就失败等）不进上下文，保持 user / assistant 交替
    if (!reply) continue;
    out.push({ role: 'user', content: turn.instruction });
    out.push({ role: 'assistant', content: reply });
  }
  return out;
}
