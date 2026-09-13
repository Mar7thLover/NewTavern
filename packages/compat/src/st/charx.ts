/**
 * CHARX 读写：zip 包内 card.json（V3）+ assets/ 下资源文件。
 * 卡内资源 uri 形如 embeded://assets/icon.png（ST/RisuAI 实际使用的 embeded 拼写，同时容忍 embedded）。
 */

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import { normalizeCard } from './card-upgrade.js';
import type { V3Card } from './card.js';

export const CHARX_CARD_FILE = 'card.json';

const EMBEDDED_URI_PREFIXES = ['embeded://', 'embedded://'] as const;

export interface CharxContents {
  card: V3Card;
  /** zip 内除 card.json 外的全部文件，key 为包内路径 */
  files: Map<string, Uint8Array>;
}

export function readCharx(bytes: Uint8Array): CharxContents {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new Error('不是有效的 CHARX 文件（zip 解压失败）');
  }
  const cardBytes = entries[CHARX_CARD_FILE];
  if (cardBytes === undefined) {
    throw new Error('CHARX 中缺少 card.json');
  }
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(cardBytes));
  } catch {
    throw new Error('CHARX 中的 card.json 不是有效的 JSON');
  }
  const files = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(entries)) {
    if (path === CHARX_CARD_FILE || path.endsWith('/')) continue;
    files.set(path, data);
  }
  return { card: normalizeCard(json), files };
}

export function writeCharx(card: V3Card, files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const zippable: Record<string, Uint8Array> = {
    [CHARX_CARD_FILE]: strToU8(JSON.stringify(card)),
  };
  for (const [path, data] of files) {
    if (path === CHARX_CARD_FILE) continue;
    zippable[path] = data;
  }
  return zipSync(zippable);
}

/** embeded://assets/x.png → assets/x.png；非内嵌 uri 返回 undefined */
export function resolveEmbeddedUri(uri: string): string | undefined {
  for (const prefix of EMBEDDED_URI_PREFIXES) {
    if (uri.startsWith(prefix)) return uri.slice(prefix.length);
  }
  return undefined;
}
