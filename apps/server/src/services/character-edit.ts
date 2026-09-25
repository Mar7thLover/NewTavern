import { normalizeCard } from '@newtavern/compat';
import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { StudioMarker } from '../db/schema.js';
import { extractCharacterBook, type CharacterRow } from './character-book.js';
import { recordCurrentVersion, recordVersion, type VersionAuthor } from './versions.js';

/**
 * 角色卡编辑（M6 §2.1）：新建空卡、整份替换 data。
 *
 * `data` 是完整 CCv3 data，未知字段原样保留；服务端只做结构校验、同步 name / tags 列、
 * 写 `editedAt`（此后导出从 data 重写，不再回原件字节）与一版 `entity_versions`。
 * `data.character_book` 不从这里改：卡已关联内嵌书（`bookId`）时沿用库里的原值，
 * 书的编辑走 lorebooks 表，导出时 `rebuildCharacterBook` 合回；
 * 还没有内嵌书时（AI 一句话生成整卡）才收下，并抽进 lorebooks 表。
 */

export class CharacterInputError extends Error {}
export class CharacterNotFoundError extends Error {}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * CCv3 data 的默认字段（ST 1.18 新建角色时 `createOrEditCharacter` 写进卡的那些，
 * 取 V3 字段集；`extensions` 里只放 ST 必带的 talkativeness / fav / world / depth_prompt）。
 */
function defaultCardData(name: string): Json {
  const now = Math.floor(Date.now() / 1000);
  return {
    name,
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: '',
    character_version: '',
    extensions: {
      talkativeness: '0.5',
      fav: false,
      world: '',
      depth_prompt: { prompt: '', depth: 4, role: 'system' },
    },
    group_only_greetings: [],
    creation_date: now,
    modification_date: now,
  };
}

/**
 * 结构校验：data 是对象、name 为非空字符串，且能按 CCv3 解析（导出要走 normalizeCard，
 * 这里先挡住会让导出失败的类型错误）。返回规整后的 name。
 */
function validateCardData(data: unknown): { data: Json; name: string } {
  if (!isRecord(data)) throw new CharacterInputError('data 必须是对象');
  if (typeof data.name !== 'string' || data.name.trim() === '') {
    throw new CharacterInputError('data.name 必须是非空字符串');
  }
  try {
    normalizeCard({ spec: 'chara_card_v3', spec_version: '3.0', data });
  } catch (e) {
    throw new CharacterInputError((e as Error).message);
  }
  return { data, name: data.name.trim() };
}

function tagsOf(data: Json): string[] {
  return Array.isArray(data.tags)
    ? data.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
}

function loadCharacter(db: Db, id: string): CharacterRow | undefined {
  return db.select().from(schema.characters).where(eq(schema.characters.id, id)).get();
}

/**
 * 新建 V3 空卡：`data` 可选，按 CCv3 默认字段补齐（传入的字段覆盖默认值）。
 * `studio` 非 null = 工作台里新建的（见 services/studio-fork.ts）；内嵌书抽出来的那本书同样打标记。
 */
export function createCharacter(
  db: Db,
  name: unknown,
  data?: unknown,
  studio: StudioMarker | null = null,
): CharacterRow {
  if (data !== undefined && !isRecord(data)) throw new CharacterInputError('data 必须是对象');
  const nameText =
    typeof name === 'string' && name.trim()
      ? name.trim()
      : isRecord(data) && typeof data.name === 'string'
        ? data.name.trim()
        : '';
  if (!nameText) throw new CharacterInputError('name 不能为空');
  const merged = { ...defaultCardData(nameText), ...(isRecord(data) ? data : {}), name: nameText };
  const { data: valid } = validateCardData(merged);
  const now = new Date();
  const row = db
    .insert(schema.characters)
    .values({
      name: nameText,
      spec: 'v3',
      data: valid,
      tags: tagsOf(valid),
      // 没有原件：导出本来就从 data 写，editedAt 标上方便「最近编辑」
      editedAt: now,
      studio,
    })
    .returning()
    .get();
  const bookId = extractCharacterBook(db, row);
  if (bookId && studio) {
    db.update(schema.lorebooks).set({ studio }).where(eq(schema.lorebooks.id, bookId)).run();
  }
  recordVersion(db, 'character', row.id, row.data, 'user');
  return loadCharacter(db, row.id) as CharacterRow;
}

/** 整份替换 data（PUT 与版本恢复共用） */
export function updateCharacter(
  db: Db,
  id: string,
  data: unknown,
  author: VersionAuthor = 'user',
): CharacterRow {
  const current = loadCharacter(db, id);
  if (!current) throw new CharacterNotFoundError();
  const { data: incoming, name } = validateCardData(data);

  const next: Json = { ...incoming, name };
  const currentData = (current.data ?? {}) as Json;
  if (current.bookId) {
    // 内嵌书在 lorebooks 表里编辑：character_book 保持库里的原值（没有就不带）
    if ('character_book' in currentData) next.character_book = currentData.character_book;
    else delete next.character_book;
  }

  const row = db
    .update(schema.characters)
    .set({ name, data: next, tags: tagsOf(next), editedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.characters.id, id))
    .returning()
    .get();
  // AI 生成整卡时直接写了 character_book：抽进 lorebooks 表（已有 bookId 时是空操作）
  if (!row.bookId) {
    const bookId = extractCharacterBook(db, row);
    // 工作台的卡抽出来的书也是工作台的
    if (bookId && row.studio) {
      db.update(schema.lorebooks)
        .set({ studio: { sourceId: null } })
        .where(eq(schema.lorebooks.id, bookId))
        .run();
    }
  }
  recordCurrentVersion(db, 'character', id, author);
  return loadCharacter(db, id) as CharacterRow;
}

/** 换头像 / 清头像：头像是导出 PNG 的底图，所以同样标 editedAt */
export function setCharacterAvatar(
  db: Db,
  id: string,
  avatarAssetId: string | null,
): CharacterRow | undefined {
  const now = new Date();
  return db
    .update(schema.characters)
    .set({ avatarAssetId, editedAt: now, updatedAt: now })
    .where(eq(schema.characters.id, id))
    .returning()
    .get();
}
