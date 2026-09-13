/**
 * ST 角色卡（Character Card V2/V3）JSON 解析、序列化与 PNG 读写。
 * schema 全部使用 z.looseObject 保留未知字段，保证 import→export 无损往返；
 * 解析不做默认值填充（默认值只在 card-upgrade.ts 的升级/normalize 路径补齐）。
 *
 * 与 card-upgrade.ts 存在运行时循环引用（升级/降级函数 ↔ parseCardJson），
 * 两侧都只在函数体内使用对方导出，ESM 下安全。
 */

import { z } from 'zod';

import { base64Decode, base64Encode, base64FromUtf8, utf8FromBase64 } from './base64.js';
import { downgradeV3toV2, upgradeV1toV2, upgradeV2toV3 } from './card-upgrade.js';
import {
  PNG_SIGNATURE,
  encodePngChunk,
  readPngTextChunks,
  removePngTextChunksWhere,
  upsertPngTextChunk,
} from './png-text.js';
import { isRecord, parseOrThrow } from './util.js';

const characterBookEntrySchema = z.looseObject({
  keys: z.array(z.string()),
  content: z.string(),
  enabled: z.boolean(),
  insertion_order: z.number(),
  case_sensitive: z.boolean().optional(),
  name: z.string().optional(),
  priority: z.number().optional(),
  // CCv3 规定为 before_char/after_char，实际卡片里也常见数字（对齐世界书 position）
  position: z.union([z.enum(['before_char', 'after_char']), z.number()]).optional(),
  extensions: z.looseObject({}).optional(),
  secondary_keys: z.array(z.string()).optional(),
  constant: z.boolean().optional(),
  selective: z.boolean().optional(),
  selectiveLogic: z.number().optional(),
  probability: z.number().optional(),
  useProbability: z.boolean().optional(),
  scanDepth: z.number().optional(),
  scan_depth: z.number().optional(),
});

const characterBookSchema = z.looseObject({
  name: z.string().optional(),
  description: z.string().optional(),
  scan_depth: z.number().optional(),
  token_budget: z.number().optional(),
  recursive_scanning: z.boolean().optional(),
  extensions: z.looseObject({}).optional(),
  entries: z.array(characterBookEntrySchema),
});

const cardAssetSchema = z.looseObject({
  type: z.string(),
  uri: z.string(),
  name: z.string(),
  ext: z.string(),
});

/** V2 data：V1 核心六字段必填，其余可选（真实卡片经常缺省） */
export const v2DataSchema = z.looseObject({
  name: z.string(),
  description: z.string(),
  personality: z.string(),
  scenario: z.string(),
  first_mes: z.string(),
  mes_example: z.string(),
  creator_notes: z.string().optional(),
  system_prompt: z.string().optional(),
  post_history_instructions: z.string().optional(),
  alternate_greetings: z.array(z.string()).optional(),
  character_book: characterBookSchema.nullish(),
  tags: z.array(z.string()).optional(),
  creator: z.string().optional(),
  character_version: z.string().optional(),
  extensions: z.looseObject({}).optional(),
});

/** V3 data：在 V2 基础上新增资源、多语言笔记、群聊问候等；全部可选 */
export const v3DataSchema = v2DataSchema.extend({
  assets: z.array(cardAssetSchema).optional(),
  creator_notes_multilingual: z.record(z.string(), z.string()).optional(),
  group_only_greetings: z.array(z.string()).optional(),
  creation_date: z.number().optional(),
  modification_date: z.number().optional(),
  source: z.array(z.string()).optional(),
  nickname: z.string().optional(),
});

export const v2CardSchema = z.looseObject({
  spec: z.literal('chara_card_v2'),
  spec_version: z.literal('2.0'),
  data: v2DataSchema,
});

export const v3CardSchema = z.looseObject({
  spec: z.literal('chara_card_v3'),
  spec_version: z.literal('3.0'),
  data: v3DataSchema,
});

export type CharacterBookEntry = z.infer<typeof characterBookEntrySchema>;
export type CharacterBook = z.infer<typeof characterBookSchema>;
export type CardAsset = z.infer<typeof cardAssetSchema>;
export type V2CardData = z.infer<typeof v2DataSchema>;
export type V3CardData = z.infer<typeof v3DataSchema>;
export type V2Card = z.infer<typeof v2CardSchema>;
export type V3Card = z.infer<typeof v3CardSchema>;

export const CCV3_TEXT_KEYWORD = 'ccv3';
export const CHARA_TEXT_KEYWORD = 'chara';
/** ST 把 CHARX 内嵌资源写进 PNG 时使用的 tEXt 关键字前缀 */
export const EMBEDDED_ASSET_PREFIX = 'chara-ext-asset_:';

export type ParsedCard =
  | { spec: 'v2'; card: V2Card; data: V2CardData; raw: Record<string, unknown> }
  | { spec: 'v3'; card: V3Card; data: V3CardData; raw: Record<string, unknown> };

/** 解析角色卡 JSON：按 spec 字段判定 V2/V3；无 spec 视为 V1 并升级为 V2 */
export function parseCardJson(json: unknown): ParsedCard {
  if (!isRecord(json)) {
    throw new Error('角色卡 JSON 必须是对象');
  }
  if (json.spec === 'chara_card_v3') {
    const card = parseOrThrow(v3CardSchema, json, 'V3 角色卡解析失败');
    return { spec: 'v3', card, data: card.data, raw: json };
  }
  if (json.spec === 'chara_card_v2') {
    const card = parseOrThrow(v2CardSchema, json, 'V2 角色卡解析失败');
    return { spec: 'v2', card, data: card.data, raw: json };
  }
  // 无 spec：V1 平铺卡（或裸 data 对象），升级为 V2
  const card = upgradeV1toV2(json);
  return { spec: 'v2', card, data: card.data, raw: json };
}

export type CardLike = V2Card | V3Card | ParsedCard;

/** 接受完整卡对象或 ParsedCard，返回完整卡对象 */
export function unwrapCard(input: CardLike): V2Card | V3Card {
  if (input.spec === 'v2' || input.spec === 'v3') {
    return (input as ParsedCard).card;
  }
  return input as V2Card | V3Card;
}

export function serializeCard(input: CardLike): string {
  return JSON.stringify(unwrapCard(input));
}

function parseCardJsonText(text: string, source: string): ParsedCard {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${source}不是有效的 JSON`);
  }
  return parseCardJson(json);
}

/** 从 PNG 读取角色卡：优先 ccv3（V3），其次 chara（V2/V1） */
export function readCardFromPng(bytes: Uint8Array): ParsedCard {
  const texts = readPngTextChunks(bytes);
  const ccv3 = texts.get(CCV3_TEXT_KEYWORD);
  if (ccv3 !== undefined) {
    return parseCardJsonText(utf8FromBase64(ccv3), 'PNG ccv3 chunk ');
  }
  const chara = texts.get(CHARA_TEXT_KEYWORD);
  if (chara !== undefined) {
    return parseCardJsonText(utf8FromBase64(chara), 'PNG chara chunk ');
  }
  throw new Error('PNG 中未找到角色卡数据（缺少 ccv3/chara tEXt chunk）');
}

/** 1x1 透明 PNG（无原图时的占位底图）：zlib 无压缩块，CRC 由 encodePngChunk 现算 */
const BLANK_PNG: Uint8Array = (() => {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // zlib stream：header 78 01 + stored block（5 字节全零扫描线）+ adler32(全零数据)=1
  const idat = new Uint8Array([
    0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
  ]);
  const parts = [
    PNG_SIGNATURE,
    encodePngChunk('IHDR', ihdr),
    encodePngChunk('IDAT', idat),
    encodePngChunk('IEND', new Uint8Array(0)),
  ];
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
})();

/**
 * 把角色卡写入 PNG：同时写 ccv3（完整 V3）与 chara（V2 兼容降级，extensions 原样带上）。
 * 入卡为 V2 时 chara 写原内容、ccv3 写升级结果。pngBytes 为 null 时使用 1x1 占位底图。
 * 可选 assets 会同步写入 chara-ext-asset_: chunk。
 */
export function writeCardToPng(
  pngBytes: Uint8Array | null,
  input: CardLike,
  assets?: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const card = unwrapCard(input);
  let v3: V3Card;
  let v2: V2Card;
  if (card.spec === 'chara_card_v3') {
    v3 = card;
    v2 = downgradeV3toV2(card);
  } else {
    v2 = card;
    v3 = upgradeV2toV3(card);
  }
  let out = pngBytes ?? BLANK_PNG;
  out = upsertPngTextChunk(out, CCV3_TEXT_KEYWORD, base64FromUtf8(JSON.stringify(v3)));
  out = upsertPngTextChunk(out, CHARA_TEXT_KEYWORD, base64FromUtf8(JSON.stringify(v2)));
  if (assets !== undefined) {
    out = writeCardEmbeddedAssets(out, assets);
  }
  return out;
}

/** 读取 PNG 中 chara-ext-asset_: 前缀的内嵌资源（base64 → 字节），key 为资源路径 */
export function readCardEmbeddedAssets(bytes: Uint8Array): Map<string, Uint8Array> {
  const assets = new Map<string, Uint8Array>();
  for (const [keyword, value] of readPngTextChunks(bytes)) {
    if (keyword.startsWith(EMBEDDED_ASSET_PREFIX)) {
      assets.set(keyword.slice(EMBEDDED_ASSET_PREFIX.length), base64Decode(value));
    }
  }
  return assets;
}

/** 写回内嵌资源：先清掉全部既有 chara-ext-asset_: chunk，再逐个写入 */
export function writeCardEmbeddedAssets(
  bytes: Uint8Array,
  assets: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  let out = removePngTextChunksWhere(bytes, (keyword) => keyword.startsWith(EMBEDDED_ASSET_PREFIX));
  for (const [path, data] of assets) {
    out = upsertPngTextChunk(out, EMBEDDED_ASSET_PREFIX + path, base64Encode(data));
  }
  return out;
}
