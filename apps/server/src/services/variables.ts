import { and, eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';

/**
 * 变量存储。见 docs/M3-CONTRACT.md §3.5。
 *
 * chat 作用域的完整快照存在 `message_nodes.variables`（由 SB 在生成时写入）；
 * 全局变量走 `variables` 表（scope='global'，ownerId=''）+ `variable_events` 审计日志。
 */

const GLOBAL_SCOPE = 'global';
const GLOBAL_OWNER = '';

export function readGlobalVariables(db: Db): Record<string, unknown> {
  const rows = db
    .select()
    .from(schema.variables)
    .where(
      and(eq(schema.variables.scope, GLOBAL_SCOPE), eq(schema.variables.ownerId, GLOBAL_OWNER)),
    )
    .all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/**
 * 应用全局变量变更：upsert `variables`，并为每个键写一行 `variable_events`。
 * 值为 `undefined` / `null` 视为删除。
 */
export function applyGlobalChanges(
  db: Db,
  changes: Record<string, unknown>,
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
          eq(schema.variables.scope, GLOBAL_SCOPE),
          eq(schema.variables.ownerId, GLOBAL_OWNER),
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
        .values({
          scope: GLOBAL_SCOPE,
          ownerId: GLOBAL_OWNER,
          key,
          value: newValue,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.variables.scope, schema.variables.ownerId, schema.variables.key],
          set: { value: newValue, updatedAt: now },
        })
        .run();
    }
    db.insert(schema.variableEvents)
      .values({
        scope: GLOBAL_SCOPE,
        ownerId: GLOBAL_OWNER,
        nodeId,
        op: remove ? 'delete' : 'set',
        path: key,
        oldValue,
        newValue: remove ? null : newValue,
      })
      .run();
  }
}
