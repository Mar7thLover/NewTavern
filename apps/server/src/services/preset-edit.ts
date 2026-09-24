import { parsePreset } from '@newtavern/compat';
import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { presetColumns } from './presets.js';
import { recordCurrentVersion, type VersionAuthor } from './versions.js';

/**
 * 预设整份替换（`PUT /api/presets/:id` 与版本恢复共用，M6 §2.2）。
 * `parsePreset`（looseObject）校验，未知字段原样保留；`sampling` / `apiFamily` 从新 data 重算。
 */

export class PresetInputError extends Error {}

/**
 * 预设的布局策略（`presets.layout_policy`，M6 §4.2 的布局策略与保真锁；组装暂不读它）。
 * 全部可选；null = 清空（跟随默认）。
 */
export interface PresetLayoutPolicy {
  /** 布局模式；缺省 = 跟随会话 / 导入默认 */
  mode?: 'strict' | 'cache-aware';
  /** 保真锁：锁定的提示词条目 identifier（布局器不得移动） */
  lockedIdentifiers?: string[];
  tailWindow?: number;
  volatileHandling?: 'freeze' | 'warn';
  wiCarrierRole?: 'system' | 'user';
  ttl?: '5m' | '1h';
}

const LAYOUT_ENUMS: Record<string, readonly string[]> = {
  mode: ['strict', 'cache-aware'],
  volatileHandling: ['freeze', 'warn'],
  wiCarrierRole: ['system', 'user'],
  ttl: ['5m', '1h'],
};

/** 校验 layoutPolicy：对象（只认上面的键）或 null */
export function parseLayoutPolicy(value: unknown): PresetLayoutPolicy | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new PresetInputError('layoutPolicy 必须是对象或 null');
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || item === null) continue;
    const allowed = LAYOUT_ENUMS[key];
    if (allowed) {
      if (!allowed.includes(item as string)) {
        throw new PresetInputError(`layoutPolicy.${key} 只能是 ${allowed.join(' / ')}`);
      }
    } else if (key === 'lockedIdentifiers') {
      if (!Array.isArray(item) || item.some((id) => typeof id !== 'string')) {
        throw new PresetInputError('layoutPolicy.lockedIdentifiers 必须是字符串数组');
      }
    } else if (key === 'tailWindow') {
      if (!(typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 1000)) {
        throw new PresetInputError('layoutPolicy.tailWindow 应为 0–1000 的整数');
      }
    } else {
      throw new PresetInputError(`layoutPolicy.${key} 不是可识别的字段`);
    }
    out[key] = item;
  }
  return out as PresetLayoutPolicy;
}
export class PresetNotFoundError extends Error {}

type PresetRow = typeof schema.presets.$inferSelect;

/** 预设 JSON 自带 name 时与列保持一致；ST 导出的预设大多没有这个字段，不凭空添加 */
export function syncDataName(data: Record<string, unknown>, name: string): void {
  if ('name' in data) data.name = name;
}

export function updatePreset(
  db: Db,
  id: string,
  input: { name?: unknown; data: unknown; layoutPolicy?: unknown },
  author: VersionAuthor = 'user',
): PresetRow {
  const current = db.select().from(schema.presets).where(eq(schema.presets.id, id)).get();
  if (!current) throw new PresetNotFoundError();

  let name = current.name;
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.trim() === '') {
      throw new PresetInputError('name 不能为空');
    }
    name = input.name.trim();
  }
  if (input.data === undefined) throw new PresetInputError('缺少 data');

  let data: ReturnType<typeof parsePreset>;
  try {
    data = parsePreset(input.data);
  } catch (e) {
    throw new PresetInputError((e as Error).message);
  }
  syncDataName(data, name);
  // 缺省 = 不动；null = 清空
  const layoutPolicy =
    input.layoutPolicy === undefined ? undefined : parseLayoutPolicy(input.layoutPolicy);

  const row = db
    .update(schema.presets)
    .set({
      name,
      ...presetColumns(data),
      ...(layoutPolicy === undefined
        ? {}
        : { layoutPolicy: layoutPolicy as Record<string, unknown> | null }),
      updatedAt: new Date(),
    })
    .where(eq(schema.presets.id, id))
    .returning()
    .get();
  recordCurrentVersion(db, 'preset', id, author);
  return row;
}

/**
 * 只写布局策略（`PUT /api/presets/:id/layout-policy`）：不需要带整份 data，
 * 前端的布局策略 / 保真锁开关单独保存用。null = 清空（跟随会话 / 导入默认）。
 * 预设版本数据里带着布局策略（保留键 `__layoutPolicy`），所以同样写一版。
 */
export function updatePresetLayoutPolicy(
  db: Db,
  id: string,
  value: unknown,
  author: VersionAuthor = 'user',
): PresetRow {
  const current = db.select().from(schema.presets).where(eq(schema.presets.id, id)).get();
  if (!current) throw new PresetNotFoundError();
  if (value === undefined) throw new PresetInputError('缺少 layoutPolicy（清空请传 null）');
  const layoutPolicy = parseLayoutPolicy(value);
  const row = db
    .update(schema.presets)
    .set({
      // 空对象与 null 等价：都是「全部跟随默认」
      layoutPolicy:
        layoutPolicy && Object.keys(layoutPolicy).length > 0
          ? (layoutPolicy as Record<string, unknown>)
          : null,
      updatedAt: new Date(),
    })
    .where(eq(schema.presets.id, id))
    .returning()
    .get();
  recordCurrentVersion(db, 'preset', id, author);
  return row;
}
