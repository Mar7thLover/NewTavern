import { desc, eq, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { createChat, type StudioChatMarker } from './chat-create.js';
import { patchChat, readChatLorebookIds, setChatLorebooks, type ChatRow } from './chat-tree.js';

/**
 * 工作台测试会话（M6 §2.4）：测试对话就是普通会话，`metadata.studio = { kind, entityId }`，
 * 普通会话列表默认不显示。同一实体复用最近一条测试会话，没有就新建：
 * - character：该卡 + 默认档案 / 默认预设（与新建对话一致，开场白照常落成根节点）；
 * - preset：该预设 + 最近一次对话用过、且仍存在的卡（没有就不带卡）；
 * - lorebook：把这本书绑到会话上（聊天书），不带卡。
 *
 * `recreateTestChat`（`POST /api/studio/test-chat/:kind/:id`）新建一条替换当前那条：
 * 可换角色卡，其余选择（档案 / 预设 / 连接等覆盖 / 聊天书 / 作者注释 / 背景）沿用旧会话。
 */

export type StudioKind = StudioChatMarker['kind'];

export class StudioEntityNotFoundError extends Error {}

/** 请求不合法（角色不存在、character 类型换卡），路由层转 400 */
export class StudioTestChatInputError extends Error {}

/** 重开时沿用的 metadata 键：作者注释、会话背景。其余（冻结段、注入、变量 schema、ST 原件）属会话运行态，不带 */
const CARRIED_METADATA_KEYS = ['authorsNote', 'background'] as const;

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

export interface RecreateTestChatInput {
  /** 缺省 = 沿用旧会话的角色（没有旧会话时按类型的默认规则）；null = 不带角色 */
  characterId?: string | null;
}

/**
 * 新建一条测试会话替换当前那条（删除旧的），返回新会话。
 * - 角色：`characterId` 缺省沿用旧会话；character 类型只能是该卡本身；
 * - 预设：preset 类型强制为该预设，其余沿用旧会话（没有旧会话 → 默认预设）；
 * - 档案、overrides、聊天书、作者注释 / 背景沿用旧会话；lorebook 类型保证该书在聊天书里。
 * 新会话照常由 `createChat` 落开场白根节点。
 */
export function recreateTestChat(
  db: Db,
  kind: StudioKind,
  id: string,
  input: RecreateTestChatInput,
): ChatRow {
  if (!entityExists(db, kind, id)) throw new StudioEntityNotFoundError();
  const old = findTestChat(db, kind, id);

  let characterId: string | null;
  if (input.characterId === undefined) {
    const previous = old?.characterIds[0];
    if (old) {
      characterId = previous && entityExists(db, 'character', previous) ? previous : null;
    } else {
      characterId = kind === 'character' ? id : kind === 'preset' ? lastUsedCharacterId(db) : null;
    }
  } else {
    characterId = input.characterId;
  }
  if (kind === 'character' && characterId !== id) {
    throw new StudioTestChatInputError('角色卡的测试会话不能更换角色');
  }
  if (characterId !== null && !entityExists(db, 'character', characterId)) {
    throw new StudioTestChatInputError(`角色不存在：${characterId}`);
  }

  // 旧会话的聊天书（仍存在的；外键级联删除保证了这一点），lorebook 类型把该书放在最前
  const oldBooks = old ? readChatLorebookIds(db, old.id) : [];
  const bookIds = kind === 'lorebook' && !oldBooks.includes(id) ? [id, ...oldBooks] : oldBooks;

  const body: Record<string, unknown> = {
    characterIds: characterId ? [characterId] : [],
    metadata: { studio: { kind, entityId: id } satisfies StudioChatMarker },
    // 开场白只取该书（与首次新建一致）；其余聊天书建好后再绑，不把它们的开场白混进来
    lorebookIds: kind === 'lorebook' ? [id] : [],
  };
  // 没有旧会话时不带 personaId / presetId 字段 → createChat 用默认档案 / 默认预设
  if (old) body.personaId = old.personaId;
  if (kind === 'preset') body.presetId = id;
  else if (old) body.presetId = old.presetId;

  return db.transaction(() => {
    const created = createChat(db, body);
    if (bookIds.length > 0) setChatLorebooks(db, created.id, bookIds);
    if (!old) return created;

    const carried: Record<string, unknown> = {};
    for (const key of CARRIED_METADATA_KEYS) {
      const value = old.metadata?.[key];
      if (value !== undefined && value !== null) carried[key] = value;
    }
    const chat = patchChat(db, created.id, {
      ...(old.overrides ? { overrides: old.overrides } : {}),
      metadata: { ...(created.metadata ?? {}), ...carried },
    });
    db.delete(schema.chats).where(eq(schema.chats.id, old.id)).run();
    return chat;
  });
}
