import { diffChars, diffWordsWithSpace, type Change } from 'diff';

/**
 * 字符级对照（M7 契约 §5.3 / §5.4）。两边加起来超过 `CHAR_DIFF_LIMIT` 个字符时
 * 字符级太慢，退化成按词（含空白）对照，界面上提示一句；再算不完（超时）就整段标成替换。
 */

export const CHAR_DIFF_LIMIT = 24_000;
const TIMEOUT_MS = 1500;

export type DiffKind = 'same' | 'added' | 'removed';

export interface DiffPart {
  kind: DiffKind;
  text: string;
}

export interface DiffResult {
  parts: DiffPart[];
  /** chars = 字符级；words = 大文本退化成按词；whole = 超时，整段替换 */
  mode: 'chars' | 'words' | 'whole';
  added: number;
  removed: number;
}

function toParts(changes: Change[]): DiffPart[] {
  const parts: DiffPart[] = [];
  for (const change of changes) {
    const kind: DiffKind = change.added ? 'added' : change.removed ? 'removed' : 'same';
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += change.value;
    else if (change.value !== '') parts.push({ kind, text: change.value });
  }
  return parts;
}

/** 夹在两处改动之间、不超过这么多字的相同片段并进改动里（中文逐字对照否则碎成一地） */
const MERGE_GAP = 2;

/**
 * 简单的语义整理：把两处改动之间很短的相同片段折进改动（删、增各算一份），
 * 再把每一段连续改动排成「先删后增」。结果仍然能还原出两边原文。
 */
export function mergeShortGaps(parts: DiffPart[], gap = MERGE_GAP): DiffPart[] {
  // 先切成「相同 / 改动块」交替的序列
  type Block = { kind: 'same'; text: string } | { kind: 'change'; removed: string; added: string };
  const blocks: Block[] = [];
  for (const part of parts) {
    const last = blocks[blocks.length - 1];
    if (part.kind === 'same') {
      blocks.push({ kind: 'same', text: part.text });
    } else if (last && last.kind === 'change') {
      if (part.kind === 'removed') last.removed += part.text;
      else last.added += part.text;
    } else {
      blocks.push({
        kind: 'change',
        removed: part.kind === 'removed' ? part.text : '',
        added: part.kind === 'added' ? part.text : '',
      });
    }
  }
  const merged: Block[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block) continue;
    const prev = merged[merged.length - 1];
    const next = blocks[i + 1];
    if (
      block.kind === 'same' &&
      prev?.kind === 'change' &&
      next?.kind === 'change' &&
      Array.from(block.text).length <= gap &&
      !block.text.includes('\n')
    ) {
      prev.removed += block.text + next.removed;
      prev.added += block.text + next.added;
      i += 1;
      continue;
    }
    if (block.kind === 'change' && prev?.kind === 'change') {
      prev.removed += block.removed;
      prev.added += block.added;
      continue;
    }
    merged.push({ ...block });
  }
  return merged.flatMap((block): DiffPart[] =>
    block.kind === 'same'
      ? [{ kind: 'same', text: block.text }]
      : [
          ...(block.removed ? [{ kind: 'removed' as const, text: block.removed }] : []),
          ...(block.added ? [{ kind: 'added' as const, text: block.added }] : []),
        ],
  );
}

function count(parts: DiffPart[], kind: DiffKind): number {
  return parts.reduce(
    (sum, part) => (part.kind === kind ? sum + Array.from(part.text).length : sum),
    0,
  );
}

export function computeDiff(before: string, after: string, limit = CHAR_DIFF_LIMIT): DiffResult {
  if (before === after) {
    return {
      parts: before ? [{ kind: 'same', text: before }] : [],
      mode: 'chars',
      added: 0,
      removed: 0,
    };
  }
  const large = before.length + after.length > limit;
  const changes = large
    ? diffWordsWithSpace(before, after, { timeout: TIMEOUT_MS })
    : diffChars(before, after, { timeout: TIMEOUT_MS });
  if (!changes) {
    const parts: DiffPart[] = [
      ...(before ? [{ kind: 'removed' as const, text: before }] : []),
      ...(after ? [{ kind: 'added' as const, text: after }] : []),
    ];
    return { parts, mode: 'whole', added: count(parts, 'added'), removed: count(parts, 'removed') };
  }
  // 计数按原始对照（真正增删的字数），展示用整理过的
  const raw = toParts(changes);
  return {
    parts: mergeShortGaps(raw),
    mode: large ? 'words' : 'chars',
    added: count(raw, 'added'),
    removed: count(raw, 'removed'),
  };
}
