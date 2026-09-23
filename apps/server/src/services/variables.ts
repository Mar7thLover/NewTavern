import { and, eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';

/**
 * 变量存储。见 docs/M3-CONTRACT.md §3.5 与 docs/M5-CONTRACT.md §3。
 *
 * 四张表，对应酒馆助手 `getVariables({type})` 的四种 `type`：
 *
 * | 酒馆助手 type | 新酒馆的存法                                        |
 * | ------------- | --------------------------------------------------- |
 * | `message`     | `message_nodes.variables`（按节点的完整快照，MVU 在这） |
 * | `chat`        | `variables` 表 scope='chat'、ownerId=chatId          |
 * | `character`   | `variables` 表 scope='character'、ownerId=characterId |
 * | `global`      | `variables` 表 scope='global'、ownerId=''            |
 * | `script`      | `variables` 表 scope='script'、ownerId=scriptId       |
 * | `preset`      | `variables` 表 scope='preset'、ownerId=presetId（M5（三）§1） |
 *
 * `message` 之所以按节点存：分支与 swipe 要能各自带一套变量（重生时从父快照重新起算），
 * 这是 ST 按聊天存 `chat_metadata` 做不到的事（PLAN §七-7）。
 * 每次写入都记一行 `variable_events`，变量面板与审计靠它。
 */

const GLOBAL_OWNER = '';

export type VariableTableScope = 'global' | 'character' | 'chat' | 'script' | 'preset';

/** 一张变量表：键 → 任意 JSON 值 */
export type VariableTable = Record<string, unknown>;

export function readVariableTable(
  db: Db,
  scope: VariableTableScope,
  ownerId = GLOBAL_OWNER,
): VariableTable {
  const rows = db
    .select()
    .from(schema.variables)
    .where(and(eq(schema.variables.scope, scope), eq(schema.variables.ownerId, ownerId)))
    .all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function readGlobalVariables(db: Db): VariableTable {
  return readVariableTable(db, 'global');
}

/**
 * 应用一组变量变更：upsert `variables`，并为每个键写一行 `variable_events`。
 * 值为 `undefined` / `null` 视为删除。
 */
export function applyVariableChanges(
  db: Db,
  scope: VariableTableScope,
  ownerId: string,
  changes: VariableTable,
  nodeId: string | null,
): void {
  const keys = Object.keys(changes);
  if (keys.length === 0) return;
  const now = new Date();
  for (const key of keys) {
    const newValue = changes[key];
    const existing = db
      .select()
      .from(schema.variables)
      .where(
        and(
          eq(schema.variables.scope, scope),
          eq(schema.variables.ownerId, ownerId),
          eq(schema.variables.key, key),
        ),
      )
      .get();
    const oldValue = existing?.value ?? null;
    const remove = newValue === undefined || newValue === null;

    if (remove) {
      if (!existing) continue;
      db.delete(schema.variables).where(eq(schema.variables.id, existing.id)).run();
    } else {
      db.insert(schema.variables)
        .values({ scope, ownerId, key, value: newValue, updatedAt: now })
        .onConflictDoUpdate({
          target: [schema.variables.scope, schema.variables.ownerId, schema.variables.key],
          set: { value: newValue, updatedAt: now },
        })
        .run();
    }
    db.insert(schema.variableEvents)
      .values({
        scope,
        ownerId,
        nodeId,
        op: remove ? 'delete' : 'set',
        path: key,
        oldValue,
        newValue: remove ? null : newValue,
      })
      .run();
  }
}

/** 全局变量变更（组装流水线的老入口，保持签名不变） */
export function applyGlobalChanges(
  db: Db,
  changes: VariableTable,
  nodeId: string | null,
): void {
  applyVariableChanges(db, 'global', GLOBAL_OWNER, changes, nodeId);
}

/**
 * 整表替换（前端卡的 `replaceVariables`）：传入表里没有的键一律删除。
 * 返回替换后的表。
 */
export function replaceVariableTable(
  db: Db,
  scope: VariableTableScope,
  ownerId: string,
  table: VariableTable,
  nodeId: string | null = null,
): VariableTable {
  const current = readVariableTable(db, scope, ownerId);
  const changes: VariableTable = {};
  for (const [key, value] of Object.entries(table)) {
    if (JSON.stringify(current[key]) !== JSON.stringify(value)) changes[key] = value;
  }
  for (const key of Object.keys(current)) {
    if (!Object.hasOwn(table, key)) changes[key] = undefined;
  }
  applyVariableChanges(db, scope, ownerId, changes, nodeId);
  return readVariableTable(db, scope, ownerId);
}
