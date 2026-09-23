import type { AssembleExtraInjection } from '@newtavern/core';

import type { Db } from '../db/client.js';
import { loadChat, patchChat, type ChatRow } from './chat-tree.js';

/**
 * 会话级的临时注入与变量 schema，都存在 `chats.metadata` 里。见 M5（三）契约 §1 / §3.2。
 *
 * - `metadata.injects`：酒馆助手 `injectPrompts(prompts, { once })` 与 slash `/inject` 共用的存储。
 *   组装时并进 `AssembleInputV2.extraInjections`；`once:true` 的在**下一次生成成功后**删掉
 *   （酒馆助手是在 `GENERATION_ENDED` / `GENERATION_STOPPED` 时 uninject；新酒馆的停止不删，
 *   见契约第二部分 §5 的修正）。
 * - `metadata.variableSchemas[type]`：`registerVariableSchema` 交上来的 JSON Schema（guest 端从 zod 转）。
 *
 * 为什么存会话而不是只放在前端内存：酒馆助手的注入「仅在当前聊天文件中有效」，
 * 而新酒馆的生成在服务端组装——注入必须在服务端看得见；顺带刷新页面也不丢。
 */

export interface StoredInject extends AssembleExtraInjection {
  /** 下一次生成成功后删除 */
  once?: boolean;
}

export type SchemaScope = 'message' | 'chat' | 'character' | 'global' | 'preset' | 'script';

const SCHEMA_SCOPES: readonly SchemaScope[] = ['message', 'chat', 'character', 'global', 'preset', 'script'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 一条注入的规范化（酒馆助手的字段名与新酒馆的字段名都认） */
export function normalizeInject(raw: unknown, fallbackId: string): StoredInject | null {
  if (!isRecord(raw)) return null;
  const content = typeof raw.content === 'string' ? raw.content : '';
  const role = raw.role === 'user' || raw.role === 'assistant' ? raw.role : 'system';
  const position = raw.position === 'none' ? 'none' : 'in_chat';
  const depthRaw = Number(raw.depth ?? 0);
  const depth = Number.isFinite(depthRaw) ? Math.max(0, Math.trunc(depthRaw)) : 0;
  const scanRaw = raw.should_scan ?? raw.scan;
  const orderRaw = Number(raw.order);
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : fallbackId;
  return {
    id,
    content,
    role,
    position,
    depth,
    ...(Number.isFinite(orderRaw) ? { order: orderRaw } : {}),
    scan: scanRaw === true,
    ...(raw.once === true ? { once: true } : {}),
  };
}

export function readChatInjects(chat: Pick<ChatRow, 'metadata'>): StoredInject[] {
  const raw = (chat.metadata ?? {})['injects'];
  if (!Array.isArray(raw)) return [];
  const out: StoredInject[] = [];
  raw.forEach((item, index) => {
    const inject = normalizeInject(item, `inject-${index}`);
    if (inject) out.push(inject);
  });
  return out;
}

function writeInjects(db: Db, chat: ChatRow, injects: StoredInject[]): StoredInject[] {
  const metadata = { ...(chat.metadata ?? {}) };
  if (injects.length === 0) delete metadata.injects;
  else metadata.injects = injects;
  patchChat(db, chat.id, { metadata });
  return injects;
}

/** 按 id 覆盖写入（同 id 的旧注入被替换，与 ST `setExtensionPrompt` 的键语义一致） */
export function upsertChatInjects(
  db: Db,
  chatId: string,
  prompts: readonly unknown[],
  options: { once?: boolean } = {},
): StoredInject[] {
  const chat = loadChat(db, chatId);
  if (!chat) return [];
  const current = readChatInjects(chat);
  const stamp = Date.now().toString(36);
  const incoming: StoredInject[] = [];
  prompts.forEach((raw, index) => {
    const inject = normalizeInject(raw, `inject-${stamp}-${index}`);
    if (!inject) return;
    incoming.push(options.once ? { ...inject, once: true } : inject);
  });
  const ids = new Set(incoming.map((item) => item.id));
  return writeInjects(db, chat, [...current.filter((item) => !ids.has(item.id)), ...incoming]);
}

/** 删除指定 id；不给 ids = 全部清空（slash `/flushinjects`） */
export function removeChatInjects(db: Db, chatId: string, ids?: readonly string[]): StoredInject[] {
  const chat = loadChat(db, chatId);
  if (!chat) return [];
  if (!ids) return writeInjects(db, chat, []);
  const remove = new Set(ids);
  return writeInjects(
    db,
    chat,
    readChatInjects(chat).filter((item) => !remove.has(item.id)),
  );
}

/** 一次生成成功之后：删掉 `once` 的注入。返回删了几条 */
export function consumeOnceInjects(db: Db, chatId: string): number {
  const chat = loadChat(db, chatId);
  if (!chat) return 0;
  const current = readChatInjects(chat);
  const kept = current.filter((item) => item.once !== true);
  if (kept.length === current.length) return 0;
  writeInjects(db, chat, kept);
  return current.length - kept.length;
}

/** 组装用：会话级注入（去掉 once 标记）+ 本次请求临时带的（前端卡 `generate({injects})`） */
export function collectExtraInjections(
  chat: Pick<ChatRow, 'metadata'>,
  requestInjects: readonly AssembleExtraInjection[] = [],
): AssembleExtraInjection[] {
  const stored = readChatInjects(chat).map(({ once: _once, ...rest }) => rest);
  return [...stored, ...requestInjects];
}

/* ------------------------------------------------------------------ */
/* 变量 schema                                                          */
/* ------------------------------------------------------------------ */

export function isSchemaScope(value: unknown): value is SchemaScope {
  return typeof value === 'string' && (SCHEMA_SCOPES as readonly string[]).includes(value);
}

export function readVariableSchemas(
  chat: Pick<ChatRow, 'metadata'>,
): Partial<Record<SchemaScope, Record<string, unknown>>> {
  const raw = (chat.metadata ?? {})['variableSchemas'];
  if (!isRecord(raw)) return {};
  const out: Partial<Record<SchemaScope, Record<string, unknown>>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isSchemaScope(key) && isRecord(value)) out[key] = value;
  }
  return out;
}

/** 写一个作用域的 schema；`null` = 删除。`chat` 与 `message` 是同一张表，存成同一份 */
export function writeVariableSchema(
  db: Db,
  chatId: string,
  scope: SchemaScope,
  schema: Record<string, unknown> | null,
): Partial<Record<SchemaScope, Record<string, unknown>>> {
  const chat = loadChat(db, chatId);
  if (!chat) return {};
  const target: SchemaScope = scope === 'chat' ? 'message' : scope;
  const schemas = { ...readVariableSchemas(chat) };
  if (schema === null) delete schemas[target];
  else schemas[target] = schema;
  const metadata = { ...(chat.metadata ?? {}) };
  if (Object.keys(schemas).length === 0) delete metadata.variableSchemas;
  else metadata.variableSchemas = schemas;
  patchChat(db, chat.id, { metadata });
  return schemas;
}
