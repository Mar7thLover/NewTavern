import { diffChars, diffWordsWithSpace, type Change } from 'diff';

/*
 * 长文本的差异分段（AI 协作的「本轮改动」、版本页签共用）。
 * 默认按字符比（中文没有空格分词，按词比会把整句当一个词）；两段都很长或差异太大时
 * 字符级会很慢，退到按词（含空白）比；再不行就整段替换。
 */

export type DiffSegmentType = 'equal' | 'add' | 'del';

export interface DiffSegment {
  type: DiffSegmentType;
  text: string;
}

export interface TextDiff {
  segments: DiffSegment[];
  /** 实际用的粒度 */
  mode: 'chars' | 'words' | 'replace';
}

/** 两段合计超过这个长度就不做字符级 */
export const CHAR_DIFF_LIMIT = 24_000;
/** 字符级的最大编辑距离（超过即放弃，退到按词） */
const CHAR_MAX_EDIT = 4_000;
/** 按词的上限（合计长度） */
const WORD_DIFF_LIMIT = 400_000;
const WORD_MAX_EDIT = 8_000;

function toSegments(changes: Change[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const change of changes) {
    if (change.value === '') continue;
    const type: DiffSegmentType = change.added ? 'add' : change.removed ? 'del' : 'equal';
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += change.value;
    else out.push({ type, text: change.value });
  }
  return out;
}

function replaceAll(before: string, after: string): DiffSegment[] {
  const out: DiffSegment[] = [];
  if (before !== '') out.push({ type: 'del', text: before });
  if (after !== '') out.push({ type: 'add', text: after });
  return out;
}

export function diffText(before: string, after: string): TextDiff {
  if (before === after) {
    return { segments: before === '' ? [] : [{ type: 'equal', text: before }], mode: 'chars' };
  }
  if (before === '' || after === '')
    return { segments: replaceAll(before, after), mode: 'replace' };
  const total = before.length + after.length;
  if (total <= CHAR_DIFF_LIMIT) {
    const changes = diffChars(before, after, { maxEditLength: CHAR_MAX_EDIT });
    if (changes) return { segments: toSegments(changes), mode: 'chars' };
  }
  if (total <= WORD_DIFF_LIMIT) {
    const changes = diffWordsWithSpace(before, after, { maxEditLength: WORD_MAX_EDIT });
    if (changes) return { segments: toSegments(changes), mode: 'words' };
  }
  return { segments: replaceAll(before, after), mode: 'replace' };
}

export type CollapsedSegment = DiffSegment | { type: 'gap'; count: number };

/**
 * 折叠长的相同段：只留改动前后各 `context` 个字符，中间换成「省略 N 字」。
 * 首段只留尾部、末段只留头部。
 */
export function collapseEqual(segments: readonly DiffSegment[], context = 60): CollapsedSegment[] {
  const out: CollapsedSegment[] = [];
  segments.forEach((segment, index) => {
    if (segment.type !== 'equal') {
      out.push(segment);
      return;
    }
    const chars = Array.from(segment.text);
    const isFirst = index === 0;
    const isLast = index === segments.length - 1;
    const keepHead = isFirst ? 0 : context;
    const keepTail = isLast ? 0 : context;
    if (chars.length <= keepHead + keepTail + 12 || (isFirst && isLast)) {
      out.push(segment);
      return;
    }
    if (keepHead > 0) out.push({ type: 'equal', text: chars.slice(0, keepHead).join('') });
    out.push({ type: 'gap', count: chars.length - keepHead - keepTail });
    if (keepTail > 0)
      out.push({ type: 'equal', text: chars.slice(chars.length - keepTail).join('') });
  });
  return out;
}

/** 增删字数（给「+12 −3」这样的小计用） */
export function diffStats(segments: readonly DiffSegment[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const segment of segments) {
    const length = Array.from(segment.text).length;
    if (segment.type === 'add') added += length;
    else if (segment.type === 'del') removed += length;
  }
  return { added, removed };
}
