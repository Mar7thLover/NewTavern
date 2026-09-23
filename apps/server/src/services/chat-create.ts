import { substituteMacros } from '@newtavern/core';
import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { insertNode, patchChat, setChatLorebooks, type ChatRow } from './chat-tree.js';
import { loadBookOpeners } from './openers.js';
import { readDefaultPersonaId } from './personas.js';
import { readDefaultPresetId } from './presets.js';

/**
 * 新建对话（`POST /api/chats` 的主体，工作台测试会话 `GET /api/studio/test-chat` 复用）。
 * 抽出来是为了不让路由之间互相调 HTTP（M6 §2.4）。
 */

/** 实体不存在（角色 / 世界书），路由层转 404 */
export class ChatCreateError extends Error {}

/** 工作台测试会话标记：`chats.metadata.studio`（M6 §2.4） */
export interface StudioChatMarker {
  kind: 'character' | 'preset' | 'lorebook';
  entityId: string;
}

const STUDIO_KINDS: readonly StudioChatMarker['kind'][] = ['character', 'preset', 'lorebook'];

/** 校验 `metadata.studio`；不合法返回 undefined */
export function parseStudioMarker(value: unknown): StudioChatMarker | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { kind, entityId } = value as Record<string, unknown>;
  if (!STUDIO_KINDS.includes(kind as StudioChatMarker['kind'])) return undefined;
  if (typeof entityId !== 'string' || entityId === '') return undefined;
  return { kind: kind as StudioChatMarker['kind'], entityId };
}

/** 该会话是工作台测试会话（`metadata.studio` 非空） */
export function isStudioChat(chat: Pick<ChatRow, 'metadata'>): boolean {
  const studio = (chat.metadata ?? {})['studio'];
  return studio !== undefined && studio !== null;
}

/** body 形状与 `POST /api/chats` 一致（全部可选，按原有规则解析） */
export function createChat(db: Db, body: Record<string, unknown>): ChatRow {
  const characterIds = Array.isArray(body.characterIds)
    ? body.characterIds.filter((id): id is string => typeof id === 'string')
    : [];
  // 没带 personaId 字段 → 用默认档案；显式 null → 不用档案
  const personaId =
    'personaId' in body
      ? typeof body.personaId === 'string'
        ? body.personaId
        : null
      : readDefaultPersonaId(db);
  // 同上：没带 presetId 字段 → 用默认预设；显式 null → 不用预设（「无」）
  const presetId =
    'presetId' in body
      ? typeof body.presetId === 'string'
        ? body.presetId
        : null
      : readDefaultPresetId(db);
  const mode = body.mode === 'writing' || body.mode === 'crpg' ? body.mode : 'roleplay';

  const characterRow = characterIds[0]
    ? db.select().from(schema.characters).where(eq(schema.characters.id, characterIds[0])).get()
    : undefined;
  if (characterIds[0] && !characterRow) {
    throw new ChatCreateError(`角色不存在：${characterIds[0]}`);
  }
  const personaRow = personaId
    ? db.select().from(schema.personas).where(eq(schema.personas.id, personaId)).get()
    : undefined;

  // 新建对话页可以只挑一本世界书开场（不带角色卡），这些书同时落成聊天书
  const lorebookIds = Array.isArray(body.lorebookIds)
    ? [
        ...new Set(
          body.lorebookIds.filter((id): id is string => typeof id === 'string' && id !== ''),
        ),
      ]
    : [];
  const bookRows = lorebookIds.map((id) =>
    db.select().from(schema.lorebooks).where(eq(schema.lorebooks.id, id)).get(),
  );
  const missingIndex = bookRows.findIndex((row) => row === undefined);
  if (missingIndex >= 0) {
    throw new ChatCreateError(`世界书不存在：${lorebookIds[missingIndex]}`);
  }
  const openers = loadBookOpeners(db, lorebookIds);

  // 工作台测试会话标记（M6 §2.4）；其余 metadata 键新建时不收
  const metadataInput = body.metadata as Record<string, unknown> | null | undefined;
  const studio =
    typeof metadataInput === 'object' && metadataInput !== null
      ? parseStudioMarker(metadataInput.studio)
      : undefined;

  // 标题：显式给的 > 角色名 > 第一本世界书的名字（没有开场白的书同样能开场）
  const title =
    typeof body.title === 'string' && body.title.trim()
      ? body.title.trim()
      : (characterRow?.name ?? bookRows[0]?.name ?? '');

  let chat = db
    .insert(schema.chats)
    .values({
      title,
      mode,
      characterIds,
      personaId,
      presetId,
      ...(studio ? { metadata: { studio } } : {}),
    })
    .returning()
    .get();
  if (lorebookIds.length > 0) setChatLorebooks(db, chat.id, lorebookIds);

  /**
   * 开场白 → 根节点与它的 swipe 兄弟。来源按顺序拼：角色卡的
   * `first_mes` + `alternate_greetings`，再接世界书自带的开场白
   * （`@@is_greeting` 在前、role=assistant 的 prefill 在后，见 services/openers.ts）。
   */
  const card = (characterRow?.data ?? {}) as Record<string, unknown>;
  const charName = characterRow?.name ?? '';
  const firstMes = typeof card.first_mes === 'string' ? card.first_mes : '';
  const cardGreetings = characterRow
    ? [
        firstMes,
        ...(Array.isArray(card.alternate_greetings)
          ? card.alternate_greetings.filter((g): g is string => typeof g === 'string' && !!g.trim())
          : []),
      ].filter((greeting) => greeting.trim() !== '')
    : [];
  const openings = [
    ...cardGreetings.map((text) => ({ text, name: charName })),
    // 无角色卡时用书名当说话人，与用书名当标题保持一致
    ...openers.map((opener) => ({ text: opener.content, name: charName || opener.bookName })),
  ];

  if (openings.length > 0) {
    const userName = personaRow?.name ?? 'User';
    let rootId: string | null = null;
    openings.forEach((opening, index) => {
      // ST 1.18：开场白里的 {{persona}} {{description}} … 取各字段 baseChatReplace 后的值
      // （字段先 trim、再只展开 {{user}} {{char}} 等，字段里的卡类宏为空），见 M4 契约 §9 MSS 修正
      const seed = { char: opening.name, user: userName };
      const base = (value: unknown) =>
        typeof value === 'string' ? substituteMacros(value.trim(), seed) : undefined;
      const row = insertNode(db, {
        chatId: chat.id,
        parentId: null,
        siblingSeq: index,
        role: 'assistant',
        name: opening.name,
        parts: [
          {
            type: 'text',
            text: substituteMacros(opening.text, {
              ...seed,
              persona: base(personaRow?.description),
              description: base(card.description),
              personality: base(card.personality),
              scenario: base(card.scenario),
              mesExamples: base(card.mes_example),
            }),
          },
        ],
      });
      if (index === 0) rootId = row.id;
    });
    chat = patchChat(db, chat.id, { rootNodeId: rootId, headNodeId: rootId });
  }
  return chat;
}
