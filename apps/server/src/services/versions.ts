import { and, desc, eq, lte, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { lorebookSnapshot } from './lorebook-edit.js';

/**
 * 实体版本历史（M6 §2.2）：角色卡 / 预设 / 世界书，表 `entity_versions`。
 *
 * 版本数据与工作台草稿同形：
 * - character：完整 CCv3 data（`characters.data`）；
 * - preset：ST 预设 data（`presets.data`；预设名只在 data 自带 name 时随之进版本）；
 *   布局策略非空时另放在保留键 `__layoutPolicy` 里（恢复时取出写回 `layout_policy` 列）；
 * - lorebook：`{ name, entries }`，见 `lorebookSnapshot`。
 *
 * 与上一版 JSON 相同则不写；每个实体只保留最近 `MAX_VERSIONS` 版。
 */

export type EntityType = 'character' | 'preset' | 'lorebook';
export type VersionAuthor = 'user' | 'ai';

export const ENTITY_TYPES: readonly EntityType[] = ['character', 'preset', 'lorebook'];
export const MAX_VERSIONS = 50;
/** 预设版本数据里存放 `presets.layout_policy` 的保留键 */
export const PRESET_LAYOUT_POLICY_KEY = '__layoutPolicy';

export interface VersionSummary {
  version: number;
  author: VersionAuthor;
  createdAt: Date;
  /** 版本数据 JSON 的字节数 */
  size: number;
}

export interface RecentEntity {
  type: EntityType;
  id: string;
  name: string;
  version: number;
  author: VersionAuthor;
  updatedAt: Date;
}

export function isEntityType(value: unknown): value is EntityType {
  return ENTITY_TYPES.includes(value as EntityType);
}

/** 请求体 `author`：只认 'ai'，其余一律记 user */
export function parseAuthor(value: unknown): VersionAuthor {
  return value === 'ai' ? 'ai' : 'user';
}

const where = (type: EntityType, id: string) =>
  and(eq(schema.entityVersions.entityType, type), eq(schema.entityVersions.entityId, id));

function latestRow(db: Db, type: EntityType, id: string) {
  return db
    .select()
    .from(schema.entityVersions)
    .where(where(type, id))
    .orderBy(desc(schema.entityVersions.version))
    .limit(1)
    .get();
}

/** 写一版，返回版本号；与上一版 JSON 相同则不写，返回上一版的版本号 */
export function recordVersion(
  db: Db,
  type: EntityType,
  id: string,
  data: unknown,
  author: VersionAuthor = 'user',
): number {
  const latest = latestRow(db, type, id);
  if (latest && JSON.stringify(latest.data) === JSON.stringify(data)) return latest.version;
  const version = (latest?.version ?? 0) + 1;
  db.insert(schema.entityVersions)
    .values({ entityType: type, entityId: id, version, data: data ?? null, author })
    .run();
  // 只留最近 MAX_VERSIONS 版（版本号连续递增，删掉更旧的即可）
  db.delete(schema.entityVersions)
    .where(and(where(type, id), lte(schema.entityVersions.version, version - MAX_VERSIONS)))
    .run();
  return version;
}

/** 读实体当前内容，与版本数据同形；实体不存在返回 undefined */
export function currentVersionData(db: Db, type: EntityType, id: string): unknown {
  if (type === 'lorebook') return lorebookSnapshot(db, id);
  if (type === 'preset') {
    const row = db
      .select({ data: schema.presets.data, layoutPolicy: schema.presets.layoutPolicy })
      .from(schema.presets)
      .where(eq(schema.presets.id, id))
      .get();
    if (!row) return undefined;
    return row.layoutPolicy
      ? { ...(row.data as Record<string, unknown>), [PRESET_LAYOUT_POLICY_KEY]: row.layoutPolicy }
      : row.data;
  }
  return db
    .select({ data: schema.characters.data })
    .from(schema.characters)
    .where(eq(schema.characters.id, id))
    .get()?.data;
}

/** 按实体当前内容写一版（导入 / 保存之后调用）；实体不存在时返回 null */
export function recordCurrentVersion(
  db: Db,
  type: EntityType,
  id: string,
  author: VersionAuthor = 'user',
): number | null {
  const data = currentVersionData(db, type, id);
  if (data === undefined) return null;
  return recordVersion(db, type, id, data, author);
}

export function listVersions(db: Db, type: EntityType, id: string): VersionSummary[] {
  return db
    .select({
      version: schema.entityVersions.version,
      author: schema.entityVersions.author,
      createdAt: schema.entityVersions.createdAt,
      size: sql<number>`length(CAST(${schema.entityVersions.data} AS BLOB))`,
    })
    .from(schema.entityVersions)
    .where(where(type, id))
    .orderBy(desc(schema.entityVersions.version))
    .all();
}

export function getVersion(db: Db, type: EntityType, id: string, version: number): unknown {
  const row = db
    .select({ data: schema.entityVersions.data })
    .from(schema.entityVersions)
    .where(and(where(type, id), eq(schema.entityVersions.version, version)))
    .get();
  return row?.data;
}

/** 删实体时顺手清掉它的版本 */
export function deleteVersions(db: Db, type: EntityType, id: string): void {
  db.delete(schema.entityVersions).where(where(type, id)).run();
}

/**
 * 最近编辑过的实体（工作台入口页「最近编辑」）：按各实体最新一版的时间倒序，
 * 已删除的实体跳过。
 */
export function listRecentEntities(db: Db, limit = 20, type?: EntityType): RecentEntity[] {
  const latest = db
    .select({
      type: schema.entityVersions.entityType,
      id: schema.entityVersions.entityId,
      version: sql<number>`max(${schema.entityVersions.version})`,
    })
    .from(schema.entityVersions)
    .where(type ? eq(schema.entityVersions.entityType, type) : undefined)
    .groupBy(schema.entityVersions.entityType, schema.entityVersions.entityId)
    .all();

  const out: RecentEntity[] = [];
  for (const item of latest) {
    if (!isEntityType(item.type)) continue;
    const row = db
      .select()
      .from(schema.entityVersions)
      .where(and(where(item.type, item.id), eq(schema.entityVersions.version, item.version)))
      .get();
    const name = entityName(db, item.type, item.id);
    if (!row || name === undefined) continue;
    out.push({
      type: item.type,
      id: item.id,
      name,
      version: row.version,
      author: row.author,
      updatedAt: row.createdAt,
    });
  }
  return out.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()).slice(0, limit);
}

function entityName(db: Db, type: EntityType, id: string): string | undefined {
  const table =
    type === 'character'
      ? schema.characters
      : type === 'preset'
        ? schema.presets
        : schema.lorebooks;
  return db.select({ name: table.name }).from(table).where(eq(table.id, id)).get()?.name;
}
