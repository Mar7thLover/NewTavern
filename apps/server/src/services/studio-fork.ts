import { and, asc, eq, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { StudioMarker } from '../db/schema.js';
import type { EmbeddedScope } from './embedded-regex.js';
import { syncMetaName } from './lorebook-edit.js';
import { insertPresetCopy } from './preset-edit.js';
import type { VariableTableScope } from './variables.js';
import { recordCurrentVersion, type EntityType } from './versions.js';

/**
 * 工作台复制（`POST /api/studio/fork/:kind/:id`）：从工作台打开库里的**原件**时先复制一份，
 * 编辑的是副本，原件不动。
 *
 * 标记在三张表的 `studio` 列（迁移 0004）：null = 库里的原件；非 null = 工作台自己的
 * （`sourceId` 是复制来源；工作台里新建的为 null）。已经是工作台的直接返回原 id，不再复制。
 *
 * 复制什么（整个在一个事务里）：
 * - character：卡行（名字不改，它就是 `{{char}}`；data / tags 深拷贝；头像共用同一资产——
 *   资产按引用清理，见 media-gc.ts）；内嵌世界书深拷贝成新书（条目 uid / extra 原样），
 *   新书同样打标记；立绘行（同一资产，删立绘只删行）；角色变量表；卡自带正则（`regex_scripts`
 *   scope='character'，以及内嵌书的 scope='book'）按当前开关状态复制。
 *   `sourcePath` 保留（导出要从原件取顶层未知字段与 PNG / CHARX 内嵌资源，原件文件只读、
 *   删卡也不删它），`originalHash` 置空（ST 迁移按它去重，只认原件），`editedAt` 沿用原件——
 *   没改过的副本导出与原件逐字节相同，一编辑 PUT 就会写上 editedAt，从 data 重写。
 * - preset：预设行（「<原名> 副本」，与 `POST /api/presets/:id/duplicate` 同一个函数），
 *   外加预设自带脚本（`scripts` scope='preset'，连同每个脚本的 script 变量表）、
 *   预设自带正则（`regex_scripts` scope='preset'）、预设变量表。
 * - lorebook：书行 + 全部条目（「<原名> 副本」），书自带正则。直接复制一本卡内嵌（scope='char'）
 *   的书时副本不挂在任何卡上，scope 改成 'global'（独立的书）；其余 scope 原样。
 *
 * 复制完给新实体（卡与其新书都算）记一版版本历史。
 */

export type StudioForkKind = EntityType;

export interface StudioForkResult {
  id: string;
  forked: boolean;
}

export class StudioForkNotFoundError extends Error {}

type CharacterRow = typeof schema.characters.$inferSelect;
type LorebookRow = typeof schema.lorebooks.$inferSelect;

const clone = <T>(value: T): T =>
  value === null || value === undefined ? value : structuredClone(value);

/** 某个来源自带的正则整组复制到新 owner（开关状态、顺序、extra 原样） */
function copyRegexRows(db: Db, scope: EmbeddedScope, fromId: string, toId: string): void {
  const rows = db
    .select()
    .from(schema.regexScripts)
    .where(and(eq(schema.regexScripts.scope, scope), eq(schema.regexScripts.ownerId, fromId)))
    .orderBy(asc(sql`rowid`))
    .all();
  for (const { id: _id, createdAt: _c, updatedAt: _u, ...row } of rows) {
    db.insert(schema.regexScripts)
      .values({
        ...row,
        ownerId: toId,
        trimStrings: clone(row.trimStrings),
        extra: clone(row.extra),
      })
      .run();
  }
}

/** 一张变量表（scope + owner）整表复制 */
function copyVariableTable(db: Db, scope: VariableTableScope, fromId: string, toId: string): void {
  const rows = db
    .select()
    .from(schema.variables)
    .where(and(eq(schema.variables.scope, scope), eq(schema.variables.ownerId, fromId)))
    .all();
  for (const row of rows) {
    db.insert(schema.variables)
      .values({ scope, ownerId: toId, key: row.key, value: clone(row.value) })
      .run();
  }
}

/**
 * 深拷贝一本世界书（行 + 全部条目 + 自带正则）。条目按 rowid 顺序插入
 * （导出 `worldbookFromTable` 按 rowid 排），uid / extra / displayIndex 原样。
 *
 * 时间戳：`rebuildCharacterBook` 用「updatedAt 晚于 createdAt」判断内嵌书被编辑过（此时导出从表重建），
 * 所以副本保持原书的这个关系。
 */
function copyLorebook(
  db: Db,
  source: LorebookRow,
  options: { name: string; scope: LorebookRow['scope']; now: Date },
): LorebookRow {
  const edited = source.updatedAt.getTime() > source.createdAt.getTime();
  const renamed = { ...source, name: options.name };
  const settings = clone(syncMetaName(renamed, options.name) ?? source.settings);
  const book = db
    .insert(schema.lorebooks)
    .values({
      name: options.name,
      scope: options.scope,
      settings,
      studio: { sourceId: source.id },
      createdAt: options.now,
      updatedAt: edited ? new Date(options.now.getTime() + 1) : options.now,
    })
    .returning()
    .get();
  const entries = db
    .select()
    .from(schema.lorebookEntries)
    .where(eq(schema.lorebookEntries.bookId, source.id))
    .orderBy(asc(sql`rowid`))
    .all();
  for (const { id: _id, bookId: _bookId, ...entry } of entries) {
    db.insert(schema.lorebookEntries)
      .values({
        ...entry,
        bookId: book.id,
        keys: clone(entry.keys),
        secondaryKeys: clone(entry.secondaryKeys),
        decorators: clone(entry.decorators),
        extra: clone(entry.extra),
      })
      .run();
  }
  copyRegexRows(db, 'book', source.id, book.id);
  return book;
}

function forkCharacter(db: Db, source: CharacterRow): string {
  const now = new Date();
  const studio: StudioMarker = { sourceId: source.id };
  const row = db
    .insert(schema.characters)
    .values({
      name: source.name,
      spec: source.spec,
      data: clone(source.data),
      avatarAssetId: source.avatarAssetId,
      sourcePath: source.sourcePath,
      originalHash: null,
      editedAt: source.editedAt,
      tags: clone(source.tags),
      studio,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();

  let bookId: string | null = null;
  if (source.bookId) {
    const book = db
      .select()
      .from(schema.lorebooks)
      .where(eq(schema.lorebooks.id, source.bookId))
      .get();
    if (book) {
      bookId = copyLorebook(db, book, { name: book.name, scope: book.scope, now }).id;
      db.update(schema.characters).set({ bookId }).where(eq(schema.characters.id, row.id)).run();
    }
  }

  const sprites = db
    .select()
    .from(schema.characterSprites)
    .where(eq(schema.characterSprites.characterId, source.id))
    .all();
  for (const sprite of sprites) {
    db.insert(schema.characterSprites)
      .values({ characterId: row.id, label: sprite.label, assetId: sprite.assetId })
      .run();
  }
  copyVariableTable(db, 'character', source.id, row.id);
  copyRegexRows(db, 'character', source.id, row.id);

  recordCurrentVersion(db, 'character', row.id);
  if (bookId) recordCurrentVersion(db, 'lorebook', bookId);
  return row.id;
}

function forkPreset(db: Db, source: typeof schema.presets.$inferSelect): string {
  const row = insertPresetCopy(db, source, { studio: { sourceId: source.id } });
  const scripts = db
    .select()
    .from(schema.scripts)
    .where(and(eq(schema.scripts.scope, 'preset'), eq(schema.scripts.ownerId, source.id)))
    .orderBy(asc(schema.scripts.displayOrder), asc(sql`rowid`))
    .all();
  for (const { id: scriptId, createdAt: _c, updatedAt: _u, ...script } of scripts) {
    const copy = db
      .insert(schema.scripts)
      .values({
        ...script,
        ownerId: row.id,
        buttons: clone(script.buttons),
        data: clone(script.data),
      })
      .returning({ id: schema.scripts.id })
      .get();
    copyVariableTable(db, 'script', scriptId, copy.id);
  }
  copyRegexRows(db, 'preset', source.id, row.id);
  copyVariableTable(db, 'preset', source.id, row.id);
  recordCurrentVersion(db, 'preset', row.id);
  return row.id;
}

function forkLorebookRow(db: Db, source: LorebookRow): string {
  const book = copyLorebook(db, source, {
    name: `${source.name} 副本`,
    // 卡内嵌的书单独复制出来就不挂在任何卡上了：当独立的书
    scope: source.scope === 'char' ? 'global' : source.scope,
    now: new Date(),
  });
  recordCurrentVersion(db, 'lorebook', book.id);
  return book.id;
}

/** 复制到工作台；已经是工作台的原样返回。实体不存在抛 StudioForkNotFoundError */
export function forkToStudio(db: Db, kind: StudioForkKind, id: string): StudioForkResult {
  return db.transaction((tx) => {
    if (kind === 'character') {
      const row = tx.select().from(schema.characters).where(eq(schema.characters.id, id)).get();
      if (!row) throw new StudioForkNotFoundError();
      if (row.studio) return { id: row.id, forked: false };
      return { id: forkCharacter(tx, row), forked: true };
    }
    if (kind === 'preset') {
      const row = tx.select().from(schema.presets).where(eq(schema.presets.id, id)).get();
      if (!row) throw new StudioForkNotFoundError();
      if (row.studio) return { id: row.id, forked: false };
      return { id: forkPreset(tx, row), forked: true };
    }
    const row = tx.select().from(schema.lorebooks).where(eq(schema.lorebooks.id, id)).get();
    if (!row) throw new StudioForkNotFoundError();
    if (row.studio) return { id: row.id, forked: false };
    return { id: forkLorebookRow(tx, row), forked: true };
  });
}

/** 请求体 `studio: true`：工作台里新建的实体打上「工作台的」标记 */
export function studioMarkerFromBody(value: unknown): StudioMarker | null {
  return value === true ? { sourceId: null } : null;
}
