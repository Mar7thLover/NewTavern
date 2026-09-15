import { extractPresetSampling, parsePreset, presetApiFamily } from '@newtavern/compat';
import { eq, isNull } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { DEFAULT_PRESET } from './assemble.js';

/**
 * 预设库里的「默认预设」与「默认用哪份预设」。做法照 `personas.ts` 的默认用户档案。
 *
 * 设置键：
 * - `defaultPresetId`：新建对话不带 `presetId` 字段时套用的预设 id；没有默认时不存在该行；
 * - `builtinPresetId`：启动种子写入的那份「默认预设」的 id（只有它能「恢复内置内容」）；
 * - `builtinPresetSeeded`：种过一次就写 true，用来区分「用户删了」与「从没种过」——删了不再种回。
 */
export const DEFAULT_PRESET_KEY = 'defaultPresetId';
export const BUILTIN_PRESET_KEY = 'builtinPresetId';
export const BUILTIN_PRESET_SEEDED_KEY = 'builtinPresetSeeded';

export const BUILTIN_PRESET_NAME = '默认预设';

type PresetRow = typeof schema.presets.$inferSelect;
type Tx = Pick<Db, 'select' | 'insert' | 'update' | 'delete'>;

function readSetting(db: Tx, key: string): unknown {
  return db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value;
}

function writeSetting(db: Tx, key: string, value: unknown): void {
  db.insert(schema.settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } })
    .run();
}

function presetExists(db: Tx, id: string): boolean {
  return (
    db
      .select({ id: schema.presets.id })
      .from(schema.presets)
      .where(eq(schema.presets.id, id))
      .get() !== undefined
  );
}

/** 内置预设内容的深拷贝，并过一遍 `parsePreset`（与 PUT 用的是同一份校验） */
export function builtinPresetData(): ReturnType<typeof parsePreset> {
  return parsePreset(structuredClone(DEFAULT_PRESET.data));
}

/** 用一份 data 生成插入/更新预设行需要的列（sampling / apiFamily 从 data 算） */
export function presetColumns(data: ReturnType<typeof parsePreset>) {
  return { data, sampling: extractPresetSampling(data), apiFamily: presetApiFamily(data) };
}

/** 默认预设 id；设置里的 id 已不存在（脏数据）时当作没有 */
export function readDefaultPresetId(db: Db): string | null {
  const value = readSetting(db, DEFAULT_PRESET_KEY);
  return typeof value === 'string' && presetExists(db, value) ? value : null;
}

/** 种子写入的那份默认预设 id；行已不存在时返回 null */
export function readBuiltinPresetId(db: Db): string | null {
  const value = readSetting(db, BUILTIN_PRESET_KEY);
  return typeof value === 'string' && presetExists(db, value) ? value : null;
}

/** 删除预设时：它若是默认预设 / 种子预设，清掉对应设置（`builtinPresetSeeded` 保留，不会再种回） */
export function clearPresetSettingsIf(db: Db, presetId: string): void {
  for (const key of [DEFAULT_PRESET_KEY, BUILTIN_PRESET_KEY]) {
    if (readSetting(db, key) === presetId) {
      db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
    }
  }
}

/**
 * 启动种子（幂等）：把内置默认预设写进预设库。
 *
 * - 已种过（`builtinPresetSeeded`）→ 什么都不做，哪怕用户已经删掉了它；
 * - 没有种过标记但 `builtinPresetId` 指向一行现存预设 → 只补标记；
 * - 否则在一个事务里：插入「默认预设」、记下 `builtinPresetId` 与种过标记、
 *   `defaultPresetId` 为空（或指向已删除的行）时设为它，并把现有 `presetId IS NULL` 的会话改绑过来
 *   （这些会话原来的实际行为就是用内置预设，改绑后不变）。
 *
 * 返回新插入的行；没有插入时返回 null。
 */
export function seedBuiltinPreset(db: Db): PresetRow | null {
  return db.transaction((tx) => {
    if (readSetting(tx, BUILTIN_PRESET_SEEDED_KEY) === true) return null;

    const existingId = readSetting(tx, BUILTIN_PRESET_KEY);
    if (typeof existingId === 'string' && presetExists(tx, existingId)) {
      writeSetting(tx, BUILTIN_PRESET_SEEDED_KEY, true);
      return null;
    }

    const row = tx
      .insert(schema.presets)
      .values({
        name: BUILTIN_PRESET_NAME,
        format: DEFAULT_PRESET.format,
        ...presetColumns(builtinPresetData()),
      })
      .returning()
      .get();
    writeSetting(tx, BUILTIN_PRESET_KEY, row.id);
    writeSetting(tx, BUILTIN_PRESET_SEEDED_KEY, true);

    const currentDefault = readSetting(tx, DEFAULT_PRESET_KEY);
    if (typeof currentDefault !== 'string' || !presetExists(tx, currentDefault)) {
      writeSetting(tx, DEFAULT_PRESET_KEY, row.id);
    }

    tx.update(schema.chats).set({ presetId: row.id }).where(isNull(schema.chats.presetId)).run();
    return row;
  });
}
