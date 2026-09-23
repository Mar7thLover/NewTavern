import { inflateRawSync } from 'node:zlib';

import {
  readCardEmbeddedAssets,
  resolveEmbeddedUri,
  type V3Card,
} from '@newtavern/compat';
import { and, asc, eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { AssetsService } from './assets.js';

/**
 * 立绘表情（M4（二）契约 §B）：`character_sprites` 一行 = 角色 × 标签 → 资产。
 * 资产 kind 为 `emotion`（media-gc 不回收）。
 */

/** ST 表情扩展的 28 个默认标签 */
export const DEFAULT_EXPRESSIONS = [
  'admiration',
  'amusement',
  'anger',
  'annoyance',
  'approval',
  'caring',
  'confusion',
  'curiosity',
  'desire',
  'disappointment',
  'disapproval',
  'disgust',
  'embarrassment',
  'excitement',
  'fear',
  'gratitude',
  'grief',
  'joy',
  'love',
  'nervousness',
  'neutral',
  'optimism',
  'pride',
  'realization',
  'relief',
  'remorse',
  'sadness',
  'surprise',
] as const;

/** 单张立绘上限（ST 的立绘常是大尺寸透明 PNG） */
export const SPRITE_MAX_BYTES = 20 * 1024 * 1024;
/** 立绘包 zip 上限（压缩后 / 解压后） */
export const SPRITE_ZIP_MAX_BYTES = 200 * 1024 * 1024;
const SPRITE_ZIP_MAX_UNPACKED = 400 * 1024 * 1024;
const SPRITE_ZIP_MAX_ENTRIES = 2000;

export interface SpriteItem {
  label: string;
  assetId: string;
}

export interface SpriteImportResult {
  imported: string[];
  skipped: { file: string; reason: string }[];
}

const ASCII_LABEL = /^[a-z0-9_-]{1,32}$/;
const HAN = /\p{Script=Han}/u;
/** 中文标签里不许出现的：控制字符、路径分隔、引号与尖括号 */
const LABEL_FORBIDDEN = /[\p{Cc}\\/"'<>`]/u;

/**
 * 标签规范化：去首尾空白；ASCII 标签转小写后须是 `[a-z0-9_-]{1,32}`；
 * 含中文的标签（≤ 32 字）原样接受。其余返回 null。
 */
export function normalizeSpriteLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (ASCII_LABEL.test(lower)) return lower;
  if (HAN.test(trimmed) && Array.from(trimmed).length <= 32 && !LABEL_FORBIDDEN.test(trimmed)) {
    return trimmed;
  }
  return null;
}

const IMAGE_EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

/** 按文件头识别立绘图片类型 */
export function sniffSpriteMime(bytes: Uint8Array): string | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (starts([0x66, 0x74, 0x79, 0x70], 4) && starts([0x61, 0x76, 0x69], 8)) return 'image/avif';
  return null;
}

/** `joy.png` → `joy`；`sprites/Joy.PNG` → `joy`；不是图片扩展名返回 null */
export function labelFromFileName(fileName: string): string | null {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const match = /^(.+)\.([a-z0-9]+)$/i.exec(base);
  if (!match) return null;
  const ext = (match[2] ?? '').toLowerCase();
  if (!IMAGE_EXT_MIME[ext]) return null;
  return normalizeSpriteLabel(match[1]);
}

/* ------------------------------------------------------------------ */
/* 读写                                                                 */
/* ------------------------------------------------------------------ */

export function listSprites(db: Db, characterId: string): SpriteItem[] {
  return db
    .select({ label: schema.characterSprites.label, assetId: schema.characterSprites.assetId })
    .from(schema.characterSprites)
    .where(eq(schema.characterSprites.characterId, characterId))
    .orderBy(asc(schema.characterSprites.label))
    .all();
}

/** 写一张立绘（同标签覆盖）；图片格式不认识时抛错 */
export function putSprite(
  db: Db,
  assets: AssetsService,
  input: { characterId: string; label: string; bytes: Uint8Array; source: string },
): SpriteItem {
  const mime = sniffSpriteMime(input.bytes);
  if (!mime) throw new SpriteError('只支持 PNG、JPEG、WebP、GIF、AVIF 图片');
  const asset = assets.save({
    bytes: input.bytes,
    mime,
    kind: 'emotion',
    source: input.source,
    meta: { label: input.label },
  });
  db.insert(schema.characterSprites)
    .values({ characterId: input.characterId, label: input.label, assetId: asset.id })
    .onConflictDoUpdate({
      target: [schema.characterSprites.characterId, schema.characterSprites.label],
      set: { assetId: asset.id, createdAt: new Date() },
    })
    .run();
  return { label: input.label, assetId: asset.id };
}

/** 删一张立绘的绑定（资产按内容寻址，可能被别处引用，不删文件） */
export function deleteSprite(db: Db, characterId: string, label: string): boolean {
  const row = db
    .delete(schema.characterSprites)
    .where(
      and(
        eq(schema.characterSprites.characterId, characterId),
        eq(schema.characterSprites.label, label),
      ),
    )
    .returning()
    .get();
  return row !== undefined;
}

export class SpriteError extends Error {}

/** 一批「文件名 → 字节」写进去：文件名去扩展名作标签，同名覆盖 */
export function importSpriteFiles(
  db: Db,
  assets: AssetsService,
  characterId: string,
  files: Iterable<[string, Uint8Array]>,
  source: string,
): SpriteImportResult {
  const result: SpriteImportResult = { imported: [], skipped: [] };
  for (const [file, bytes] of files) {
    const label = labelFromFileName(file);
    if (!label) {
      result.skipped.push({ file, reason: '文件名不是合法的表情标签或不是图片' });
      continue;
    }
    if (bytes.length > SPRITE_MAX_BYTES) {
      result.skipped.push({ file, reason: '超过 20 MB' });
      continue;
    }
    try {
      putSprite(db, assets, { characterId, label, bytes, source });
      if (!result.imported.includes(label)) result.imported.push(label);
    } catch (e) {
      result.skipped.push({ file, reason: (e as Error).message });
    }
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* zip（ST 的立绘包）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 最小的 zip 读取：只读中央目录里的 stored(0) / deflate(8) 条目，跳过目录与加密项。
 * 服务端不引入额外依赖；条目数与解压总量都有上限（防 zip 炸弹）。
 */
export function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 找 EOCD（0x06054b50），从尾部往前搜，注释最长 65535
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SpriteError('不是有效的 zip 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count > SPRITE_ZIP_MAX_ENTRIES) throw new SpriteError('zip 里的文件太多');

  const out = new Map<string, Uint8Array>();
  let unpacked = 0;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new SpriteError('zip 目录损坏');
    }
    const flags = buf.readUInt16LE(offset + 8);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const nameBytes = buf.subarray(offset + 46, offset + 46 + nameLen);
    // bit 11 = UTF-8；没置位的多半是 GBK / CP437，一律按 UTF-8 尽力解
    // （英文标签不受影响；乱码的中文标签会被标签规则拒掉，列进 skipped）
    const name = nameBytes.toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/') || flags & 0x1) continue;
    if (name.split('/').some((part) => part === '__MACOSX' || part.startsWith('._'))) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localName = buf.readUInt16LE(localOffset + 26);
    const localExtra = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localName + localExtra;
    const raw = buf.subarray(start, start + compSize);
    unpacked += size;
    if (unpacked > SPRITE_ZIP_MAX_UNPACKED) throw new SpriteError('zip 解压后太大');
    let data: Uint8Array;
    if (method === 0) data = new Uint8Array(raw);
    else if (method === 8) {
      try {
        data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: SPRITE_MAX_BYTES + 1 }));
      } catch {
        continue;
      }
    } else continue;
    out.set(name, data);
  }
  return out;
}

export function importSpriteZip(
  db: Db,
  assets: AssetsService,
  characterId: string,
  zipBytes: Uint8Array,
  source: string,
): SpriteImportResult {
  const entries = readZipEntries(zipBytes);
  return importSpriteFiles(db, assets, characterId, entries, source);
}

/* ------------------------------------------------------------------ */
/* 角色卡自带的表情资源                                                  */
/* ------------------------------------------------------------------ */

/**
 * CHARX / PNG 卡里 `type:'emotion'` 的资源 → `character_sprites`（`name` 为标签）。
 * - CHARX：`embeded://assets/...` 指向 zip 里的文件；
 * - PNG：ST / RisuAI 把资源写进 `chara-ext-asset_:<key>` tEXt 块，卡里 uri 为 `__asset:<key>`
 *   （也兼容直接写路径 / `embeded://路径` 的写法）。
 * 找不到字节或标签不合法的跳过；返回写进去的标签。
 */
export function importCardSprites(
  db: Db,
  assets: AssetsService,
  characterId: string,
  card: V3Card,
  source: { charxFiles?: ReadonlyMap<string, Uint8Array>; pngBytes?: Uint8Array },
): string[] {
  const list = (card.data.assets ?? []).filter((asset) => asset.type === 'emotion');
  if (list.length === 0) return [];
  let pngAssets: Map<string, Uint8Array> | null = null;
  if (source.pngBytes) {
    try {
      pngAssets = readCardEmbeddedAssets(source.pngBytes);
    } catch {
      pngAssets = null;
    }
  }
  const imported: string[] = [];
  for (const asset of list) {
    const label = normalizeSpriteLabel(asset.name);
    if (!label) continue;
    const uri = typeof asset.uri === 'string' ? asset.uri : '';
    const embedded = resolveEmbeddedUri(uri);
    let bytes: Uint8Array | undefined;
    if (source.charxFiles) {
      bytes = embedded ? source.charxFiles.get(embedded) : undefined;
    }
    if (!bytes && pngAssets) {
      const key = uri.startsWith('__asset:') ? uri.slice('__asset:'.length) : (embedded ?? uri);
      bytes = pngAssets.get(key) ?? (embedded ? pngAssets.get(embedded) : undefined);
    }
    if (!bytes || !sniffSpriteMime(bytes)) continue;
    try {
      putSprite(db, assets, { characterId, label, bytes, source: `card:${characterId}` });
      if (!imported.includes(label)) imported.push(label);
    } catch {
      // 单张坏图不影响导卡
    }
  }
  return imported;
}
