import { desc, eq, or, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { AssetRow, AssetsService } from './assets.js';

/**
 * 背景库（M4（二）契约 §A）。
 *
 * 背景 = `assets.kind='background'` 的资产，`meta.name` 存显示名。
 * 资产按内容寻址：同一张图先以别的身份入过库（比如聊天附件）时，`save` 会返回那一行，
 * 这种情况不改它的 kind，只在 meta 上打 `background: true` 标记，列表把两种都算上。
 *
 * 生效顺序：会话 `chats.metadata.background` > 角色 settings `backgroundByCharacter` > 全局 `defaultBackground`。
 */

export const DEFAULT_BACKGROUND_KEY = 'defaultBackground';
export const BACKGROUND_BY_CHARACTER_KEY = 'backgroundByCharacter';

/** 上传上限 20 MB */
export const BACKGROUND_MAX_BYTES = 20 * 1024 * 1024;

export interface BackgroundItem {
  assetId: string;
  name: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

/** 按文件头识别背景图片类型，不信任客户端给的 content-type */
export function sniffBackgroundMime(bytes: Uint8Array): string | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  // ISO BMFF：....ftypavif / ftypavis
  if (
    starts([0x66, 0x74, 0x79, 0x70], 4) &&
    (starts([0x61, 0x76, 0x69, 0x66], 8) || starts([0x61, 0x76, 0x69, 0x73], 8))
  ) {
    return 'image/avif';
  }
  return null;
}

/** 文件名 → 显示名（去目录与扩展名；空了就用「背景」） */
export function backgroundNameOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const name = base.replace(/\.[^.]+$/, '').trim();
  return name.slice(0, 120) || '背景';
}

function isBackgroundRow(row: AssetRow): boolean {
  return row.kind === 'background' || row.meta?.['background'] === true;
}

export function toBackgroundItem(row: AssetRow): BackgroundItem {
  const name = row.meta?.['name'];
  return {
    assetId: row.id,
    name: typeof name === 'string' && name ? name : '背景',
    width: row.width ?? null,
    height: row.height ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function listBackgrounds(db: Db): BackgroundItem[] {
  return db
    .select()
    .from(schema.assets)
    .where(
      or(
        eq(schema.assets.kind, 'background'),
        sql`json_extract(${schema.assets.meta}, '$.background') = 1`,
      ),
    )
    .orderBy(desc(schema.assets.createdAt))
    .all()
    .filter(isBackgroundRow)
    .map(toBackgroundItem);
}

export function getBackground(db: Db, assetId: string): AssetRow | undefined {
  const row = db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get();
  return row && isBackgroundRow(row) ? row : undefined;
}

/** 存一张背景：新图建 `background` 资产；内容已在库里（别的身份）就只打标记、补名字 */
export function saveBackground(
  assets: AssetsService,
  input: { bytes: Uint8Array; mime: string; name: string; source: string },
): AssetRow {
  const row = assets.save({
    bytes: input.bytes,
    mime: input.mime,
    kind: 'background',
    source: input.source,
    meta: { name: input.name, background: true },
  });
  if (row.kind === 'background' && row.meta?.['background'] === true) return row;
  const existingName = row.meta?.['name'];
  return (
    assets.updateMeta(row.id, {
      background: true,
      name: typeof existingName === 'string' && existingName ? existingName : input.name,
    }) ?? row
  );
}

export function renameBackground(
  db: Db,
  assets: AssetsService,
  assetId: string,
  name: string,
): AssetRow | undefined {
  if (!getBackground(db, assetId)) return undefined;
  return assets.updateMeta(assetId, { name });
}

function readSetting(db: Db, key: string): unknown {
  return db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value;
}

function writeSetting(db: Db, key: string, value: unknown): void {
  db.insert(schema.settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } })
    .run();
}

/** 删掉一张背景：清掉 settings 里指向它的项；会话 metadata 里的悬空引用读取时当作缺省 */
export function deleteBackground(db: Db, assets: AssetsService, assetId: string): boolean {
  const row = getBackground(db, assetId);
  if (!row) return false;

  if (readSetting(db, DEFAULT_BACKGROUND_KEY) === assetId) {
    // settings.value 不许为 NULL：删掉这一项 = 没有全局默认
    db.delete(schema.settings).where(eq(schema.settings.key, DEFAULT_BACKGROUND_KEY)).run();
  }
  const byCharacter = readSetting(db, BACKGROUND_BY_CHARACTER_KEY);
  if (byCharacter && typeof byCharacter === 'object' && !Array.isArray(byCharacter)) {
    const next = Object.fromEntries(
      Object.entries(byCharacter as Record<string, unknown>).filter(
        ([, value]) => value !== assetId,
      ),
    );
    if (Object.keys(next).length !== Object.keys(byCharacter).length) {
      writeSetting(db, BACKGROUND_BY_CHARACTER_KEY, next);
    }
  }

  if (row.kind === 'background') {
    assets.remove(row);
  } else {
    // 别的身份入库的同一张图：只撤掉背景标记，文件还归原主
    const { background: _flag, ...rest } = row.meta ?? {};
    db.update(schema.assets).set({ meta: rest }).where(eq(schema.assets.id, row.id)).run();
  }
  return true;
}

/**
 * ST 的 `chat_metadata.custom_background`（形如 `url("backgrounds/xxx.jpg")`）→ 文件名。
 * 认不出返回 null。
 */
export function stCustomBackgroundFile(value: unknown): string | null {
  const ref = stCustomBackgroundRef(value);
  const file = ref?.split('/').pop()?.trim();
  return file ? file : null;
}

/**
 * `custom_background` → 解码后的相对路径（`/` 分隔、去掉开头的 `./` 与 `/`）：
 * 系统背景是 `backgrounds/<文件>`（ST `getBackgroundPath` 用 encodeURIComponent 编码），
 * 聊天专属背景（ST `forceSetBackground`，生图扩展等写的）是 `user/images/…`（encodeURI 编码）。
 * 只有文件名时按系统背景处理。`http(s):` / `data:` 等外部地址返回 null。
 */
export function stCustomBackgroundRef(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const match = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(value);
  const raw = (match ? match[2] : value)?.trim() ?? '';
  if (raw === '' || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // 不是合法的 URI 编码：按原样
  }
  const normalized = decoded
    .replace(/\\/g, '/')
    .replace(/^(\.\/|\/)+/, '')
    .trim();
  if (normalized === '') return null;
  return normalized.includes('/') ? normalized : `backgrounds/${normalized}`;
}
