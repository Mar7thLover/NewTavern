import { childrenOf, linearizePath, substituteMacros } from '@newtavern/core';

import { nodeText, type MessageNode, type Usage } from '../../lib/api';

/* ------------------------------------------------------------------ */
/* 时间                                                                 */
/* ------------------------------------------------------------------ */

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
];

/** 会话列表用的相对时间：一周内相对表述，更早显示日期。中英文由 Intl 处理。 */
export function formatRelativeTime(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const seconds = (date.getTime() - Date.now()) / 1000;
  const abs = Math.abs(seconds);
  if (abs >= 7 * 86_400) {
    const now = new Date();
    return date.toLocaleDateString(language, {
      year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
      month: 'numeric',
      day: 'numeric',
    });
  }
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (abs < 45) return formatter.format(0, 'second');
  for (const [unit, size] of RELATIVE_UNITS) {
    if (abs >= size) return formatter.format(Math.round(seconds / size), unit);
  }
  return formatter.format(Math.round(seconds / 60), 'minute');
}

/** 消息头部的时刻（只到分钟） */
export function formatClock(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(language, {
    hour: '2-digit',
    minute: '2-digit',
    ...(sameDay ? {} : { month: 'numeric', day: 'numeric' }),
  });
}

/* ------------------------------------------------------------------ */
/* 消息树                                                               */
/* ------------------------------------------------------------------ */

export function toNodeMap(nodes: readonly MessageNode[]): Map<string, MessageNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

/** root→head 的线性路径；树损坏（缺节点 / 成环）时退回空数组而不是炸掉整页 */
export function pathToHead(
  nodes: readonly MessageNode[],
  headNodeId: string | null,
): MessageNode[] {
  if (!headNodeId) return [];
  try {
    return linearizePath(toNodeMap(nodes), headNodeId);
  } catch {
    return [];
  }
}

/** 沿「siblingSeq 最大的子节点」下钻到叶子：切换兄弟时新的 head */
export function deepestLeaf(nodes: readonly MessageNode[], startId: string): string {
  let current = startId;
  const seen = new Set<string>([current]);
  for (;;) {
    const children = childrenOf(nodes, current);
    const next = children[children.length - 1];
    if (!next || seen.has(next.id)) return current;
    seen.add(next.id);
    current = next.id;
  }
}

export interface SiblingInfo {
  siblings: MessageNode[];
  index: number;
  /** 兄弟中存在有后代的（即已分叉，不只是 swipe） */
  branched: boolean;
}

export function siblingInfo(nodes: readonly MessageNode[], node: MessageNode): SiblingInfo {
  const siblings = childrenOf(nodes, node.parentId);
  return {
    siblings,
    index: siblings.findIndex((item) => item.id === node.id),
    branched: siblings.some((item) => childrenOf(nodes, item.id).length > 0),
  };
}

/* ------------------------------------------------------------------ */
/* 用量                                                                 */
/* ------------------------------------------------------------------ */

export const EMPTY_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
};

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
  };
}

/** 当前路径上全部节点的用量之和 */
export function sumUsage(nodes: readonly MessageNode[]): Usage {
  return nodes.reduce((total, node) => (node.usage ? addUsage(total, node.usage) : total), {
    ...EMPTY_USAGE,
  });
}

export function totalInput(usage: Usage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

export function isUsageEmpty(usage: Usage): boolean {
  return totalInput(usage) === 0 && usage.output === 0;
}

/** 大数字紧凑显示（1.2k / 34.5k） */
export function formatTokens(value: number, language: string): string {
  return new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

/* ------------------------------------------------------------------ */
/* 文本                                                                 */
/* ------------------------------------------------------------------ */

export function previewOf(node: MessageNode | undefined, limit = 120): string {
  if (!node) return '';
  return nodeText(node).replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * 展示用的宏替换：角色描述摘要、会话预览里的 `{{char}}` / `{{user}}` 不该原样露出来。
 * 只做展示，组装提示词时的宏由 `@newtavern/core` 在服务端处理。
 */
export function renderMacros(
  text: string,
  charName: string | null | undefined,
  userName: string,
): string {
  if (!text) return '';
  return substituteMacros(text, { char: charName ?? userName, user: userName });
}
