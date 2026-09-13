import type { Part, PromptIR, Role, Segment } from '@newtavern/core';

/**
 * PromptIR.segments → 扁平消息列表。各适配器共用，之后再各自渲染为原生 content 块。
 */

export interface ChatMessage {
  role: Role;
  parts: Part[];
  /** 该消息（合并后）包含 cachePlan 断点所指的段 */
  cacheBreakpoint?: boolean;
  /** 组成这条消息的段 id，供检查器 diff */
  segmentIds: string[];
}

export interface SystemBlock {
  parts: Part[];
  cacheBreakpoint?: boolean;
  segmentIds: string[];
}

export interface IrToChatMessagesOptions {
  /** 合并相邻同角色（默认 true） */
  mergeSameRole?: boolean;
  /** 合并时相邻文本块的连接符（默认 '\n\n'） */
  joiner?: string;
  /** 'top'：把开头连续的 system 段抽为 systemBlocks；'inline'：全部留在 messages（默认 'inline'） */
  systemPlacement?: 'top' | 'inline';
  /** 末尾不是 user 时追加一条（默认 false） */
  ensureLastUser?: boolean;
  lastUserFallback?: string;
}

export interface IrToChatMessagesResult {
  /** systemPlacement==='top' 时抽出的顶层 system 文本块；'inline' 时为空数组 */
  systemBlocks: SystemBlock[];
  messages: ChatMessage[];
}

const DEFAULT_JOINER = '\n\n';
const DEFAULT_LAST_USER = '[Continue]';

function isTextPart(p: Part | undefined): p is { type: 'text'; text: string } {
  return p !== undefined && p.type === 'text';
}

/** 把 `next` 的 parts 并入 `into`：相接处若都是文本则用 joiner 连接 */
function appendParts(into: Part[], next: readonly Part[], joiner: string): void {
  for (const part of next) {
    const last = into[into.length - 1];
    if (isTextPart(last) && isTextPart(part)) {
      into[into.length - 1] = { type: 'text', text: `${last.text}${joiner}${part.text}` };
    } else {
      into.push(part);
    }
  }
}

/** 合并相邻同角色消息（角色映射之后仍可复用） */
export function mergeAdjacentSameRole(
  messages: readonly ChatMessage[],
  joiner: string = DEFAULT_JOINER,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const msg of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role) {
      appendParts(prev.parts, msg.parts, joiner);
      prev.segmentIds.push(...msg.segmentIds);
      if (msg.cacheBreakpoint) prev.cacheBreakpoint = true;
    } else {
      out.push({
        role: msg.role,
        parts: [...msg.parts],
        segmentIds: [...msg.segmentIds],
        ...(msg.cacheBreakpoint ? { cacheBreakpoint: true } : {}),
      });
    }
  }
  return out;
}

function isTopSystem(seg: Segment): boolean {
  return seg.role === 'system' && seg.anchor.slot === 'system';
}

/**
 * 把 IR 拉平为消息列表。纯函数，不读环境。
 *
 * 与契约 §1.1 的唯一差异：返回 `{ systemBlocks, messages }` 而不是裸 `ChatMessage[]`，
 * 否则 systemPlacement==='top' 抽出的 system 块无处安放。
 */
export function irToChatMessages(
  ir: PromptIR,
  opts: IrToChatMessagesOptions = {},
): IrToChatMessagesResult {
  const joiner = opts.joiner ?? DEFAULT_JOINER;
  const mergeSameRole = opts.mergeSameRole ?? true;
  const systemPlacement = opts.systemPlacement ?? 'inline';

  const breakpointIds = new Set<string>();
  for (const idx of ir.cachePlan?.breakpoints ?? []) {
    const seg = ir.segments[idx];
    if (seg) breakpointIds.add(seg.id);
  }

  // 1. 开头连续的 system 段（仅 'top' 模式）
  let cut = 0;
  if (systemPlacement === 'top') {
    while (cut < ir.segments.length) {
      const seg = ir.segments[cut];
      if (!seg || !isTopSystem(seg)) break;
      cut += 1;
    }
  }

  const systemSegments = ir.segments.slice(0, cut);
  const bodySegments = ir.segments.slice(cut);

  const systemBlocks: SystemBlock[] = systemSegments.map((seg) => ({
    parts: [...seg.parts],
    segmentIds: [seg.id],
    ...(breakpointIds.has(seg.id) ? { cacheBreakpoint: true } : {}),
  }));

  let messages: ChatMessage[] = bodySegments.map((seg) => ({
    role: seg.role,
    parts: [...seg.parts],
    segmentIds: [seg.id],
    ...(breakpointIds.has(seg.id) ? { cacheBreakpoint: true } : {}),
  }));

  if (mergeSameRole) messages = mergeAdjacentSameRole(messages, joiner);

  // 2. 末尾必须是 user
  if (opts.ensureLastUser) {
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'user') {
      messages.push({
        role: 'user',
        parts: [{ type: 'text', text: opts.lastUserFallback ?? DEFAULT_LAST_USER }],
        segmentIds: [],
      });
    }
  }

  return { systemBlocks, messages };
}

/** 取出一条消息里的纯文本（丢弃图片等），用于降级渲染 */
export function partsToText(parts: readonly Part[], joiner = '\n'): string {
  return parts
    .filter(isTextPart)
    .map((p) => p.text)
    .join(joiner);
}
