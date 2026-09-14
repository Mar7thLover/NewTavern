/** strict 与 cache-aware 的 segment 级 diff（M3 契约 §5）。以 `Segment.id` 对齐。 */

import { type PromptIR } from '../ir.js';
import { type LayoutDiff } from './types.js';

export function diffLayouts(strict: PromptIR, cacheAware: PromptIR): LayoutDiff {
  const strictIndex = new Map(strict.segments.map((segment, index) => [segment.id, index]));
  const cacheIndex = new Map(cacheAware.segments.map((segment, index) => [segment.id, index]));

  const moved: string[] = [];
  const clamped: string[] = [];
  let unchanged = 0;

  // strict 里的相对顺序（只统计两边都有的段），用于判断「是否换了位置」
  const common = strict.segments.filter((segment) => cacheIndex.has(segment.id)).map((s) => s.id);
  const commonInCache = cacheAware.segments
    .filter((segment) => strictIndex.has(segment.id))
    .map((s) => s.id);

  for (const segment of strict.segments) {
    const target = cacheAware.segments.find((item) => item.id === segment.id);
    if (target === undefined) {
      moved.push(segment.id);
      continue;
    }
    if ((segment.anchor.depth ?? null) !== (target.anchor.depth ?? null)) {
      clamped.push(segment.id);
      continue;
    }
    if (common.indexOf(segment.id) !== commonInCache.indexOf(segment.id)) {
      moved.push(segment.id);
      continue;
    }
    unchanged += 1;
  }

  // 只在 cache-aware 里出现的段（例如合并出来的 WI 承载段）也算「被移动」
  for (const segment of cacheAware.segments) {
    if (!strictIndex.has(segment.id)) moved.push(segment.id);
  }

  return { moved, clamped, unchanged };
}
