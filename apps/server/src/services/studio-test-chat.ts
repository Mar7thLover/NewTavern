import { desc, eq, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { createChat, type StudioChatMarker } from './chat-create.js';
import type { ChatRow } from './chat-tree.js';

/**
 * 工作台测试会话（M6 §2.4）：测试对话就是普通会话，`metadata.studio = { kind, entityId }`，
 * 普通会话列表默认不显示。同一实体复用最近一条测试会话，没有就新建：
 * - character：该卡 + 默认档案 / 默认预设（与新建对话一致，开场白照常落成根节点）；
 * - preset：该预设 + 最近一次对话用过、且仍存在的卡（没有就不带卡）；
 * - lorebook：把这本书绑到会话上（聊天书），不带卡。
 */

export type StudioKind = StudioChatMarker['kind'];

export class StudioEntityNotFoundError extends Error {}

function entityExists(db: Db, kind: StudioKind, id: string): boolean {
  const table =
    kind === 'character'
      ? schema.characters
      : kind === 'preset'
        ? schema.presets
        : schema.lorebooks;
  return db.select({ id: table.id }).from(table).where(eq(table.id, id)).get() !== undefined;
}

/** 该实体最近的一条测试会话 */
export function findTestChat(db: Db, kind: StudioKind, id: string): ChatRow | undefined {
  return db
    .select()
    .from(schema.chats)
    .where(
      sql`json_extract(${schema.chats.metadata}, '$.studio.kind') = ${kind}
        AND json_extract(${schema.chats.metadata}, '$.studio.entityId') = ${id}`,
    )
    .orderBy(desc(schema.chats.updatedAt))
    .limit(1)
    .get();
}

/** 最近一次对话用过、且仍存在的角色卡 */
function lastUsedCharacterId(db: Db): string | null {
  const chats = db
    .select({ characterIds: schema.chats.characterIds })
    .from(schema.chats)
    .orderBy(desc(schema.chats.updatedAt))
    .all();
  for (const chat of chats) {
    const id = chat.characterIds[0];
    if (id && entityExists(db, 'character', id)) return id;
  }
  return null;
}

export function getOrCreateTestChat(
  db: Db,
  kind: StudioKind,
  id: string,
): { chat: ChatRow; created: boolean } {
  if (!entityExists(db, kind, id)) throw new StudioEntityNotFoundError();
  const existing = findTestChat(db, kind, id);
  if (existing) return { chat: existing, created: false };

  const metadata = { studio: { kind, entityId: id } satisfies StudioChatMarker };
  if (kind === 'character') {
    return { chat: createChat(db, { characterIds: [id], metadata }), created: true };
  }
  if (kind === 'preset') {
    const characterId = lastUsedCharacterId(db);
    return {
      chat: createChat(db, {
        presetId: id,
        characterIds: characterId ? [characterId] : [],
        metadata,
      }),
      created: true,
    };
  }
  return { chat: createChat(db, { lorebookIds: [id], metadata }), created: true };
}
