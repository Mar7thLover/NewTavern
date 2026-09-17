import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';

export type AssetKind =
  'avatar' | 'background' | 'emotion' | 'generated' | 'upload' | 'card_embedded';

export type AssetRow = typeof schema.assets.$inferSelect;

export interface SaveAssetInput {
  bytes: Uint8Array;
  kind: AssetKind;
  mime: string;
  source?: string;
  meta?: Record<string, unknown>;
}

type ImageSize = { width: number; height: number };

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

/** PNG：IHDR 的宽高在 16..24 字节 */
function pngSize(bytes: Uint8Array, view: DataView): ImageSize | undefined {
  if (bytes.length < 24 || !startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return undefined;
  }
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** JPEG 里带尺寸的 SOF 段（C0–CF，去掉 DHT C4、JPG C8、DAC CC） */
const JPEG_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/** JPEG：顺着段长度跳到第一个 SOF 段，读 高(2) 宽(2) */
function jpegSize(bytes: Uint8Array, view: DataView): ImageSize | undefined {
  if (!startsWith(bytes, [0xff, 0xd8])) return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] as number;
    // 填充字节 0xFF 连续出现
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // 无长度的独立标记：TEM、RST0–7、SOI
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    // EOI / SOS 之后没有尺寸可读了
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = view.getUint16(offset + 2);
    if (length < 2) return undefined;
    if (JPEG_SOF.has(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

/** WebP：VP8（有损）/ VP8L（无损）/ VP8X（扩展，画布尺寸） */
function webpSize(bytes: Uint8Array, view: DataView): ImageSize | undefined {
  if (
    bytes.length < 30 ||
    !startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) ||
    !startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return undefined;
  }
  const chunk = String.fromCharCode(...bytes.subarray(12, 16));
  if (chunk === 'VP8 ') {
    // 帧头 3 字节 + 起始码 9d 01 2a，之后是 14 位宽高
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], 23)) return undefined;
    return {
      width: view.getUint16(26, true) & 0x3fff,
      height: view.getUint16(28, true) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (bytes[20] !== 0x2f) return undefined;
    const b0 = bytes[21] as number;
    const b1 = bytes[22] as number;
    const b2 = bytes[23] as number;
    const b3 = bytes[24] as number;
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8X') {
    const read24 = (at: number) =>
      (bytes[at] as number) | ((bytes[at + 1] as number) << 8) | ((bytes[at + 2] as number) << 16);
    return { width: 1 + read24(24), height: 1 + read24(27) };
  }
  return undefined;
}

/** GIF：逻辑屏幕宽高（小端） */
function gifSize(bytes: Uint8Array, view: DataView): ImageSize | undefined {
  if (bytes.length < 10) return undefined;
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return undefined;
  return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
}

/** 按 mime 读图片宽高；不认识或文件头损坏时返回 undefined */
export function readImageSize(bytes: Uint8Array, mime: string): ImageSize | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    switch (mime) {
      case 'image/png':
        return pngSize(bytes, view);
      case 'image/jpeg':
        return jpegSize(bytes, view);
      case 'image/webp':
        return webpSize(bytes, view);
      case 'image/gif':
        return gifSize(bytes, view);
      default:
        return undefined;
    }
  } catch {
    // DataView 越界：文件头被截断
    return undefined;
  }
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface AssetsService {
  save(input: SaveAssetInput): AssetRow;
  resolvePath(asset: Pick<AssetRow, 'path'>): string;
  getById(id: string): AssetRow | undefined;
  getBySha256(sha256: string): AssetRow | undefined;
  /** 读文件字节；行或文件不存在时返回 undefined */
  readBytes(asset: Pick<AssetRow, 'path'>): Buffer | undefined;
  /** 合并写 meta（浅合并） */
  updateMeta(id: string, patch: Record<string, unknown>): AssetRow | undefined;
  /** 删除行与文件；返回释放的字节数（文件已不在时为 0） */
  remove(asset: Pick<AssetRow, 'id' | 'path'>): number;
  /**
   * 记一笔「刚被上传端点返回过」。去重命中时库里的 createdAt 可能很早，
   * 清理（GC）按这张表额外保护 24 小时，免得用户正要发送的附件被删。只在进程内存里。
   */
  markRecentlyUsed(id: string, at?: number): void;
  recentlyUsedAt(id: string): number | undefined;
}

/** 内容寻址资产存储：同 sha256 去重，文件落在 data/assets/<xx>/<sha256> */
export function createAssetsService(db: Db, dataDir: string): AssetsService {
  const recent = new Map<string, number>();

  const getById = (id: string) =>
    db.select().from(schema.assets).where(eq(schema.assets.id, id)).get();

  return {
    save(input) {
      const sha256 = sha256Of(input.bytes);
      const existing = db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.sha256, sha256))
        .get();
      if (existing) {
        // 行还在但文件丢了（手动清理过数据目录）：按本次内容补回文件
        const absPath = path.join(dataDir, existing.path);
        if (!fs.existsSync(absPath)) {
          fs.mkdirSync(path.dirname(absPath), { recursive: true });
          fs.writeFileSync(absPath, input.bytes);
        }
        return existing;
      }

      const relPath = path.join('assets', sha256.slice(0, 2), sha256);
      const absPath = path.join(dataDir, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, input.bytes);

      const size = readImageSize(input.bytes, input.mime);
      return db
        .insert(schema.assets)
        .values({
          kind: input.kind,
          mime: input.mime,
          path: relPath,
          sha256,
          width: size?.width,
          height: size?.height,
          source: input.source,
          meta: input.meta,
        })
        .returning()
        .get();
    },
    resolvePath(asset) {
      return path.join(dataDir, asset.path);
    },
    getById,
    getBySha256(sha256) {
      return db.select().from(schema.assets).where(eq(schema.assets.sha256, sha256)).get();
    },
    readBytes(asset) {
      try {
        return fs.readFileSync(path.join(dataDir, asset.path));
      } catch {
        return undefined;
      }
    },
    updateMeta(id, patch) {
      const row = getById(id);
      if (!row) return undefined;
      return db
        .update(schema.assets)
        .set({ meta: { ...(row.meta ?? {}), ...patch } })
        .where(eq(schema.assets.id, id))
        .returning()
        .get();
    },
    remove(asset) {
      const absPath = path.join(dataDir, asset.path);
      let freed = 0;
      try {
        freed = fs.statSync(absPath).size;
        fs.rmSync(absPath, { force: true });
      } catch {
        freed = 0;
      }
      db.delete(schema.assets).where(eq(schema.assets.id, asset.id)).run();
      recent.delete(asset.id);
      return freed;
    },
    markRecentlyUsed(id, at = Date.now()) {
      recent.set(id, at);
    },
    recentlyUsedAt(id) {
      return recent.get(id);
    },
  };
}
