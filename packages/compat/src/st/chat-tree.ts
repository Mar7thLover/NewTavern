/**
 * ST 聊天记录（线性消息 + swipes）↔ 新酒馆消息树 的纯转换。见 docs/M4-CONTRACT.md §2.1。
 *
 * 导入：第 i 条消息有 `swipes` 时，每个 swipe 一个兄弟节点（siblingSeq = swipe 下标），
 * `swipe_id` 指向的那个接后续消息；没有 `swipes` 就是单节点。
 * 导出：root→head 路径每个节点一条消息，无后代的兄弟回填 swipes，有后代的兄弟是分支（丢弃并计数）。
 *
 * 无损的关键是节点上的 `st`（导入时原样保留的 ST 字段，导出时以它为底叠加当前值）。
 * `st` 的约定是「假如选中的是这个 swipe，这条消息长什么样」：
 * - 路径节点：消息本身的键；
 * - 其余 swipe 兄弟：消息的键 + `swipe_info[k]` 的 send_date / gen_started / gen_finished / extra
 *   （ST `syncSwipeToMes` 切换 swipe 时就是这样把 swipe_info 抄回消息的）。
 * 于是任何一个兄弟被切到路径上，导出都与 ST 在那一刻保存的文件一致。
 */

import {
  chatMessageFromStRecord,
  chatMessageToStRecord,
  type ImportedChat,
  type ImportedChatHeader,
} from './chat-jsonl.js';
import { isRecord } from './util.js';

export type StNodeRole = 'user' | 'assistant' | 'system';

/** 归一后的媒体引用（ST `extra.media[]` 的元素，type 为 image / video / audio） */
export interface StMediaRef {
  type: string;
  url: string;
  title?: string;
}

/** 归一后的文件附件引用（ST `extra.files[]` 的元素） */
export interface StFileRef {
  url: string;
  name?: string;
  size?: number;
}

/** swipe 组在原文件里的形状（导出时判断「结构没变」→ 原样还原 swipe_info 的长度） */
export interface StSwipeGroup {
  /** 原消息下标：同一条消息的兄弟相同 */
  message: number;
  /** 原 swipes 长度 */
  size: number;
  /** 本节点在原 swipes 里的下标 */
  index: number;
  /** 原 swipe_info 长度；null = 原消息没有 swipe_info 数组 */
  infoLength: number | null;
}

/** 节点上原样保留的 ST 字段 */
export interface StNodeSource {
  /** 消息的其余键（ST 键名，含 name / is_user / is_system / gen_started 等），不含 mes / send_date / extra / swipes / swipe_id / swipe_info */
  rest: Record<string, unknown>;
  /** 消息 extra（兄弟：swipe_info[k].extra）；原值不是对象时放在 rest.extra */
  extra?: Record<string, unknown>;
  /** 消息 send_date（兄弟：swipe_info[k].send_date） */
  sendDate?: unknown;
  /** 原 swipe_info[k]：仅当它与「由本节点字段重建的元素」不同才保存（避免重复存推理全文） */
  swipeInfo?: unknown;
  /** 原 swipes[k] 与节点正文不同（ST 未污染的开场白 mes 已替换宏、swipes 未替换）时：导入时的正文 */
  mes?: string;
  /** 同上：原 swipes[k] */
  swipe?: string;
  /** 所在 swipe 组的原始形状（消息带 swipes 时） */
  group?: StSwipeGroup;
}

export interface TreeNodeDraft {
  /** 'm12' / 'm12s1'（第 12 条消息的第 1 个 swipe） */
  tempId: string;
  parentTempId: string | null;
  siblingSeq: number;
  role: StNodeRole;
  name: string | null;
  text: string;
  isHidden: boolean;
  /** ms；严格递增 */
  createdAt: number;
  reasoning: string | null;
  /** extra.media / 旧 extra.image / image_swipes / video 归一后的媒体引用 */
  media: StMediaRef[];
  /** extra.files / 旧 extra.file（文本附件） */
  files: StFileRef[];
  /** 原样保留，导出时以它为底 */
  st: StNodeSource;
}

export interface StChatTree {
  header: ImportedChatHeader;
  nodes: TreeNodeDraft[];
  headTempId: string | null;
  warnings: string[];
}

/** 导出用的节点视图（服务端由表行映射） */
export interface ExportNode {
  id: string;
  siblingSeq: number;
  role: StNodeRole;
  name: string | null;
  text: string;
  isHidden: boolean;
  /** ms */
  createdAt: number;
  reasoning: string | null;
  /** 是否有子节点（有后代的非路径兄弟是分支，不可导出） */
  hasChildren: boolean;
  st?: StNodeSource | null;
}

export interface TreeToStChatInput {
  /** 导入时保存的 header；缺省时合成一个 */
  header?: ImportedChatHeader;
  /** root→head */
  path: ExportNode[];
  /** 与该节点同父的全部节点（含自身） */
  siblingsOf: (node: ExportNode) => ExportNode[];
  /** 新建节点（没有 st）缺少 name 时的回退名 */
  names?: { user?: string; character?: string };
}

/* ------------------------------------------------------------------ */
/* 时间                                                                 */
/* ------------------------------------------------------------------ */

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

const pad = (value: string | number, length = 2) => String(value).padStart(length, '0');

const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}(?::?\d{2}(?::?\d{2}(?:[.,]\d+)?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/**
 * 解析 ST 的消息时间（照 `public/scripts/utils.js` 的 `parseTimestamp`）：
 * epoch 数字（或纯数字串）→ ISO 8601 → `June 19, 2023 2:20pm`（本地时间）→
 * humanized `2024-07-12@01h31m37s123ms` / `2024-7-12@01h31m37s` / `2024-6-5 @14h 56m 50s 682ms`（ST 按 UTC 解释）。
 * 解析不了返回 null。
 */
export function parseStDate(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const ms = Number(value);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();

  if (ISO_8601.test(text)) {
    const ms = Date.parse(text.replace(' ', 'T').replace(',', '.'));
    return Number.isNaN(ms) ? null : ms;
  }

  const meridiem = /(\w+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)/i.exec(text);
  if (meridiem) {
    const [, monthName = '', day = '', year = '', hour = '', minute = '', ampm = ''] = meridiem;
    const month = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);
    if (month < 0) return null;
    const hour12 = Number(hour) % 12;
    const hour24 = ampm.toLowerCase() === 'pm' ? hour12 + 12 : hour12;
    const date = new Date(Number(year), month, Number(day), hour24, Number(minute), 0, 0);
    const ms = date.getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  const humanized = [
    /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(\d{1,3})ms/,
    /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s/,
    /(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{1,2})h (\d{1,2})m (\d{1,2})s (\d{1,3})ms/,
  ];
  for (const pattern of humanized) {
    const match = pattern.exec(text);
    if (!match) continue;
    const [, year = '', month = '', day = '', hour = '', min = '', sec = '', ms] = match;
    const iso = `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(min)}:${pad(sec)}${
      ms === undefined ? '' : `.${pad(ms, 3)}`
    }Z`;
    const parsed = Date.parse(iso);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/** ST `humanizedDateTime`（本地时间）：`2024-07-12@01h31m37s123ms`，header 的 create_date 用它 */
export function humanizedDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `@${pad(date.getHours())}h${pad(date.getMinutes())}m${pad(date.getSeconds())}s${pad(date.getMilliseconds(), 3)}ms`
  );
}

/* ------------------------------------------------------------------ */
/* 媒体                                                                 */
/* ------------------------------------------------------------------ */

function toFileRef(value: unknown): StFileRef | null {
  if (!isRecord(value) || typeof value['url'] !== 'string' || value['url'] === '') return null;
  const ref: StFileRef = { url: value['url'] };
  if (typeof value['name'] === 'string') ref.name = value['name'];
  if (typeof value['size'] === 'number') ref.size = value['size'];
  return ref;
}

/**
 * 照 ST `ensureMessageMediaIsArray` 里的 `migrateMediaToArray` 归一（不改入参）：
 * `file` → `files[]`；`image_swipes[]` → `media[]`；`image` → `media[]`（按 url 去重）；`video` → `media[]`。
 */
export function normalizeStMedia(extra: unknown): { media: StMediaRef[]; files: StFileRef[] } {
  const media: StMediaRef[] = [];
  const files: StFileRef[] = [];
  if (!isRecord(extra)) return { media, files };

  if (Array.isArray(extra['files'])) {
    for (const item of extra['files']) {
      const ref = toFileRef(item);
      if (ref) files.push(ref);
    }
  }
  const single = toFileRef(extra['file']);
  if (single) files.push(single);

  if (Array.isArray(extra['media'])) {
    for (const item of extra['media']) {
      if (!isRecord(item) || typeof item['url'] !== 'string' || item['url'] === '') continue;
      const ref: StMediaRef = {
        type: typeof item['type'] === 'string' ? item['type'] : 'image',
        url: item['url'],
      };
      if (typeof item['title'] === 'string') ref.title = item['title'];
      media.push(ref);
    }
  }
  if (Array.isArray(extra['image_swipes'])) {
    for (const swipe of extra['image_swipes']) {
      if (typeof swipe === 'string' && swipe) media.push({ type: 'image', url: swipe });
    }
  }
  const image = extra['image'];
  if (typeof image === 'string' && image) {
    media.push({ type: 'image', url: image });
  }
  if (image !== undefined) {
    const seen = new Set<string>();
    for (let i = 0; i < media.length; i++) {
      const url = (media[i] as StMediaRef).url;
      if (seen.has(url)) media.splice(i--, 1);
      else seen.add(url);
    }
  }
  const video = extra['video'];
  if (typeof video === 'string' && video) media.push({ type: 'video', url: video });
  return { media, files };
}

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

/** JSON 值的深比较（键集合与值；undefined 视为缺键） */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keysA = Object.keys(a).filter((key) => a[key] !== undefined);
  const keysB = Object.keys(b).filter((key) => b[key] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
}

function omit(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) out[key] = value;
  }
  return out;
}

/** 消息上随 swipe 切换的键（ST `syncSwipeToMes` 抄回消息的那几个） */
const PER_SWIPE_KEYS = ['gen_started', 'gen_finished'] as const;
/** 不进 st.rest 的消息键 */
const MESSAGE_SHAPE_KEYS = ['mes', 'send_date', 'extra', 'swipes', 'swipe_id', 'swipe_info'];

function reasoningOf(extra: Record<string, unknown> | undefined): string | null {
  const value = extra?.['reasoning'];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 「假如选中的是这个 swipe」时的消息视图：rest / extra / sendDate */
interface MessageView {
  rest: Record<string, unknown>;
  extra?: Record<string, unknown>;
  sendDate?: unknown;
}

function viewFromRecord(
  rest: Record<string, unknown>,
  extra: unknown,
  sendDate: unknown,
): MessageView {
  const view: MessageView = { rest: { ...rest } };
  if (isRecord(extra)) view.extra = extra;
  else if (extra !== undefined) view.rest['extra'] = extra;
  if (sendDate !== undefined) view.sendDate = sendDate;
  return view;
}

/** 由消息视图重建 swipe_info 元素（ST `syncMesToSwipe` 的写法） */
function swipeInfoFromView(view: MessageView): Record<string, unknown> {
  const info: Record<string, unknown> = {};
  if (view.sendDate !== undefined) info['send_date'] = view.sendDate;
  for (const key of PER_SWIPE_KEYS) {
    if (view.rest[key] !== undefined) info[key] = view.rest[key];
  }
  if (view.extra !== undefined) info['extra'] = view.extra;
  else if (view.rest['extra'] !== undefined) info['extra'] = view.rest['extra'];
  return info;
}

/** ST 1.x 起 header 的 user_name / character_name 固定写 `'unused'`（`public/script.js` saveChat） */
const UNUSED_HEADER_NAME = 'unused';

/**
 * 聊天里的角色名与用户名：header 里有真名就用 header，
 * 否则（ST 新版写的是 `'unused'`）取第一条角色消息 / 用户消息的 `name`。
 */
export function stChatNames(chat: ImportedChat): {
  characterName: string | null;
  userName: string | null;
} {
  const fromHeader = (value: string | undefined) =>
    typeof value === 'string' && value !== '' && value !== UNUSED_HEADER_NAME ? value : null;
  let characterName = fromHeader(chat.header.characterName);
  let userName = fromHeader(chat.header.userName);
  for (const message of chat.messages) {
    if (characterName && userName) break;
    if (typeof message.name !== 'string' || message.name === '') continue;
    if (message.isUser) {
      userName ??= message.name;
    } else if (message.extra?.['type'] !== 'narrator') {
      characterName ??= message.name;
    }
  }
  return { characterName, userName };
}

/* ------------------------------------------------------------------ */
/* ST → 树                                                              */
/* ------------------------------------------------------------------ */

export function stChatToTree(chat: ImportedChat): StChatTree {
  const nodes: TreeNodeDraft[] = [];
  const warnings: string[] = [];

  // 起点：第一个能解析的消息时间（header 的 humanized 时间 ST 按 UTC 解释，会与消息错开时区，只作兜底）
  let firstDate: number | null = null;
  for (const message of chat.messages) {
    firstDate = parseStDate(message.sendDate);
    if (firstDate !== null) break;
  }
  let lastTime = (firstDate ?? parseStDate(chat.header.createDate) ?? Date.now()) - 1;
  const nextTime = (candidates: unknown[]): number => {
    let parsed: number | null = null;
    for (const candidate of candidates) {
      parsed = parseStDate(candidate);
      if (parsed !== null) break;
    }
    lastTime = parsed !== null && parsed > lastTime ? parsed : lastTime + 1;
    return lastTime;
  };

  let parentTempId: string | null = null;

  chat.messages.forEach((message, i) => {
    const record = chatMessageToStRecord(message);
    const rest = omit(record, MESSAGE_SHAPE_KEYS);
    const messageExtra = isRecord(record['extra']) ? record['extra'] : undefined;
    const role: StNodeRole =
      messageExtra?.['type'] === 'narrator' ? 'system' : record['is_user'] ? 'user' : 'assistant';
    const name = typeof record['name'] === 'string' ? record['name'] : null;
    const isHidden = Boolean(record['is_system']);
    const mes = message.mes;
    const messageView = viewFromRecord(rest, record['extra'], record['send_date']);

    const parent = parentTempId;
    const makeNode = (
      tempId: string,
      siblingSeq: number,
      text: string,
      view: MessageView,
      dateCandidates: unknown[],
    ): TreeNodeDraft => {
      const { media, files } = normalizeStMedia(view.extra);
      const st: StNodeSource = { rest: view.rest };
      if (view.extra !== undefined) st.extra = view.extra;
      if (view.sendDate !== undefined) st.sendDate = view.sendDate;
      return {
        tempId,
        parentTempId: parent,
        siblingSeq,
        role,
        name,
        text,
        isHidden,
        createdAt: nextTime(dateCandidates),
        reasoning: reasoningOf(view.extra),
        media,
        files,
        st,
      };
    };

    const swipes = message.swipes;
    if (!Array.isArray(swipes) || swipes.length === 0) {
      // 单节点；swipes 为空数组 / swipe_id / swipe_info 这类残缺形状原样放回 rest
      if (swipes !== undefined) messageView.rest['swipes'] = swipes;
      if (record['swipe_id'] !== undefined) messageView.rest['swipe_id'] = record['swipe_id'];
      if (record['swipe_info'] !== undefined) messageView.rest['swipe_info'] = record['swipe_info'];
      const node = makeNode(`m${i}`, 0, mes, messageView, [record['send_date']]);
      nodes.push(node);
      parentTempId = node.tempId;
      return;
    }

    const swipeInfo = Array.isArray(record['swipe_info']) ? record['swipe_info'] : null;
    if (record['swipe_info'] !== undefined && swipeInfo === null) {
      warnings.push(`第 ${i + 1} 条消息的 swipe_info 不是数组，已忽略`);
    }
    const swipeId = record['swipe_id'];
    let pathK: number;
    if (
      typeof swipeId === 'number' &&
      Number.isInteger(swipeId) &&
      swipeId >= 0 &&
      swipeId < swipes.length
    ) {
      pathK = swipeId;
    } else {
      const byText = swipes.indexOf(mes);
      pathK = byText >= 0 ? byText : 0;
      warnings.push(`第 ${i + 1} 条消息的 swipe_id 无效，已按第 ${pathK + 1} 个 swipe 接续`);
    }

    let pathTempId = '';
    swipes.forEach((swipe, k) => {
      const tempId = `m${i}s${k}`;
      const info = swipeInfo && k < swipeInfo.length ? swipeInfo[k] : undefined;
      let view: MessageView;
      let text: string;
      if (k === pathK) {
        view = messageView;
        text = mes;
      } else {
        const infoRecord = isRecord(info) ? info : {};
        view = viewFromRecord(
          { ...omit(rest, PER_SWIPE_KEYS), ...omit(infoRecord, ['send_date', 'extra']) },
          infoRecord['extra'],
          infoRecord['send_date'],
        );
        text = swipe;
      }
      const node = makeNode(tempId, k, text, view, [view.sendDate, record['send_date']]);
      node.st.group = {
        message: i,
        size: swipes.length,
        index: k,
        infoLength: swipeInfo ? swipeInfo.length : null,
      };
      if (swipe !== text) {
        node.st.mes = text;
        node.st.swipe = swipe;
      }
      if (info !== undefined && !jsonEqual(info, swipeInfoFromView(view))) {
        node.st.swipeInfo = info;
      }
      nodes.push(node);
      if (k === pathK) pathTempId = tempId;
    });
    parentTempId = pathTempId;
  });

  return { header: chat.header, nodes, headTempId: parentTempId, warnings };
}

/* ------------------------------------------------------------------ */
/* 树 → ST                                                              */
/* ------------------------------------------------------------------ */

/** 把节点当前的推理叠加到 extra 上；未变化时原样返回 */
function applyReasoning(
  extra: Record<string, unknown> | undefined,
  reasoning: string | null,
): Record<string, unknown> | undefined {
  const current = typeof extra?.['reasoning'] === 'string' ? extra['reasoning'] : '';
  const next = reasoning ?? '';
  if (current === next) return extra;
  const out = { ...(extra ?? {}) };
  if (next === '') delete out['reasoning'];
  else out['reasoning'] = next;
  return out;
}

/** 角色变化时调整 extra.type（narrator = system） */
function applyRole(
  extra: Record<string, unknown> | undefined,
  role: StNodeRole,
): Record<string, unknown> | undefined {
  const isNarrator = extra?.['type'] === 'narrator';
  if ((role === 'system') === isNarrator) return extra;
  const out = { ...(extra ?? {}) };
  if (role === 'system') out['type'] = 'narrator';
  else delete out['type'];
  return out;
}

/** 节点在「被选中」时的消息视图（没有 st 的新节点按 ST 新消息的形状合成） */
function viewOfNode(node: ExportNode): MessageView {
  const st = node.st;
  if (!st) {
    // ST 新消息（`sendMessageAsUser` / 生成结果）的形状
    return {
      rest: { is_user: node.role === 'user', is_system: node.isHidden },
      extra: applyReasoning({}, node.reasoning) ?? {},
      sendDate: new Date(node.createdAt).toISOString(),
    };
  }
  const view: MessageView = { rest: { ...st.rest } };
  if (st.extra !== undefined) view.extra = st.extra;
  if (st.sendDate !== undefined) view.sendDate = st.sendDate;
  const reasoned = applyReasoning(view.extra, node.reasoning);
  if (reasoned !== view.extra) {
    view.extra = reasoned;
    delete view.rest['extra'];
  }
  return view;
}

function messageRecordOf(
  node: ExportNode,
  view: MessageView,
  names: { user: string; character: string },
): Record<string, unknown> {
  const record: Record<string, unknown> = { ...view.rest };
  if (node.name !== null && record['name'] !== node.name) record['name'] = node.name;
  if (typeof record['name'] !== 'string') {
    record['name'] = node.role === 'user' ? names.user : names.character;
  }
  const isUser = node.role === 'user';
  if (Boolean(record['is_user']) !== isUser) record['is_user'] = isUser;
  if (Boolean(record['is_system']) !== node.isHidden) record['is_system'] = node.isHidden;
  if (view.sendDate !== undefined) record['send_date'] = view.sendDate;
  record['mes'] = node.text;
  const extra = applyRole(view.extra, node.role);
  if (extra !== undefined) record['extra'] = extra;
  return record;
}

/** swipes[k] 的文本：正文未改动且导入时 swipes[k] 与正文不同 → 还原原 swipe */
function swipeTextOf(node: ExportNode): string {
  const st = node.st;
  if (st?.swipe !== undefined && node.text === st.mes) return st.swipe;
  return node.text;
}

/**
 * 把导入草稿直接当作一棵树（id = tempId，不经数据库）交给 `treeToStChat`：
 * 往返测试用，也可用于导入前预览。`headTempId` 缺省取草稿的 head。
 */
export function exportInputFromDrafts(
  tree: Pick<StChatTree, 'header' | 'nodes' | 'headTempId'>,
  headTempId: string | null = tree.headTempId,
): TreeToStChatInput {
  const byId = new Map<string, ExportNode>();
  const parents = new Set<string>();
  for (const draft of tree.nodes) {
    if (draft.parentTempId !== null) parents.add(draft.parentTempId);
  }
  for (const draft of tree.nodes) {
    byId.set(draft.tempId, {
      id: draft.tempId,
      siblingSeq: draft.siblingSeq,
      role: draft.role,
      name: draft.name,
      text: draft.text,
      isHidden: draft.isHidden,
      createdAt: draft.createdAt,
      reasoning: draft.reasoning,
      hasChildren: parents.has(draft.tempId),
      st: draft.st,
    });
  }
  const parentOf = new Map(tree.nodes.map((draft) => [draft.tempId, draft.parentTempId]));
  const path: ExportNode[] = [];
  for (let cursor = headTempId; cursor !== null; cursor = parentOf.get(cursor) ?? null) {
    const node = byId.get(cursor);
    if (!node) break;
    path.unshift(node);
  }
  return {
    header: tree.header,
    path,
    siblingsOf: (node) =>
      tree.nodes
        .filter((draft) => draft.parentTempId === (parentOf.get(node.id) ?? null))
        .map((draft) => byId.get(draft.tempId) as ExportNode),
  };
}

export function treeToStChat(input: TreeToStChatInput): {
  chat: ImportedChat;
  droppedBranches: number;
} {
  const header: ImportedChatHeader = input.header ?? {
    userName: input.names?.user ?? 'User',
    characterName: input.names?.character ?? '',
    createDate: humanizedDateTime(input.path[0]?.createdAt ?? Date.now()),
    chatMetadata: {},
    rest: {},
  };
  const names = {
    user: input.names?.user ?? header.userName ?? 'User',
    character: input.names?.character ?? header.characterName ?? '',
  };

  let droppedBranches = 0;
  const messages = input.path.map((pathNode) => {
    const siblings = [...input.siblingsOf(pathNode)].sort((a, b) => a.siblingSeq - b.siblingSeq);
    if (!siblings.some((node) => node.id === pathNode.id)) siblings.push(pathNode);
    const group = siblings.filter((node) => node.id === pathNode.id || !node.hasChildren);
    droppedBranches += siblings.length - group.length;

    const view = viewOfNode(pathNode);
    const record = messageRecordOf(pathNode, view, names);

    const shape = pathNode.st?.group;
    if (group.length > 1 || shape !== undefined) {
      // 结构没变：兄弟个数、顺序与来源消息都与导入时一致
      const unchanged =
        shape !== undefined &&
        group.length === shape.size &&
        group.every(
          (node, pos) =>
            node.st?.group?.message === shape.message &&
            node.st.group.size === shape.size &&
            node.st.group.index === pos,
        );
      record['swipes'] = group.map(swipeTextOf);
      record['swipe_id'] = group.findIndex((node) => node.id === pathNode.id);
      if (!(unchanged && shape.infoLength === null)) {
        const length = unchanged ? Math.min(shape.infoLength ?? 0, group.length) : group.length;
        record['swipe_info'] = group.slice(0, length).map((node) => {
          const nodeView = node.id === pathNode.id ? view : viewOfNode(node);
          const raw = node.st?.swipeInfo;
          if (raw === undefined) return swipeInfoFromView(nodeView);
          // 原元素与重建不同（有额外键或本就不一致）：以原元素为底，只叠加推理的变化
          if (!isRecord(raw)) return raw;
          const rawExtra = isRecord(raw['extra']) ? raw['extra'] : undefined;
          const importedReasoning = reasoningOf(node.st?.extra);
          if (importedReasoning === node.reasoning) return raw;
          return { ...raw, extra: applyReasoning(rawExtra, node.reasoning) ?? {} };
        });
      }
    }
    return chatMessageFromStRecord(record);
  });

  return { chat: { header, messages }, droppedBranches };
}
