import { childrenOf, linearizePath, type Part } from '@newtavern/core';
import { asc, eq, inArray, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';

/**
 * 消息树读写。见 docs/M2-CONTRACT.md §3.4。
 * 纯函数部分（子树、兄弟序号）与 DB 封装放在一起，路由只调用本模块。
 */

export type ChatRow = typeof schema.chats.$inferSelect;
export type NodeRow = typeof schema.messageNodes.$inferSelect;

export type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
};

export type NodeReasoning = {
  text?: string;
  opaque?: unknown[];
};

export interface MessageNode {
  id: string;
  chatId: string;
  parentId: string | null;
  siblingSeq: number;
  role: 'user' | 'assistant' | 'system';
  name: string | null;
  parts: Part[];
  reasoning: NodeReasoning | null;
  usage: Usage | null;
  provider: string | null;
  model: string | null;
  isHidden: boolean;
  extra: Record<string, unknown> | null;
  createdAt: Date;
}

export type ChatOverrides = {
  connectionId?: string | null;
  model?: string | null;
  sampling?: Record<string, unknown>;
  /** 推理控制，形状同 providers `ThinkingOptions`；`enabled:false` = 关闭；缺省 = 跟随预设 */
  thinking?: { enabled?: boolean; effort?: string; budgetTokens?: number };
  layoutMode?: 'strict' | 'cache-aware';
  /** 全局系统提示词的会话覆盖（契约 §3.4） */
  globalSystemPrompt?: {
    enabled?: boolean;
    text?: string;
    position?: 'before_main' | 'after_main';
  } | null;
};

export interface ChatSummary {
  id: string;
  title: string;
  mode: ChatRow['mode'];
  characterIds: string[];
  personaId: string | null;
  presetId: string | null;
  overrides: ChatOverrides | null;
  rootNodeId: string | null;
  headNodeId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  character: { id: string; name: string; avatarAssetId: string | null } | null;
  /** 聊天绑定的世界书（chat_lorebooks，契约 §3.3） */
  lorebookIds: string[];
  messageCount: number;
  lastMessageAt: Date | null;
  preview: string | null;
}

export interface ChatDetail extends ChatSummary {
  nodes: MessageNode[];
}

const PREVIEW_LENGTH = 120;

export function toMessageNode(row: NodeRow): MessageNode {
  return {
    id: row.id,
    chatId: row.chatId,
    parentId: row.parentId,
    siblingSeq: row.siblingSeq,
    role: row.role,
    name: row.name,
    parts: (row.parts as Part[] | null) ?? [],
    reasoning: (row.reasoning as NodeReasoning | null) ?? null,
    usage: (row.usage as Usage | null) ?? null,
    provider: row.provider,
    model: row.model,
    isHidden: row.isHidden,
    extra: row.extra ?? null,
    createdAt: row.createdAt,
  };
}

/** 节点的纯文本（拼接全部 text part） */
export function textOfParts(parts: Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

export function loadChat(db: Db, chatId: string): ChatRow | undefined {
  return db.select().from(schema.chats).where(eq(schema.chats.id, chatId)).get();
}

export function loadNodes(db: Db, chatId: string): NodeRow[] {
  return db
    .select()
    .from(schema.messageNodes)
    .where(eq(schema.messageNodes.chatId, chatId))
    .all()
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.siblingSeq - b.siblingSeq);
}

/** 节点自身 + 全部后代的 id（广度优先，纯函数） */
export function subtreeIds(nodes: readonly NodeRow[], rootId: string): string[] {
  const byParent = new Map<string, NodeRow[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const bucket = byParent.get(node.parentId);
    if (bucket) bucket.push(node);
    else byParent.set(node.parentId, [node]);
  }
  const ids: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (ids.includes(current)) continue;
    ids.push(current);
    for (const child of byParent.get(current) ?? []) queue.push(child.id);
  }
  return ids;
}

/** 同父节点下一个 siblingSeq */
export function nextSiblingSeq(nodes: readonly NodeRow[], parentId: string | null): number {
  const siblings = childrenOf(nodes, parentId);
  const last = siblings[siblings.length - 1];
  return last ? last.siblingSeq + 1 : 0;
}

/** root→nodeId 的线性化路径（含两端） */
export function pathToNode(nodes: readonly NodeRow[], nodeId: string): NodeRow[] {
  const map = new Map(nodes.map((node) => [node.id, node]));
  return linearizePath(map, nodeId);
}

/** 聊天绑定的世界书 id（按插入顺序：rowid 排序，否则会退化成唯一索引的 bookId 序） */
export function readChatLorebookIds(db: Db, chatId: string): string[] {
  return db
    .select({ bookId: schema.chatLorebooks.bookId })
    .from(schema.chatLorebooks)
    .where(eq(schema.chatLorebooks.chatId, chatId))
    .orderBy(asc(sql`rowid`))
    .all()
    .map((row) => row.bookId);
}

/** 全量替换聊天世界书绑定（去重、保持传入顺序） */
export function setChatLorebooks(db: Db, chatId: string, bookIds: readonly string[]): string[] {
  const unique = [...new Set(bookIds)];
  db.delete(schema.chatLorebooks).where(eq(schema.chatLorebooks.chatId, chatId)).run();
  for (const bookId of unique) {
    db.insert(schema.chatLorebooks).values({ chatId, bookId }).run();
  }
  return unique;
}

export function toChatSummary(db: Db, chat: ChatRow, nodes?: readonly NodeRow[]): ChatSummary {
  const all = nodes ?? loadNodes(db, chat.id);
  const head = chat.headNodeId ? all.find((node) => node.id === chat.headNodeId) : undefined;
  const lastMessageAt = all.reduce<Date | null>(
    (latest, node) => (latest === null || node.createdAt > latest ? node.createdAt : latest),
    null,
  );
  const characterId = chat.characterIds[0];
  const characterRow = characterId
    ? db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()
    : undefined;
  const previewText = head ? textOfParts((head.parts as Part[] | null) ?? []).trim() : '';
  return {
    id: chat.id,
    title: chat.title,
    mode: chat.mode,
    characterIds: chat.characterIds,
    personaId: chat.personaId,
    presetId: chat.presetId,
    overrides: (chat.overrides as ChatOverrides | null) ?? null,
    rootNodeId: chat.rootNodeId,
    headNodeId: chat.headNodeId,
    metadata: chat.metadata ?? null,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    character: characterRow
      ? {
          id: characterRow.id,
          name: characterRow.name,
          avatarAssetId: characterRow.avatarAssetId,
        }
      : null,
    lorebookIds: readChatLorebookIds(db, chat.id),
    messageCount: all.length,
    lastMessageAt,
    preview: previewText ? previewText.slice(0, PREVIEW_LENGTH) : null,
  };
}

export function toChatDetail(db: Db, chat: ChatRow): ChatDetail {
  const nodes = loadNodes(db, chat.id);
  return { ...toChatSummary(db, chat, nodes), nodes: nodes.map(toMessageNode) };
}

export interface InsertNodeInput {
  chatId: string;
  parentId: string | null;
  role: 'user' | 'assistant' | 'system';
  parts: Part[];
  name?: string | null;
  siblingSeq?: number;
  provider?: string | null;
  model?: string | null;
  extra?: Record<string, unknown> | null;
  /** WI 时间态快照（契约 §3.5；swipe / 重生从父节点恢复） */
  wiState?: Record<string, unknown> | null;
  /** chat 作用域变量的完整快照 */
  variables?: Record<string, unknown> | null;
}

export function insertNode(db: Db, input: InsertNodeInput): NodeRow {
  const seq = input.siblingSeq ?? nextSiblingSeq(loadNodes(db, input.chatId), input.parentId);
  return db
    .insert(schema.messageNodes)
    .values({
      chatId: input.chatId,
      parentId: input.parentId,
      siblingSeq: seq,
      role: input.role,
      name: input.name ?? null,
      parts: input.parts,
      provider: input.provider ?? null,
      model: input.model ?? null,
      extra: input.extra ?? null,
      wiState: input.wiState ?? null,
      variables: input.variables ?? null,
    })
    .returning()
    .get();
}

/** 更新聊天（顺带刷新 updatedAt） */
export function patchChat(db: Db, chatId: string, patch: Partial<ChatRow>): ChatRow {
  return db
    .update(schema.chats)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.chats.id, chatId))
    .returning()
    .get();
}

/**
 * 清除节点自身与全部后代的 `reasoning.opaque`。
 * 见 docs/PLAN.md §3.1「推理内容持久化」：编辑历史消息后下游推理块不再有效。
 */
export function clearOpaqueSubtree(db: Db, chatId: string, nodeId: string): void {
  const nodes = loadNodes(db, chatId);
  const ids = new Set(subtreeIds(nodes, nodeId));
  for (const node of nodes) {
    if (!ids.has(node.id)) continue;
    const reasoning = node.reasoning as NodeReasoning | null;
    if (!reasoning?.opaque) continue;
    const { opaque: _dropped, ...rest } = reasoning;
    const next = Object.keys(rest).length > 0 ? rest : null;
    db.update(schema.messageNodes)
      .set({ reasoning: next })
      .where(eq(schema.messageNodes.id, node.id))
      .run();
  }
}

/**
 * 删除子树并修正 root/head。
 * head 在子树内 → 回退到被删节点的 parentId；删的是根 → root/head 取剩余的根级兄弟或 null。
 */
export function deleteSubtree(db: Db, chat: ChatRow, nodeId: string): ChatRow | undefined {
  const nodes = loadNodes(db, chat.id);
  const target = nodes.find((node) => node.id === nodeId);
  if (!target) return undefined;
  const ids = subtreeIds(nodes, nodeId);
  db.delete(schema.messageNodes).where(inArray(schema.messageNodes.id, ids)).run();

  const removed = new Set(ids);
  const remaining = nodes.filter((node) => !removed.has(node.id));
  const patch: Partial<ChatRow> = {};
  if (chat.rootNodeId !== null && removed.has(chat.rootNodeId)) {
    patch.rootNodeId = childrenOf(remaining, null)[0]?.id ?? null;
  }
  if (chat.headNodeId !== null && removed.has(chat.headNodeId)) {
    patch.headNodeId =
      target.parentId ?? (patch.rootNodeId !== undefined ? patch.rootNodeId : chat.rootNodeId);
  }
  return patchChat(db, chat.id, patch);
}
