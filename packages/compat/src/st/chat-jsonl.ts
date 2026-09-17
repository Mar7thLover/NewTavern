/**
 * ST 聊天记录 jsonl：首行 header（user_name/character_name/create_date/chat_metadata），
 * 其后每行一条消息。ST 的 swipes 是字符串数组，swipe_info 与之按下标对应。
 * 中立模型只拉平常用字段，其余键进 rest，保证往返 deep-equal。
 */

import { isRecord } from './util.js';

export interface ImportedChatHeader {
  userName?: string;
  characterName?: string;
  createDate?: string;
  chatMetadata?: Record<string, unknown>;
  rest: Record<string, unknown>;
}

export interface ImportedMessage {
  name?: string;
  isUser?: boolean;
  isSystem?: boolean;
  sendDate?: string | number;
  mes: string;
  extra?: Record<string, unknown>;
  swipes?: string[];
  swipeId?: number;
  swipeInfo?: unknown[];
  rest: Record<string, unknown>;
}

export interface ImportedChat {
  header: ImportedChatHeader;
  messages: ImportedMessage[];
}

const HEADER_KEYS = {
  user_name: 'userName',
  character_name: 'characterName',
  create_date: 'createDate',
  chat_metadata: 'chatMetadata',
} as const;

const MESSAGE_KEYS = {
  name: 'name',
  is_user: 'isUser',
  is_system: 'isSystem',
  send_date: 'sendDate',
  mes: 'mes',
  extra: 'extra',
  swipes: 'swipes',
  swipe_id: 'swipeId',
  swipe_info: 'swipeInfo',
} as const;

function splitKnown<M extends Record<string, string>>(
  obj: Record<string, unknown>,
  mapping: M,
): { known: Record<string, unknown>; rest: Record<string, unknown> } {
  const known: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const mapped = mapping[key];
    if (mapped !== undefined) known[mapped] = value;
    else rest[key] = value;
  }
  return { known, rest };
}

function joinKnown<M extends Record<string, string>>(
  known: Record<string, unknown>,
  rest: Record<string, unknown>,
  mapping: M,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...rest };
  for (const [stKey, modelKey] of Object.entries(mapping)) {
    if (known[modelKey] !== undefined) out[stKey] = known[modelKey];
  }
  return out;
}

function parseLine(line: string, lineNo: number): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    throw new Error(`聊天记录第 ${lineNo} 行不是有效的 JSON`);
  }
  if (!isRecord(json)) {
    throw new Error(`聊天记录第 ${lineNo} 行必须是对象`);
  }
  return json;
}

function toMessage(obj: Record<string, unknown>, lineNo: number): ImportedMessage {
  if (typeof obj['mes'] !== 'string') {
    throw new Error(`聊天记录第 ${lineNo} 行缺少 mes 字段`);
  }
  if (obj['swipes'] !== undefined) {
    const swipes = obj['swipes'];
    if (!Array.isArray(swipes) || swipes.some((s) => typeof s !== 'string')) {
      throw new Error(`聊天记录第 ${lineNo} 行的 swipes 必须是字符串数组`);
    }
  }
  const { known, rest } = splitKnown(obj, MESSAGE_KEYS);
  return { ...known, rest } as ImportedMessage;
}

/** 中立模型的消息 → ST 原始键名对象（与 serialize 同一规则：undefined 的已知字段不写） */
export function chatMessageToStRecord(message: ImportedMessage): Record<string, unknown> {
  const { rest, ...known } = message;
  return joinKnown(known, rest, MESSAGE_KEYS);
}

/** ST 原始键名对象 → 中立模型的消息（不校验；校验走 parseChatJsonl） */
export function chatMessageFromStRecord(record: Record<string, unknown>): ImportedMessage {
  const { known, rest } = splitKnown(record, MESSAGE_KEYS);
  return { ...known, rest } as ImportedMessage;
}

/** 中立模型的 header → ST 原始键名对象 */
export function chatHeaderToStRecord(header: ImportedChatHeader): Record<string, unknown> {
  const { rest, ...known } = header;
  return joinKnown(known, rest, HEADER_KEYS);
}

/** ST 原始键名对象 → 中立模型的 header */
export function chatHeaderFromStRecord(record: Record<string, unknown>): ImportedChatHeader {
  const { known, rest } = splitKnown(record, HEADER_KEYS);
  return { ...known, rest } as ImportedChatHeader;
}

export function parseChatJsonl(text: string): ImportedChat {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), lineNo: index + 1 }))
    .filter(({ line }) => line !== '');
  const first = lines[0];
  if (first === undefined) {
    throw new Error('聊天记录为空');
  }
  const headerObj = parseLine(first.line, first.lineNo);
  if (
    typeof headerObj['mes'] === 'string' ||
    !('chat_metadata' in headerObj || 'user_name' in headerObj)
  ) {
    throw new Error('聊天记录缺少首行 header（user_name/character_name/chat_metadata）');
  }
  const { known, rest } = splitKnown(headerObj, HEADER_KEYS);
  const header = { ...known, rest } as ImportedChatHeader;
  const messages = lines
    .slice(1)
    .map(({ line, lineNo }) => toMessage(parseLine(line, lineNo), lineNo));
  return { header, messages };
}

export function serializeChatJsonl(chat: ImportedChat): string {
  const { rest: headerRest, ...headerKnown } = chat.header;
  const lines = [JSON.stringify(joinKnown(headerKnown, headerRest, HEADER_KEYS))];
  for (const message of chat.messages) {
    const { rest, ...known } = message;
    lines.push(JSON.stringify(joinKnown(known, rest, MESSAGE_KEYS)));
  }
  return lines.join('\n');
}
