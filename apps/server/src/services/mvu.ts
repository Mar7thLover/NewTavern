import { substituteMacros, validateJsonSchema } from '@newtavern/core';
import {
  applyMessage,
  emptyMvuData,
  hasMvuData,
  initializeMvu,
  MVU_EVENTS,
  toMvuData,
  type InitVarBook,
  type MvuData,
  type MvuError,
  type MvuRunResult,
  type MvuUpdate,
} from '@newtavern/compat/mvu';
import { eq, inArray } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import {
  loadNodes,
  pathToNode,
  readChatLorebookIds,
  textOfParts,
  type ChatRow,
  type NodeRow,
} from './chat-tree.js';
import { readGlobalBookIds } from './wi-settings.js';
import { readVariableSchemas } from './chat-injects.js';
import {
  hasMvuCommands,
  requestExtraModelUpdate,
  type MvuExtraModelSettings,
} from './mvu-extra.js';
import type { Part } from '@newtavern/core';

/**
 * MVU 在服务端跑。见 docs/M5-CONTRACT.md §2。
 *
 * 为什么是服务端而不是像原版那样在前端脚本里跑：
 *
 * 1. 变量是**提示词的输入**（`{{get_message_variable::stat_data}}`）。放在浏览器里意味着
 *    「先渲染完前端卡、再由它写回变量、下一轮才生效」，一旦用户在生成后立刻关掉页面，
 *    这一轮的变量更新就丢了。服务端在流式结束的同一个事务里算完写库，不存在这种窗口。
 * 2. 变量按**消息节点**存，swipe / 重生天然从父快照重新起算；重放（`replayFrom`）
 *    也只有服务端能可靠地沿分支路径重算。
 * 3. 前端卡照旧能读写：宿主把节点快照推进 iframe 镜像，`Mvu.parseMessage` 之类
 *    走 RPC 回到这里（`/api/chats/:id/mvu/parse`）。
 *
 * 开关：设置 KV `mvu`（`{ enabled: boolean }`，默认开）。关掉之后变量表照旧可读可写，
 * 只是不再自动解析模型输出里的更新命令。
 */

const MVU_SETTINGS_KEY = 'mvu';

export interface MvuSettings {
  /** 自动解析模型输出里的 `<UpdateVariable>`（默认开） */
  enabled: boolean;
  /** 额外模型解析（M5（三）§3.5）；缺省 = 不用 */
  extraModel?: MvuExtraModelSettings;
  /**
   * 旧楼层快照清理：>0 时每次写入后把当前路径上距 head 超过 N 层的节点快照换成
   * `{ $pruned: true }`。缺省 0 = 不清理。
   */
  keepSnapshots: number;
}

export const DEFAULT_MVU_SETTINGS: MvuSettings = { enabled: true, keepSnapshots: 0 };

/** 被清理掉的快照（占位，读快照时一律跳过它往上找） */
export const PRUNED_SNAPSHOT = { $pruned: true } as const;

export function isPrunedSnapshot(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>).$pruned === true
  );
}

function readExtraModel(value: unknown): MvuExtraModelSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.connectionId !== 'string' || record.connectionId === '') return undefined;
  if (typeof record.model !== 'string' || record.model === '') return undefined;
  return {
    connectionId: record.connectionId,
    model: record.model,
    when: record.when === 'always' ? 'always' : 'missing',
  };
}

export function mergeMvuSettings(value: unknown): MvuSettings {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const extraModel = readExtraModel(record.extraModel);
  const keep = Number(record.keepSnapshots);
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_MVU_SETTINGS.enabled,
    ...(extraModel ? { extraModel } : {}),
    keepSnapshots: Number.isFinite(keep) && keep > 0 ? Math.floor(keep) : 0,
  };
}

export function readMvuSettings(db: Db): MvuSettings {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, MVU_SETTINGS_KEY)).get();
  return mergeMvuSettings(row?.value);
}

/* ------------------------------------------------------------------ */
/* [InitVar]：世界书 → 变量表初始形态                                   */
/* ------------------------------------------------------------------ */

/**
 * 会话能看到的所有世界书（全局 + 聊天 + 角色 + persona）的条目备注与正文。
 * **不过滤 disabled**：`[InitVar]` 条目按社区惯例是禁用的（它不该进提示词），
 * 但 MVU 仍然要读它。
 */
export function loadInitVarBooks(db: Db, chat: ChatRow): InitVarBook[] {
  const ids = visibleBookIds(db, chat);
  if (ids.length === 0) return [];
  return loadBooksByIds(db, ids);
}

/** 会话能看到的世界书 id（全局 → 聊天 → 角色 → persona，去重保序） */
export function visibleBookIds(db: Db, chat: ChatRow): string[] {
  const ids: string[] = [];
  const push = (id: string | null | undefined) => {
    if (id && !ids.includes(id)) ids.push(id);
  };
  for (const id of readGlobalBookIds(db)) push(id);
  for (const id of readChatLorebookIds(db, chat.id)) push(id);
  const characterId = chat.characterIds[0];
  if (characterId) {
    const character = db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.id, characterId))
      .get();
    push(character?.bookId ?? null);
  }
  if (chat.personaId) {
    const persona = db.select().from(schema.personas).where(eq(schema.personas.id, chat.personaId)).get();
    push(persona?.lorebookId ?? null);
  }
  return ids;
}

function loadBooksByIds(db: Db, ids: string[]): InitVarBook[] {
  const books = db.select().from(schema.lorebooks).where(inArray(schema.lorebooks.id, ids)).all();
  const entries = db
    .select({
      bookId: schema.lorebookEntries.bookId,
      comment: schema.lorebookEntries.comment,
      content: schema.lorebookEntries.content,
    })
    .from(schema.lorebookEntries)
    .where(inArray(schema.lorebookEntries.bookId, ids))
    .all();

  const byBook = new Map<string, { comment: string | null; content: string }[]>();
  for (const entry of entries) {
    const bucket = byBook.get(entry.bookId);
    const item = { comment: entry.comment, content: entry.content };
    if (bucket) bucket.push(item);
    else byBook.set(entry.bookId, [item]);
  }

  // 按 ids 的顺序（全局 → 聊天 → 角色 → persona），同名书只算一次
  const seenName = new Set<string>();
  const out: InitVarBook[] = [];
  for (const id of ids) {
    const book = books.find((row) => row.id === id);
    if (!book || seenName.has(book.name)) continue;
    seenName.add(book.name);
    out.push({ name: book.name, entries: byBook.get(id) ?? [] });
  }
  return out;
}

/** `{{user}}` / `{{char}}`：InitVar 与命令值里就用得到这两个，其余宏这里没有上下文 */
function macroSubstituter(db: Db, chat: ChatRow): (text: string) => string {
  const characterId = chat.characterIds[0];
  const character = characterId
    ? db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()
    : undefined;
  const persona = chat.personaId
    ? db.select().from(schema.personas).where(eq(schema.personas.id, chat.personaId)).get()
    : undefined;
  const ctx = { char: character?.name ?? '', user: persona?.name ?? '' };
  return (text: string) => substituteMacros(text, ctx);
}

export interface MvuInitResult {
  /** 初始化之后的变量表（没变化时就是入参） */
  variables: Record<string, unknown>;
  /** 这次吃进去的世界书名 */
  initialized: string[];
  errors: { book: string; comment: string; message: string }[];
}

/**
 * 保证变量表已按 `[InitVar]` 初始化。**纯函数式**：不写库，结果由调用方
 * （generate：写进新建的助手节点快照）落地。
 */
export function ensureMvuInitialized(
  db: Db,
  chat: ChatRow,
  base: Record<string, unknown>,
): MvuInitResult {
  const books = loadInitVarBooks(db, chat);
  if (books.length === 0) return { variables: base, initialized: [], errors: [] };
  const result = initializeMvu(base, books, { substituteMacros: macroSubstituter(db, chat) });
  if (result.initialized.length === 0 && result.errors.length === 0) {
    return { variables: base, initialized: [], errors: [] };
  }
  return {
    variables: result.data as unknown as Record<string, unknown>,
    initialized: result.initialized,
    errors: result.errors,
  };
}

/* ------------------------------------------------------------------ */
/* 解析模型输出                                                        */
/* ------------------------------------------------------------------ */

/** 一次节点级更新的结果（SSE `variables` 事件的载荷） */
export interface MvuNodeResult {
  nodeId: string;
  changed: boolean;
  variables: Record<string, unknown>;
  updates: MvuUpdate[];
  errors: MvuError[];
  /** 本次是由哪些世界书初始化来的（只有第一轮非空） */
  initialized?: string[];
  /** 更新从哪来：模型正文 / 额外模型（M5（三）§3.5） */
  source?: 'message' | 'extra-model';
  /** registerVariableSchema 的校验问题（不回滚，只提示） */
  warnings?: string[];
}

function toRecord(data: MvuData): Record<string, unknown> {
  return data as unknown as Record<string, unknown>;
}

/** 在给定变量表上跑一遍消息（不写库），供 `Mvu.parseMessage` 用 */
export function parseMvuMessage(
  db: Db,
  chat: ChatRow,
  base: Record<string, unknown>,
  message: string,
): MvuRunResult {
  return applyMessage(toMvuData(base), message, {
    substituteMacros: macroSubstituter(db, chat),
  });
}

/** 该节点自己的快照；没有就沿路径往上找最近的一份（user 节点没有快照） */
function baseSnapshotFor(db: Db, chat: ChatRow, node: NodeRow): Record<string, unknown> {
  if (node.variables && !isPrunedSnapshot(node.variables)) return node.variables;
  const nodes = loadNodes(db, chat.id);
  const byId = new Map(nodes.map((row) => [row.id, row]));
  let cursor = node.parentId ? byId.get(node.parentId) : undefined;
  while (cursor) {
    // 清理掉的旧快照不能当起点：继续往上找最近的一份完整快照
    if (cursor.variables && !isPrunedSnapshot(cursor.variables)) return cursor.variables;
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return {};
}

/**
 * 助手节点生成完成后跑一遍：从**该节点自己的快照**（= 生成前的状态）出发应用命令，
 * 结果写回同一个节点。父快照不动，所以重生 / swipe 天然从同一起点开始。
 *
 * 也是「重新处理变量」按钮的入口。那条路上节点可能压根没有快照
 * （比如手工插入的消息、或者绑世界书之前的老对话），所以这里**先补一次
 * `[InitVar]` 初始化**再应用命令——不然每条命令都会撞上「路径不存在」。
 */
export function runMvuForNode(
  db: Db,
  chat: ChatRow,
  node: NodeRow,
  text: string,
): MvuNodeResult | null {
  if (!readMvuSettings(db).enabled) return null;
  const init = ensureMvuInitialized(db, chat, baseSnapshotFor(db, chat, node));
  const base = init.variables;
  // 没有 stat_data 也可能有 <UpdateVariable>（模型抢跑）——照常解析，报错会记下来
  const result = parseMvuMessage(db, chat, base, text);
  const initialized = init.initialized;
  if (!result.changed && result.errors.length === 0 && initialized.length === 0) return null;
  const variables = toRecord(result.data);
  if (result.changed || initialized.length > 0) {
    db.update(schema.messageNodes)
      .set({ variables })
      .where(eq(schema.messageNodes.id, node.id))
      .run();
  }
  return {
    nodeId: node.id,
    changed: result.changed,
    variables,
    updates: result.updates,
    errors: result.errors,
    ...(initialized.length > 0 ? { initialized } : {}),
  };
}

/** 替换某个节点的变量快照（前端卡 `replaceVariables({type:'message'})`） */
export function writeNodeVariables(
  db: Db,
  nodeId: string,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  db.update(schema.messageNodes).set({ variables }).where(eq(schema.messageNodes.id, nodeId)).run();
  return variables;
}

/**
 * 从某个节点起沿当前 head 路径重算变量（MVU 的「重演楼层」）。
 *
 * 用在：编辑了历史消息的正文、手改了变量、或换了 `[InitVar]` 之后。
 * 起点节点的**父快照**是重算的基准；路径上每个助手节点依次重新应用自己的正文。
 */
export function replayMvuFrom(db: Db, chat: ChatRow, fromNodeId: string | null): MvuNodeResult[] {
  const nodes = loadNodes(db, chat.id);
  const headId = chat.headNodeId;
  if (!headId) return [];
  const path = pathToNode(nodes, headId);
  const startIndex = fromNodeId ? path.findIndex((node) => node.id === fromNodeId) : 0;
  if (startIndex === -1) return [];

  // 基准：起点之前最近的一份快照
  let current: Record<string, unknown> = {};
  /** 起点之前遇到过被清理的快照：重算的起点比用户以为的更早，要提示 */
  let skippedPruned = false;
  for (let i = startIndex - 1; i >= 0; i -= 1) {
    const snapshot = path[i]?.variables;
    if (snapshot && isPrunedSnapshot(snapshot)) {
      skippedPruned = true;
      continue;
    }
    if (snapshot) {
      current = snapshot;
      break;
    }
  }
  if (!hasMvuData(current)) {
    current = toRecord({ ...emptyMvuData(), ...toMvuData(current) });
  }
  const init = ensureMvuInitialized(db, chat, current);
  current = init.variables;

  const substitute = macroSubstituter(db, chat);
  const out: MvuNodeResult[] = [];
  for (let i = startIndex; i < path.length; i += 1) {
    const node = path[i];
    if (!node || node.role !== 'assistant') continue;
    const text = textOfParts((node.parts as Part[] | null) ?? []);
    const result = applyMessage(toMvuData(current), text, { substituteMacros: substitute });
    const variables = toRecord(result.data);
    db.update(schema.messageNodes)
      .set({ variables })
      .where(eq(schema.messageNodes.id, node.id))
      .run();
    current = variables;
    out.push({
      nodeId: node.id,
      changed: result.changed,
      variables,
      updates: result.updates,
      errors: result.errors,
      ...(i === startIndex && init.initialized.length > 0 ? { initialized: init.initialized } : {}),
      ...(out.length === 0 && skippedPruned
        ? { warnings: ['起点之前的旧快照已被清理，从更早的完整快照（或 [InitVar] 初始值）起算'] }
        : {}),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* M5（三）§3.5：额外模型解析、旧快照清理、schema 校验                   */
/* ------------------------------------------------------------------ */

/**
 * 一轮生成结束后的 MVU 总入口（chats 路由调它）：
 *
 * 1. 设置了额外模型且（`when='always'`，或 `when='missing'` 且正文里没有更新命令）→
 *    请求额外模型写一段 `<UpdateVariable>`，用它代替正文去跑引擎，节点 `extra.mvuSource='extra-model'`；
 *    额外模型失败时退回正文（`missing` 下正文里本来就没有命令，等于没更新），错误记进 errors；
 * 2. 否则照旧解析正文；
 * 3. 写入后按 `keepSnapshots` 清理旧快照；
 * 4. 会话注册过 message 作用域的 schema 时校验结果，问题写进节点 `extra.mvuWarnings`（不回滚）。
 */
export async function runMvuAfterGeneration(
  db: Db,
  chat: ChatRow,
  node: NodeRow,
  text: string,
): Promise<MvuNodeResult | null> {
  const settings = readMvuSettings(db);
  if (!settings.enabled) return null;
  const extra = settings.extraModel;
  const useExtra = extra !== undefined && (extra.when === 'always' || !hasMvuCommands(text));

  let result: MvuNodeResult | null;
  if (useExtra) {
    const init = ensureMvuInitialized(db, chat, baseSnapshotFor(db, chat, node));
    const reply = await requestExtraModelUpdate(db, chat, extra, {
      variables: init.variables,
      text,
      bookIds: visibleBookIds(db, chat),
    });
    if ('error' in reply) {
      result = runMvuForNode(db, chat, node, extra.when === 'always' ? '' : text);
      const error = { command: '[额外模型]', message: reply.error };
      result = result
        ? { ...result, errors: [...result.errors, error] }
        : {
            nodeId: node.id,
            changed: false,
            variables: node.variables ?? init.variables,
            updates: [],
            errors: [error],
          };
    } else {
      result = runMvuForNode(db, chat, node, reply.text);
      if (result) result = { ...result, source: 'extra-model' };
      markNodeExtra(db, node.id, { mvuSource: 'extra-model' });
    }
  } else {
    result = runMvuForNode(db, chat, node, text);
    if (result) result = { ...result, source: 'message' };
  }

  if (result) {
    const warnings = validateAgainstSchema(chat, result.variables);
    if (warnings.length > 0) {
      markNodeExtra(db, node.id, { mvuWarnings: warnings });
      result = { ...result, warnings };
    }
  }
  pruneSnapshots(db, chat.id, settings.keepSnapshots);
  return result;
}

/** 合并写节点 `extra`（不覆盖别的字段） */
function markNodeExtra(db: Db, nodeId: string, patch: Record<string, unknown>): void {
  const row = db
    .select({ extra: schema.messageNodes.extra })
    .from(schema.messageNodes)
    .where(eq(schema.messageNodes.id, nodeId))
    .get();
  db.update(schema.messageNodes)
    .set({ extra: { ...(row?.extra ?? {}), ...patch } })
    .where(eq(schema.messageNodes.id, nodeId))
    .run();
}

/** message 作用域 schema 校验（registerVariableSchema，M5（三）§1） */
export function validateAgainstSchema(
  chat: Pick<ChatRow, 'metadata'>,
  variables: Record<string, unknown>,
): string[] {
  const messageSchema = readVariableSchemas(chat).message;
  if (!messageSchema) return [];
  return validateJsonSchema(variables, messageSchema).map(
    (issue) => `${issue.path === '' ? '(根)' : issue.path}：${issue.message}`,
  );
}

/**
 * 旧楼层快照清理（`mvu.keepSnapshots`）：当前 head 路径上距 head 超过 N 层的节点，
 * 快照换成 `{ $pruned: true }`。只动当前路径（别的分支上的快照留着，切回去还能用）。
 * 返回清理了几个节点。
 */
export function pruneSnapshots(db: Db, chatId: string, keep: number): number {
  if (!(keep > 0)) return 0;
  const chat = db.select().from(schema.chats).where(eq(schema.chats.id, chatId)).get();
  if (!chat?.headNodeId) return 0;
  const path = pathToNode(loadNodes(db, chatId), chat.headNodeId);
  const cutoff = path.length - 1 - keep;
  let pruned = 0;
  for (let i = 0; i < cutoff; i += 1) {
    const node = path[i];
    if (!node?.variables || isPrunedSnapshot(node.variables)) continue;
    db.update(schema.messageNodes)
      .set({ variables: { ...PRUNED_SNAPSHOT } })
      .where(eq(schema.messageNodes.id, node.id))
      .run();
    pruned += 1;
  }
  return pruned;
}

export { MVU_EVENTS };
