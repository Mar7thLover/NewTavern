import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  PNG_SIGNATURE,
  applyWorldbookEntryColumns,
  buildWorldbook,
  extractPresetSampling,
  listWorldbookEntries,
  normalizeCard,
  parseCardJson,
  parsePreset,
  parseWorldbook,
  pickWorldbookEntryColumns,
  presetApiFamily,
  readCardFromPng,
  readCharx,
  removePngTextChunksWhere,
  resolveEmbeddedUri,
  serializePreset,
  serializeWorldbook,
  toWorldbookEntryColumns,
  writeCardToPng,
  writeCharx,
  type StPreset,
  type StWorldbookEntry,
  type V3Card,
  type WorldbookEntriesForm,
} from '@newtavern/compat';
import { asc, eq, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { AssetsService } from './assets.js';

export type CharacterFormat = 'png' | 'charx' | 'json';

export interface ExportedFile {
  fileName: string;
  mime: string;
  bytes: Uint8Array;
}

/** 导入失败（用户文件问题），路由层转为 400 */
export class ImportError extends Error {}

const FORMAT_MIME: Record<CharacterFormat, string> = {
  png: 'image/png',
  charx: 'application/zip',
  json: 'application/json',
};

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
};

const CARD_TEXT_KEYWORDS = new Set(['ccv3', 'chara']);

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b);
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function sniffCharacterFormat(bytes: Uint8Array): CharacterFormat {
  if (isPng(bytes)) return 'png';
  if (isZip(bytes)) return 'charx';
  return 'json';
}

function baseName(fileName: string): string {
  return path.basename(fileName).replace(/\.[^.]+$/, '') || 'untitled';
}

function parseJsonBytes(bytes: Uint8Array, what: string): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, ''));
  } catch {
    throw new ImportError(`${what}不是有效的 JSON 文件`);
  }
}

/** 把 compat 解析错误统一包装为 ImportError */
function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError((e as Error).message);
  }
}

function toV3Card(data: unknown): V3Card {
  return normalizeCard({ spec: 'chara_card_v3', spec_version: '3.0', data });
}

type LorebookSettings = {
  entriesForm?: WorldbookEntriesForm;
  meta?: Record<string, unknown>;
};

type LorebookEntryExtra = {
  stKey?: string;
  raw?: StWorldbookEntry;
};

export function createImporter(db: Db, assets: AssetsService, dataDir: string) {
  function saveOriginal(bytes: Uint8Array, format: CharacterFormat) {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const relPath = path.join('characters', `${sha256}.${format}`);
    const absPath = path.join(dataDir, relPath);
    if (!fs.existsSync(absPath)) {
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, bytes);
    }
    return { relPath, sha256 };
  }

  function readAssetBytes(assetId: string | null) {
    if (!assetId) return undefined;
    const asset = assets.getById(assetId);
    if (!asset) return undefined;
    const absPath = assets.resolvePath(asset);
    if (!fs.existsSync(absPath)) return undefined;
    return { asset, bytes: new Uint8Array(fs.readFileSync(absPath)) };
  }

  function getCharacter(id: string) {
    return db.select().from(schema.characters).where(eq(schema.characters.id, id)).get();
  }

  return {
    importCharacter(fileName: string, bytes: Uint8Array) {
      const format = sniffCharacterFormat(bytes);
      let card: V3Card;
      let spec: 'v2' | 'v3';
      let avatar: { bytes: Uint8Array; mime: string } | undefined;

      if (format === 'png') {
        const parsed = guard(() => readCardFromPng(bytes));
        spec = parsed.spec;
        card = guard(() => normalizeCard(parsed));
        const image = removePngTextChunksWhere(
          bytes,
          (keyword) => CARD_TEXT_KEYWORDS.has(keyword) || keyword.startsWith('chara-ext-asset_:'),
        );
        avatar = { bytes: image, mime: 'image/png' };
      } else if (format === 'charx') {
        const charx = guard(() => readCharx(bytes));
        spec = 'v3';
        card = charx.card;
        const icon = card.data.assets?.find((a) => a.type === 'icon' && resolveEmbeddedUri(a.uri));
        const iconPath = icon ? resolveEmbeddedUri(icon.uri) : undefined;
        const iconBytes = iconPath ? charx.files.get(iconPath) : undefined;
        const mime = icon ? IMAGE_MIME[icon.ext.toLowerCase()] : undefined;
        if (iconBytes && mime) avatar = { bytes: iconBytes, mime };
      } else {
        const parsed = guard(() => parseCardJson(parseJsonBytes(bytes, '角色卡')));
        spec = parsed.spec;
        card = guard(() => normalizeCard(parsed));
      }

      const original = saveOriginal(bytes, format);
      const avatarAsset = avatar
        ? assets.save({ ...avatar, kind: 'avatar', source: `import:${path.basename(fileName)}` })
        : undefined;

      return db
        .insert(schema.characters)
        .values({
          name: card.data.name,
          spec,
          data: card.data,
          avatarAssetId: avatarAsset?.id ?? null,
          sourcePath: original.relPath,
          originalHash: original.sha256,
          tags: card.data.tags ?? [],
        })
        .returning()
        .get();
    },

    /** 未修改的卡按原格式导出原件；其余格式由 data 重新生成 */
    exportCharacter(id: string, format: CharacterFormat): ExportedFile | undefined {
      const row = getCharacter(id);
      if (!row) return undefined;
      const fileName = `${row.name}.${format}`;
      const mime = FORMAT_MIME[format];

      if (row.sourcePath && row.sourcePath.endsWith(`.${format}`)) {
        const absPath = path.join(dataDir, row.sourcePath);
        if (fs.existsSync(absPath)) {
          return { fileName, mime, bytes: new Uint8Array(fs.readFileSync(absPath)) };
        }
      }

      const card = toV3Card(row.data);
      const avatar = readAssetBytes(row.avatarAssetId);
      if (format === 'json') {
        return { fileName, mime, bytes: new TextEncoder().encode(JSON.stringify(card, null, 4)) };
      }
      if (format === 'png') {
        const base = avatar?.asset.mime === 'image/png' ? avatar.bytes : null;
        return { fileName, mime, bytes: writeCardToPng(base, card) };
      }
      const files = new Map<string, Uint8Array>();
      const hasIcon = card.data.assets?.some((a) => a.type === 'icon');
      if (avatar && !hasIcon) {
        const ext =
          Object.entries(IMAGE_MIME).find(([, m]) => m === avatar.asset.mime)?.[0] ?? 'png';
        const iconPath = `assets/icon/images/main.${ext}`;
        files.set(iconPath, avatar.bytes);
        card.data.assets = [
          ...(card.data.assets ?? []),
          { type: 'icon', uri: `embeded://${iconPath}`, name: 'main', ext },
        ];
      }
      return { fileName, mime, bytes: writeCharx(card, files) };
    },

    importPreset(fileName: string, bytes: Uint8Array) {
      const preset = guard(() => parsePreset(parseJsonBytes(bytes, '预设')));
      const name = typeof preset['name'] === 'string' ? preset['name'] : baseName(fileName);
      return db
        .insert(schema.presets)
        .values({
          name,
          format: 'st-openai',
          apiFamily: presetApiFamily(preset),
          data: preset,
          sampling: extractPresetSampling(preset),
        })
        .returning()
        .get();
    },

    exportPreset(id: string): ExportedFile | undefined {
      const row = db.select().from(schema.presets).where(eq(schema.presets.id, id)).get();
      if (!row) return undefined;
      return {
        fileName: `${row.name}.json`,
        mime: 'application/json',
        bytes: new TextEncoder().encode(serializePreset(row.data as StPreset)),
      };
    },

    importLorebook(fileName: string, bytes: Uint8Array) {
      const book = guard(() => parseWorldbook(parseJsonBytes(bytes, '世界书')));
      const { entries: _entries, ...meta } = book;
      const { form, items } = listWorldbookEntries(book);
      const settings: LorebookSettings = { entriesForm: form, meta };

      return db.transaction((tx) => {
        const row = tx
          .insert(schema.lorebooks)
          .values({ name: book.name ?? baseName(fileName), scope: 'global', settings })
          .returning()
          .get();
        for (const item of items) {
          const extra: LorebookEntryExtra = { stKey: item.key, raw: item.entry };
          tx.insert(schema.lorebookEntries)
            .values({ ...toWorldbookEntryColumns(item.entry), bookId: row.id, extra })
            .run();
        }
        return { ...row, entryCount: items.length };
      });
    },

    exportLorebook(id: string): ExportedFile | undefined {
      const book = db.select().from(schema.lorebooks).where(eq(schema.lorebooks.id, id)).get();
      if (!book) return undefined;
      const rows = db
        .select()
        .from(schema.lorebookEntries)
        .where(eq(schema.lorebookEntries.bookId, id))
        .orderBy(asc(sql`rowid`))
        .all();
      const settings = (book.settings ?? {}) as LorebookSettings;
      const items = rows.map((row, index) => {
        const extra = (row.extra ?? {}) as LorebookEntryExtra;
        return {
          key: extra.stKey ?? String(row.uid ?? index),
          entry: applyWorldbookEntryColumns(extra.raw ?? {}, pickWorldbookEntryColumns(row)),
        };
      });
      const worldbook = buildWorldbook(
        settings.meta ?? { name: book.name },
        settings.entriesForm ?? 'object',
        items,
      );
      return {
        fileName: `${book.name}.json`,
        mime: 'application/json',
        bytes: new TextEncoder().encode(serializeWorldbook(worldbook)),
      };
    },
  };
}

export type Importer = ReturnType<typeof createImporter>;
