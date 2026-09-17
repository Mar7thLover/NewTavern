import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  PNG_SIGNATURE,
  extractPresetSampling,
  listWorldbookEntries,
  normalizeCard,
  parseCardJson,
  parsePreset,
  parseRegexScripts,
  parseWorldbook,
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
  type V3Card,
  detectStTextKind,
  type StFileKind,
} from '@newtavern/compat';
import { desc, eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { AssetsService } from './assets.js';
import {
  extractCharacterBook,
  rebuildCharacterBook,
  worldbookFromTable,
  type LorebookEntryExtra,
  type LorebookSettings,
} from './character-book.js';
import {
  ChatTransferError,
  importStChat,
  type ImportStChatInput,
  type ImportStChatResult,
} from './chat-transfer.js';
import { stRegexToScript, toRegexColumns, toRegexScript, type RegexScript } from './regex-map.js';

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

/** 文件类型 → 提示文案（导入到了错误的页面时用） */
const KIND_HINTS: Record<StFileKind, string> = {
  character: '这是角色卡文件，请到「角色」页面导入。',
  lorebook: '这是世界书文件，请到「世界书」页面导入。',
  preset: '这是预设文件，请到「预设」页面导入。',
  regex: '这是正则脚本文件，请到「设置 · 正则脚本」导入。',
  chat: '这是 SillyTavern 聊天记录，请在对话列表里导入。',
};

/**
 * 解析前先粗判文件类型：能识别出是另一类文件时，直接给出「去哪个页面导入」的提示。
 * 识别不出（null）或正是期望的类型时放行，交给各自的解析器——不会误伤合法但少见的文件。
 */
export function assertExpectedKind(bytes: Uint8Array, expected: StFileKind) {
  const detected: StFileKind | null =
    isPng(bytes) || isZip(bytes)
      ? 'character'
      : detectStTextKind(new TextDecoder('utf-8').decode(bytes));
  if (detected && detected !== expected) throw new ImportError(KIND_HINTS[detected]);
}

function toV3Card(data: unknown): V3Card {
  return normalizeCard({ spec: 'chara_card_v3', spec_version: '3.0', data });
}

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
        assertExpectedKind(bytes, 'character');
        const parsed = guard(() => parseCardJson(parseJsonBytes(bytes, '角色卡')));
        spec = parsed.spec;
        card = guard(() => normalizeCard(parsed));
      }

      const original = saveOriginal(bytes, format);
      const avatarAsset = avatar
        ? assets.save({ ...avatar, kind: 'avatar', source: `import:${path.basename(fileName)}` })
        : undefined;

      const row = db
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
      // 内嵌世界书抽表（契约 §3.1）：data.character_book 原样保留
      const bookId = extractCharacterBook(db, row);
      return bookId ? { ...row, bookId } : row;
    },

    /** 未修改的卡按原格式导出原件；其余格式由 data 重新生成 */
    exportCharacter(id: string, format: CharacterFormat): ExportedFile | undefined {
      const row = getCharacter(id);
      if (!row) return undefined;
      const fileName = `${row.name}.${format}`;
      const mime = FORMAT_MIME[format];

      // 书被编辑过 → 用表重建 character_book，不能再走原始字节
      const rebuiltBook = rebuildCharacterBook(db, row);

      if (!rebuiltBook && row.sourcePath && row.sourcePath.endsWith(`.${format}`)) {
        const absPath = path.join(dataDir, row.sourcePath);
        if (fs.existsSync(absPath)) {
          return { fileName, mime, bytes: new Uint8Array(fs.readFileSync(absPath)) };
        }
      }

      const card = toV3Card(
        rebuiltBook
          ? { ...(row.data as Record<string, unknown>), character_book: rebuiltBook }
          : row.data,
      );
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

    /** options.name：迁移 ST 目录时用文件名当名字（ST 里预设名就是文件名） */
    importPreset(fileName: string, bytes: Uint8Array, options: { name?: string } = {}) {
      assertExpectedKind(bytes, 'preset');
      const preset = guard(() => parsePreset(parseJsonBytes(bytes, '预设')));
      const name =
        options.name ?? (typeof preset['name'] === 'string' ? preset['name'] : baseName(fileName));
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

    /** options.name：迁移 ST 目录时用文件名当名字（ST 里世界书名就是文件名） */
    importLorebook(fileName: string, bytes: Uint8Array, options: { name?: string } = {}) {
      assertExpectedKind(bytes, 'lorebook');
      const book = guard(() => parseWorldbook(parseJsonBytes(bytes, '世界书')));
      const { entries: _entries, ...meta } = book;
      const { form, items } = listWorldbookEntries(book);
      const settings: LorebookSettings = { entriesForm: form, meta };

      return db.transaction((tx) => {
        const row = tx
          .insert(schema.lorebooks)
          .values({
            name: options.name ?? book.name ?? baseName(fileName),
            scope: 'global',
            settings,
          })
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
      return {
        fileName: `${book.name}.json`,
        mime: 'application/json',
        bytes: new TextEncoder().encode(serializeWorldbook(worldbookFromTable(db, book))),
      };
    },

    /** SillyTavern 聊天记录 jsonl → 一段新对话（契约 M4 §2.2） */
    importChat(input: ImportStChatInput): ImportStChatResult {
      assertExpectedKind(input.bytes, 'chat');
      try {
        return importStChat(db, assets, input);
      } catch (e) {
        if (e instanceof ChatTransferError) throw new ImportError(e.message);
        throw e;
      }
    },

    /** ST 正则脚本 JSON（单条或数组）→ regex_scripts 表（scope='global'，契约 §3.2） */
    importRegexScripts(fileName: string, bytes: Uint8Array): RegexScript[] {
      assertExpectedKind(bytes, 'regex');
      const scripts = guard(() => parseRegexScripts(parseJsonBytes(bytes, '正则脚本')));
      const last = db
        .select()
        .from(schema.regexScripts)
        .orderBy(desc(schema.regexScripts.displayOrder))
        .get();
      let order = (last?.displayOrder ?? -1) + 1;
      return scripts.map((raw, index) => {
        const script = stRegexToScript(raw, `${index}`, 'global');
        if (!script) throw new ImportError(`第 ${index + 1} 个正则脚本缺少 scriptName/findRegex`);
        const row = db
          .insert(schema.regexScripts)
          .values({
            ...toRegexColumns(script),
            scope: 'global',
            displayOrder: order++,
            // 未知字段原样保留，便于以后无损导出
            extra: { raw, sourceFile: baseName(fileName) },
          })
          .returning()
          .get();
        return toRegexScript(row);
      });
    },
  };
}

export type Importer = ReturnType<typeof createImporter>;
