import {
  estimateTokens,
  scanWorldInfo,
  substituteMacros,
  type WIActivation,
  type WIRejectReason,
} from '@newtavern/core';

import type { Db } from '../db/client.js';
import type { LorebookRow } from './character-book.js';
import { loadLorebookDetail, type EntryInput, type EntryRow } from './lorebook-edit.js';
import { draftEntryRows } from './studio-draft.js';
import { bookFromRows } from './wi-map.js';
import { readWISettings } from './wi-settings.js';

/**
 * 世界书触发模拟（M6 §2.5）：把一段文字当作一条用户消息，用 core 的 WI 引擎对**这一本书**
 * 扫描一次（dryRun，不推进时间态、不落库），返回哪些条目激活、为什么，哪些被跳过。
 *
 * 设置取全局世界书设置（`worldInfo.settings`，扫描深度可由请求覆盖）；预算按
 * `SIMULATE_MAX_CONTEXT` 换算（模拟时没有具体模型）。概率条目按真实随机摇。
 */

/** 模拟时没有模型上下文，预算按这个上下文长度换算 */
export const SIMULATE_MAX_CONTEXT = 32768;

export type SimulateReason = 'constant' | 'key' | 'secondary' | 'recursion' | 'decorator';

export interface SimulateActivated {
  /** 条目 id；草稿里的新条目（无 id）为 null，用 index 对应 */
  id: string | null;
  /** 在条目列表（草稿 entries 或库里的展示顺序）中的下标 */
  index: number;
  uid: number | null;
  comment: string | null;
  reason: SimulateReason;
  /** 命中的主键；reason='secondary' 时后面接着命中的副键 */
  matchedKeys: string[];
  position: number;
  depth: number | null;
  order: number;
  /** 第几轮递归激活的（0 = 直接命中） */
  recursionLevel: number;
}

export interface SimulateSkipped {
  id: string | null;
  index: number;
  uid: number | null;
  /** 引擎的拒绝原因；`no-match` = 有关键词但这段文字里没命中 */
  reason: WIRejectReason | 'no-match';
}

export interface SimulateResult {
  activated: SimulateActivated[];
  skipped: SimulateSkipped[];
  warnings: string[];
}

export interface SimulateInput {
  text: string;
  /** 草稿条目（已按 PUT 规则校验）；缺省用库里的条目 */
  entries?: EntryInput[];
  scanDepth?: number;
}

function reasonOf(activation: WIActivation): SimulateReason {
  if (activation.diagnostic?.via === 'decorator') return 'decorator';
  if (activation.reason === 'constant') return 'constant';
  if (activation.reason === 'recursion') return 'recursion';
  if (activation.diagnostic?.via === 'secondary') return 'secondary';
  // sticky（模拟没有时间态，不会出现）/ minActivations 都是关键词扫描的延伸
  return 'key';
}

export function simulateLorebook(
  db: Db,
  bookId: string,
  input: SimulateInput,
): SimulateResult | undefined {
  const detail = loadLorebookDetail(db, bookId);
  if (!detail) return undefined;
  const rows: EntryRow[] = input.entries
    ? draftEntryRows(db, bookId, input.entries)
    : detail.entries;

  const book = bookFromRows(detail as LorebookRow, rows, 'global');
  // 引擎条目 id = `${bookId}:${uid}`，映射回行
  const byEntryId = new Map(
    book.entries.map((entry, index) => [entry.id, { row: rows[index] as EntryRow, index }]),
  );
  const draftId = (row: EntryRow) => (row.id.startsWith('draft:') ? null : row.id);

  const settings = readWISettings(db, { maxContext: SIMULATE_MAX_CONTEXT, maxResponse: 0 });
  if (input.scanDepth !== undefined) settings.scanDepth = input.scanDepth;

  const result = scanWorldInfo({
    books: [book],
    settings,
    history: [{ role: 'user', text: input.text }],
    globalScan: {},
    state: null,
    messageCount: 1,
    substitute: (text) => substituteMacros(text, {}),
    random: Math.random,
    countTokens: estimateTokens,
    dryRun: true,
    diagnostics: true,
  });

  const activated: SimulateActivated[] = [];
  const touched = new Set<string>();
  for (const activation of result.activations) {
    const hit = byEntryId.get(activation.entry.id);
    if (!hit) continue;
    touched.add(activation.entry.id);
    const reason = reasonOf(activation);
    activated.push({
      id: draftId(hit.row),
      index: hit.index,
      uid: hit.row.uid,
      comment: hit.row.comment,
      reason,
      matchedKeys: [
        ...activation.matchedKeys,
        ...(activation.diagnostic?.matchedSecondaryKeys ?? []),
      ],
      position: activation.entry.position,
      depth: activation.entry.depth ?? null,
      order: activation.entry.order,
      recursionLevel: activation.recursionLevel,
    });
  }

  const skipped: SimulateSkipped[] = [];
  for (const rejected of result.rejected) {
    const hit = byEntryId.get(rejected.entryId);
    if (!hit) continue;
    touched.add(rejected.entryId);
    skipped.push({
      id: draftId(hit.row),
      index: hit.index,
      uid: hit.row.uid,
      reason: rejected.reason,
    });
  }
  // 有关键词、没被拒、也没激活 = 这段文字里没命中
  for (const entry of book.entries) {
    if (touched.has(entry.id) || entry.keys.length === 0) continue;
    const hit = byEntryId.get(entry.id);
    if (!hit) continue;
    skipped.push({ id: draftId(hit.row), index: hit.index, uid: hit.row.uid, reason: 'no-match' });
  }
  skipped.sort((a, b) => a.index - b.index);

  return { activated, skipped, warnings: result.warnings };
}
