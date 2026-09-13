import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';

export type AssetKind =
  'avatar' | 'background' | 'emotion' | 'generated' | 'upload' | 'card_embedded';

type AssetRow = typeof schema.assets.$inferSelect;

export interface SaveAssetInput {
  bytes: Uint8Array;
  kind: AssetKind;
  mime: string;
  source?: string;
  meta?: Record<string, unknown>;
}

/** 从 PNG IHDR 读宽高；其他格式 M1 暂不解析 */
function readImageSize(
  bytes: Uint8Array,
  mime: string,
): { width: number; height: number } | undefined {
  if (mime !== 'image/png' || bytes.length < 24) return undefined;
  const pngSig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!pngSig.every((b, i) => bytes[i] === b)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface AssetsService {
  save(input: SaveAssetInput): AssetRow;
  resolvePath(asset: Pick<AssetRow, 'path'>): string;
  getById(id: string): AssetRow | undefined;
}

/** 内容寻址资产存储：同 sha256 去重，文件落在 data/assets/<xx>/<sha256> */
export function createAssetsService(db: Db, dataDir: string): AssetsService {
  return {
    save(input) {
      const sha256 = createHash('sha256').update(input.bytes).digest('hex');
      const existing = db
        .select()
        .from(schema.assets)
        .where(eq(schema.assets.sha256, sha256))
        .get();
      if (existing) return existing;

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
    getById(id) {
      return db.select().from(schema.assets).where(eq(schema.assets.id, id)).get();
    },
  };
}
