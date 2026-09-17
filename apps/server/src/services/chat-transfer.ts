import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import {
  humanizedDateTime,
  parseChatJsonl,
  parseStDate,
  serializeChatJsonl,
  stChatNames,
  stChatToTree,
  treeToStChat,
  type ExportNode,
  type ImportedChatHeader,
  type StFileRef,
  type StMediaRef,
  type StNodeSource,
  type TreeNodeDraft,
} from '@newtavern/compat';
import { childrenOf, type Part } from '@newtavern/core';
import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { AssetsService } from './assets.js';
import { parseAuthorsNote, readAuthorsNote, type AuthorsNote } from './authors-note.js';
import {
  loadChat,
  loadNodes,
  pathToNode,
  readChatLorebookIds,
  textOfParts,
  toChatSummary,
  type ChatSummary,
  type NodeReasoning,
  type NodeRow,
} from './chat-tree.js';
import { readDefaultPersonaId } from './personas.js';
import { readDefaultPresetId } from './presets.js';

/**
 * SillyTavern 聊天记录（jsonl）↔ 消息树。见 docs/M4-CONTRACT.md §2.2。
 *
 * - 导入：一个事务内批量插入（预生成 id），不走 `insertNode`（它每次全表读节点）。
 * - `chats.metadata.st = { header, sourceHash }`；节点 `extra.st` = 导入时原样保留的 ST 字段；
 *   `extra.stAssetIds` = 从 ST 媒体引用导入的资产（导出时这些不算「没导出的附件」）。
 * - 导出：root→head 路径一条消息一行，无后代兄弟回填 swipes，分支计数。
 */

/** 用户文件问题（非法 jsonl、角色不存在），路由层转 400 */
export class ChatTransferError extends Error {}

export interface ImportStChatInput {
  fileName: string;
  bytes: Uint8Array;
  /** 缺省 = 按 header 的 character_name 精确匹配唯一角色；null = 不绑定角色 */
  characterId?: string | null;
  /** ST 用户目录（目录迁移时）：把 `/user/images/…`、`/user/files/…` 引用读成资产 */
  mediaRoot?: string;
}

export interface ImportStChatResult {
  chat: ChatSummary;
  /** jsonl 里的消息行数 */
  messageCount: number;
  /** 建出的节点数（含 swipe 兄弟） */
  nodeCount: number;
  warnings: string[];
}

export interface StChatMetadata {
  header: ImportedChatHeader;
  sourceHash: string;
}

export interface ExportStChatResult {
  fileName: string;
  mime: string;
  bytes: Uint8Array;
  /** 不在 root→head 路径上、有后代的兄弟（分支）个数 */
  droppedBranches: number;
  /** 没有写进文件的附件（新上传的图片 / 文档）个数 */
  skippedAttachments: number;
}

/** 上传限额同 `POST /api/assets`（契约 §3.3） */
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
/** 批量插入每批行数（SQLite 绑定变量上限 32766 ÷ 16 列） */
const INSERT_CHUNK = 500;

const TEXT_MIME: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  yaml: 'text/yaml',
  yml: 'text/yaml',
  xml: 'text/xml',
  html: 'text/html',
};

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* 作者注释 / 标题 / 文件名                                            */
/* ------------------------------------------------------------------ */

const NOTE_KEYS = ['note_prompt', 'note_position', 'note_depth', 'note_role', 'note_interval'];

/** ST `chat_metadata.note_*` → `metadata.authorsNote`；一个 note 键都没有时返回 null */
export function authorsNoteFromStMetadata(
  meta: Record<string, unknown> | undefined,
): AuthorsNote | null {
  if (!meta || !NOTE_KEYS.some((key) => meta[key] !== undefined)) return null;
  const tri = (value: unknown) => (value === 0 || value === 1 || value === 2 ? value : undefined);
  const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
  const parsed = parseAuthorsNote({
    text: typeof meta['note_prompt'] === 'string' ? meta['note_prompt'] : '',
    position: tri(meta['note_position']),
    depth: num(meta['note_depth']),
    role: tri(meta['note_role']),
    interval: num(meta['note_interval']),
  });
  return parsed === 'invalid' ? null : parsed;
}

function titleFromFileName(fileName: string): string {
  return path
    .basename(fileName)
    .replace(/\.jsonl$/i, '')
    .trim();
}

function safeFileName(name: string): string {
  // 文件名里不能出现的字符与控制字符换成下划线
  const cleaned = Array.from(name)
    .map((ch) => (ch.charCodeAt(0) < 0x20 || '\\/:*?"<>|'.includes(ch) ? '_' : ch))
    .join('')
    .trim();
  return cleaned || 'chat';
}

/* ------------------------------------------------------------------ */
/* 媒体                                                                 */
/* ------------------------------------------------------------------ */

function sniffImageMime(bytes: Uint8Array): string | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  return null;
}

function decodeDataUrl(url: string): Uint8Array | null {
  const match = /^data:[^,]*?(;base64)?,(.*)$/s.exec(url);
  if (!match) return null;
  try {
    return match[1]
      ? new Uint8Array(Buffer.from(match[2] ?? '', 'base64'))
      : new TextEncoder().encode(decodeURIComponent(match[2] ?? ''));
  } catch {
    return null;
  }
}

/** ST 的 `/user/images/…`、`user/files/…`（也容忍完整 URL 与百分号编码）→ 用户目录下的文件；越界或不存在返回 null */
export function resolveStUserFile(mediaRoot: string, url: string): string | null {
  let pathname = url;
  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return null;
    }
  }
  pathname = pathname.replace(/\\/g, '/').replace(/^\/+/, '');
  const candidates = [pathname];
  try {
    const decoded = decodeURIComponent(pathname);
    if (decoded !== pathname) candidates.push(decoded);
  } catch {
    // 非法编码：只按原样找
  }
  const userDir = path.resolve(mediaRoot, 'user');
  for (const candidate of candidates) {
    if (!/^user\/(images|files)\//.test(candidate)) continue;
    const abs = path.resolve(mediaRoot, candidate);
    const rel = path.relative(userDir, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    try {
      if (fs.statSync(abs).isFile()) return abs;
    } catch {
      // 不存在
    }
  }
  return null;
}

interface MediaTally {
  /** 没有 mediaRoot，只留在 extra.st 里 */
  unresolved: number;
  missing: string[];
  unsupported: number;
  tooLarge: number;
}

function urlBaseName(url: string): string {
  if (url.startsWith('data:')) return '';
  const raw = url.split(/[?#]/)[0]?.split('/').pop() ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function createMediaReader(
  assets: AssetsService,
  mediaRoot: string | undefined,
  tally: MediaTally,
) {
  const cache = new Map<string, Part | null>();

  function readBytes(url: string): Uint8Array | null {
    if (url.startsWith('data:')) return decodeDataUrl(url);
    if (!mediaRoot) {
      tally.unresolved++;
      return null;
    }
    const abs = resolveStUserFile(mediaRoot, url);
    if (!abs) {
      tally.missing.push(url);
      return null;
    }
    if (fs.statSync(abs).size > MAX_MEDIA_BYTES) {
      tally.tooLarge++;
      return null;
    }
    return new Uint8Array(fs.readFileSync(abs));
  }

  function save(key: string, build: () => Part | null): Part | null {
    if (cache.has(key)) return cache.get(key) ?? null;
    const part = build();
    cache.set(key, part);
    return part;
  }

  return {
    image(ref: StMediaRef): Part | null {
      if (ref.type !== 'image') {
        tally.unsupported++;
        return null;
      }
      return save(`image:${ref.url}`, () => {
        const bytes = readBytes(ref.url);
        if (!bytes) return null;
        const mime = sniffImageMime(bytes);
        if (!mime) {
          tally.unsupported++;
          return null;
        }
        const name = urlBaseName(ref.url) || ref.title || undefined;
        const asset = assets.save({
          bytes,
          mime,
          kind: 'upload',
          source: 'st-import',
          meta: name ? { name } : undefined,
        });
        return { type: 'image', assetId: asset.id, mime, ...(name ? { name } : {}) };
      });
    },
    file(ref: StFileRef): Part | null {
      return save(`file:${ref.url}`, () => {
        const bytes = readBytes(ref.url);
        if (!bytes) return null;
        const name = ref.name ?? urlBaseName(ref.url);
        const ext = name.split('.').pop()?.toLowerCase() ?? '';
        let mime: string;
        if (ext === 'pdf' || (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44)) {
          mime = 'application/pdf';
        } else {
          try {
            new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            tally.unsupported++;
            return null;
          }
          mime = TEXT_MIME[ext] ?? 'text/plain';
        }
        const asset = assets.save({
          bytes,
          mime,
          kind: 'upload',
          source: 'st-import',
          meta: name ? { name } : undefined,
        });
        return { type: 'document', assetId: asset.id, mime, ...(name ? { name } : {}) };
      });
    },
  };
}

function mediaWarnings(tally: MediaTally): string[] {
  const warnings: string[] = [];
  if (tally.unresolved > 0) {
    warnings.push(
      `${tally.unresolved} 个图片 / 文件附件引用的是 SillyTavern 目录里的文件，单独导入聊天记录时读不到，只保留了引用（用迁移向导导入整个目录可以一并带过来）`,
    );
  }
  if (tally.missing.length > 0) {
    const sample = tally.missing.slice(0, 3).join('、');
    warnings.push(
      `${tally.missing.length} 个附件文件找不到：${sample}${tally.missing.length > 3 ? ' 等' : ''}`,
    );
  }
  if (tally.unsupported > 0) {
    warnings.push(`${tally.unsupported} 个附件是视频、音频或不支持的格式，已跳过`);
  }
  if (tally.tooLarge > 0) {
    warnings.push(`${tally.tooLarge} 个附件超过 20 MB，已跳过`);
  }
  return warnings;
}

/* ------------------------------------------------------------------ */
/* 导入                                                                 */
/* ------------------------------------------------------------------ */

function resolveCharacter(
  db: Db,
  name: string | null,
  characterId: string | null | undefined,
  warnings: string[],
) {
  if (characterId === null) return null;
  if (characterId !== undefined) {
    const row = db
      .select({ id: schema.characters.id, name: schema.characters.name })
      .from(schema.characters)
      .where(eq(schema.characters.id, characterId))
      .get();
    if (!row) throw new ChatTransferError(`角色不存在：${characterId}`);
    return row;
  }
  if (!name) return null;
  const matches = db
    .select({ id: schema.characters.id, name: schema.characters.name })
    .from(schema.characters)
    .where(eq(schema.characters.name, name))
    .all();
  if (matches.length === 1) return matches[0] ?? null;
  warnings.push(
    matches.length === 0
      ? `库里没有名为「${name}」的角色，这段对话没有绑定角色`
      : `库里有 ${matches.length} 个名为「${name}」的角色，无法确定是哪一个，这段对话没有绑定角色`,
  );
  return null;
}

function resolvePersonaId(db: Db, name: string | null): string | null {
  if (name) {
    const matches = db
      .select({ id: schema.personas.id })
      .from(schema.personas)
      .where(eq(schema.personas.name, name))
      .all();
    if (matches.length === 1) return matches[0]?.id ?? null;
  }
  return readDefaultPersonaId(db);
}

function resolveChatBook(db: Db, name: unknown, warnings: string[]): string | null {
  if (typeof name !== 'string' || name === '') return null;
  const rows = db
    .select({ id: schema.lorebooks.id, scope: schema.lorebooks.scope })
    .from(schema.lorebooks)
    .where(eq(schema.lorebooks.name, name))
    .all();
  const row = rows.find((book) => book.scope === 'global') ?? rows[0];
  if (!row) {
    warnings.push(`聊天绑定的世界书「${name}」不在库里，没有关联`);
    return null;
  }
  return row.id;
}

/** 草稿的 root→head 路径 tempId */
function draftPath(nodes: readonly TreeNodeDraft[], headTempId: string | null): string[] {
  const parentOf = new Map(nodes.map((node) => [node.tempId, node.parentTempId]));
  const out: string[] = [];
  for (let cursor = headTempId; cursor !== null; cursor = parentOf.get(cursor) ?? null) {
    out.unshift(cursor);
  }
  return out;
}

export function importStChat(
  db: Db,
  assets: AssetsService,
  input: ImportStChatInput,
): ImportStChatResult {
  let parsed;
  try {
    parsed = parseChatJsonl(new TextDecoder('utf-8').decode(input.bytes));
  } catch (e) {
    throw new ChatTransferError((e as Error).message);
  }
  const tree = stChatToTree(parsed);
  const warnings = [...tree.warnings];
  const header = tree.header;
  const meta = header.chatMetadata ?? {};

  // ST 新版 header 的名字是 'unused'，取消息里的名字（见 compat stChatNames）
  const names = stChatNames(parsed);
  const character = resolveCharacter(db, names.characterName, input.characterId, warnings);
  const personaId = resolvePersonaId(db, names.userName);
  const presetId = readDefaultPresetId(db);
  const bookId = resolveChatBook(db, meta['world_info'], warnings);

  // 媒体先落盘（文件写入不进事务）
  const tally: MediaTally = { unresolved: 0, missing: [], unsupported: 0, tooLarge: 0 };
  const reader = createMediaReader(assets, input.mediaRoot, tally);
  const mediaParts = tree.nodes.map((draft) =>
    [
      ...draft.media.map((ref) => reader.image(ref)),
      ...draft.files.map((ref) => reader.file(ref)),
    ].filter((part): part is Part => part !== null),
  );
  warnings.push(...mediaWarnings(tally));

  const ids = new Map(tree.nodes.map((draft) => [draft.tempId, randomUUID()]));
  const idOf = (tempId: string | null) => (tempId === null ? null : (ids.get(tempId) ?? null));
  const pathIds = draftPath(tree.nodes, tree.headTempId);
  const variables = isRecord(meta['variables']) ? meta['variables'] : null;
  const snapshotIds = new Set(
    variables ? [pathIds[0], pathIds[pathIds.length - 1]].filter(Boolean) : [],
  );

  const nodeRows: (typeof schema.messageNodes.$inferInsert)[] = tree.nodes.map((draft, index) => {
    const media = mediaParts[index] ?? [];
    const parts: Part[] = [{ type: 'text', text: draft.text }, ...media];
    const extra: Record<string, unknown> = { st: draft.st };
    const assetIds = media
      .map((part) => (part.type === 'image' || part.type === 'document' ? part.assetId : null))
      .filter((id): id is string => id !== null);
    if (assetIds.length > 0) extra['stAssetIds'] = assetIds;
    const reasoning: NodeReasoning | null = draft.reasoning ? { text: draft.reasoning } : null;
    return {
      id: ids.get(draft.tempId) as string,
      chatId: '',
      parentId: idOf(draft.parentTempId),
      siblingSeq: draft.siblingSeq,
      role: draft.role,
      name: draft.name,
      parts,
      reasoning,
      variables: snapshotIds.has(draft.tempId) ? variables : null,
      isHidden: draft.isHidden,
      extra,
      createdAt: new Date(draft.createdAt),
    };
  });

  const firstAt = tree.nodes[0]?.createdAt;
  const lastAt = tree.nodes[tree.nodes.length - 1]?.createdAt;
  const headerAt = parseStDate(header.createDate);
  const now = Date.now();
  const createdAt = new Date(Math.min(headerAt ?? firstAt ?? now, firstAt ?? now));
  const updatedAt = new Date(lastAt ?? Math.max(createdAt.getTime(), now));

  const metadata: Record<string, unknown> = {
    st: { header, sourceHash: sha256(input.bytes) } satisfies StChatMetadata,
  };
  const note = authorsNoteFromStMetadata(meta);
  if (note) metadata['authorsNote'] = note;

  const rootId = tree.nodes.find((draft) => draft.parentTempId === null && draft.siblingSeq === 0);
  const chatId = randomUUID();
  const title = titleFromFileName(input.fileName) || character?.name || names.characterName || '';

  db.transaction((tx) => {
    tx.insert(schema.chats)
      .values({
        id: chatId,
        title,
        mode: 'roleplay',
        characterIds: character ? [character.id] : [],
        personaId,
        presetId,
        rootNodeId: rootId ? idOf(rootId.tempId) : null,
        headNodeId: idOf(tree.headTempId),
        metadata,
        createdAt,
        updatedAt,
      })
      .run();
    for (let i = 0; i < nodeRows.length; i += INSERT_CHUNK) {
      const chunk = nodeRows.slice(i, i + INSERT_CHUNK).map((row) => ({ ...row, chatId }));
      tx.insert(schema.messageNodes).values(chunk).run();
    }
    if (bookId) tx.insert(schema.chatLorebooks).values({ chatId, bookId }).run();
  });

  const chat = loadChat(db, chatId);
  if (!chat) throw new Error('导入后读不到聊天');
  return {
    chat: toChatSummary(db, chat),
    messageCount: parsed.messages.length,
    nodeCount: tree.nodes.length,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* 导出                                                                 */
/* ------------------------------------------------------------------ */

function readStMetadata(metadata: Record<string, unknown> | null): StChatMetadata | null {
  const st = metadata?.['st'];
  if (!isRecord(st) || !isRecord(st['header'])) return null;
  return st as unknown as StChatMetadata;
}

function nodeReasoningText(row: NodeRow): string | null {
  const reasoning = row.reasoning as NodeReasoning | null;
  return typeof reasoning?.text === 'string' && reasoning.text !== '' ? reasoning.text : null;
}

export function exportStChat(db: Db, chatId: string): ExportStChatResult | undefined {
  const chat = loadChat(db, chatId);
  if (!chat) return undefined;
  const nodes = loadNodes(db, chatId);
  const parents = new Set(nodes.map((node) => node.parentId).filter((id) => id !== null));

  const views = new Map<string, ExportNode>();
  const viewOf = (row: NodeRow): ExportNode => {
    const cached = views.get(row.id);
    if (cached) return cached;
    const extra = row.extra ?? {};
    const view: ExportNode = {
      id: row.id,
      siblingSeq: row.siblingSeq,
      role: row.role,
      name: row.name,
      text: textOfParts((row.parts as Part[] | null) ?? []),
      isHidden: row.isHidden,
      createdAt: row.createdAt.getTime(),
      reasoning: nodeReasoningText(row),
      hasChildren: parents.has(row.id),
      st: isRecord(extra['st']) ? (extra['st'] as unknown as StNodeSource) : null,
    };
    views.set(row.id, view);
    return view;
  };
  const rowById = new Map(nodes.map((row) => [row.id, row]));
  const pathRows =
    chat.headNodeId && rowById.has(chat.headNodeId) ? pathToNode(nodes, chat.headNodeId) : [];

  const character = chat.characterIds[0]
    ? db
        .select({ name: schema.characters.name })
        .from(schema.characters)
        .where(eq(schema.characters.id, chat.characterIds[0]))
        .get()
    : undefined;
  const persona = chat.personaId
    ? db
        .select({ name: schema.personas.name })
        .from(schema.personas)
        .where(eq(schema.personas.id, chat.personaId))
        .get()
    : undefined;

  const stMeta = readStMetadata(chat.metadata);
  const baseHeader: ImportedChatHeader = stMeta?.header ?? {
    userName: persona?.name ?? 'User',
    characterName: character?.name ?? chat.title,
    createDate: humanizedDateTime(chat.createdAt.getTime()),
    chatMetadata: {},
    rest: {},
  };
  const header = overlayHeader(db, chat, baseHeader, pathRows);

  // 导出的节点：路径 + 各自的 swipe 兄弟
  const exported = new Set<string>();
  const siblingsOf = (node: ExportNode): ExportNode[] => {
    const row = rowById.get(node.id);
    return childrenOf(nodes, row?.parentId ?? null).map(viewOf);
  };
  const path = pathRows.map(viewOf);
  for (const node of path) {
    for (const sibling of siblingsOf(node)) {
      if (sibling.id === node.id || !sibling.hasChildren) exported.add(sibling.id);
    }
  }

  const { chat: stChat, droppedBranches } = treeToStChat({
    header,
    path,
    siblingsOf,
    names: {
      user: persona?.name ?? baseHeader.userName ?? 'User',
      character: character?.name ?? baseHeader.characterName ?? '',
    },
  });

  let skippedAttachments = 0;
  for (const id of exported) {
    const row = rowById.get(id);
    if (!row) continue;
    const imported = new Set(
      Array.isArray(row.extra?.['stAssetIds']) ? (row.extra['stAssetIds'] as string[]) : [],
    );
    for (const part of (row.parts as Part[] | null) ?? []) {
      if ((part.type === 'image' || part.type === 'document') && !imported.has(part.assetId)) {
        skippedAttachments++;
      }
    }
  }

  const baseName = chat.title.trim() || character?.name || 'chat';
  return {
    fileName: `${safeFileName(baseName)}.jsonl`,
    mime: 'application/x-ndjson; charset=utf-8',
    bytes: new TextEncoder().encode(serializeChatJsonl(stChat)),
    droppedBranches,
    skippedAttachments,
  };
}

/** 把会话里改过的作者注释、聊天世界书、变量写回 header 的 chat_metadata（没变就原样） */
function overlayHeader(
  db: Db,
  chat: NonNullable<ReturnType<typeof loadChat>>,
  header: ImportedChatHeader,
  pathRows: readonly NodeRow[],
): ImportedChatHeader {
  const original = header.chatMetadata ?? {};
  const meta: Record<string, unknown> = { ...original };

  const current = readAuthorsNote(chat);
  const imported = authorsNoteFromStMetadata(original);
  if (!isDeepStrictEqual(current, imported)) {
    if (current) {
      meta['note_prompt'] = current.text;
      meta['note_position'] = current.position;
      meta['note_depth'] = current.depth;
      meta['note_role'] = current.role;
      meta['note_interval'] = current.interval;
    } else if (imported) {
      meta['note_prompt'] = '';
    }
  }

  const bookIds = readChatLorebookIds(db, chat.id);
  if (bookIds.length > 0) {
    const names = bookIds
      .map(
        (id) =>
          db
            .select({ name: schema.lorebooks.name })
            .from(schema.lorebooks)
            .where(eq(schema.lorebooks.id, id))
            .get()?.name,
      )
      .filter((name): name is string => typeof name === 'string');
    if (names.length > 0 && !names.includes(meta['world_info'] as string)) {
      meta['world_info'] = names[0];
    }
  }

  for (let i = pathRows.length - 1; i >= 0; i--) {
    const snapshot = pathRows[i]?.variables;
    if (!snapshot) continue;
    if (!isDeepStrictEqual(snapshot, original['variables'])) meta['variables'] = snapshot;
    break;
  }

  return isDeepStrictEqual(meta, original) && header.chatMetadata !== undefined
    ? header
    : { ...header, chatMetadata: meta };
}
