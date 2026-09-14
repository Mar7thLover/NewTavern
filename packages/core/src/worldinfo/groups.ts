/**
 * 包含组（inclusion group）：移植 ST 1.18 `world-info.js` 的
 * `filterByInclusionGroups` / `filterGroupsByTimedEffects` / `filterGroupsByScoring`。
 *
 * 与 ST 的差异：ST 的 `removeEntry` 用 `newEntries.splice(indexOf(entry), 1)`，
 * 同一条目属于多个组被移除两次时 `indexOf` 返回 -1，`splice(-1, 1)` 会误删数组末尾元素。
 * 此处对 -1 做保护（不误删），其余行为逐行照搬——包括 ST 里 `group` 数组不随
 * 时间态过滤同步收缩、以及「已激活组」判定用整串 `entry.group === key` 比较这两处细节。
 */

import { type ScanBuffer, type ScanState } from './buffer.js';
import { type TimedEffects } from './timed.js';
import { type WIEntry, type WIRejectReason, type WISettings } from './types.js';

/** ST DEFAULT_WEIGHT */
const DEFAULT_WEIGHT = 100;

export interface GroupFilterInput {
  /** 本轮候选条目；就地修改（落选者被移除） */
  newEntries: WIEntry[];
  /** 已激活条目（跨轮累计） */
  activated: ReadonlyMap<string, WIEntry>;
  buffer: ScanBuffer;
  scanState: ScanState;
  timed: TimedEffects;
  settings: WISettings;
  random: () => number;
  onRemoved: (entry: WIEntry, reason: WIRejectReason) => void;
}

/** ST sortFn：order 降序 */
const byOrderDesc = (a: WIEntry, b: WIEntry): number => b.order - a.order;

export function filterByInclusionGroups(input: GroupFilterInput): void {
  const { newEntries, activated, buffer, scanState, timed, settings, random, onRemoved } = input;

  const grouped = new Map<string, WIEntry[]>();
  for (const entry of newEntries) {
    if (!entry.group) continue;
    for (const name of entry.group.split(/,\s*/).filter((x) => x.length > 0)) {
      const list = grouped.get(name);
      if (list) list.push(entry);
      else grouped.set(name, [entry]);
    }
  }
  if (grouped.size === 0) return;

  const removeEntry = (entry: WIEntry, reason: WIRejectReason): void => {
    const index = newEntries.indexOf(entry);
    if (index < 0) return;
    newEntries.splice(index, 1);
    onRemoved(entry, reason);
  };

  // ① 时间态：组内有 sticky 就只留 sticky；cooldown / delay 的一律剔除
  const hasStickyMap = new Map<string, boolean>();
  for (const [name, group] of grouped) {
    hasStickyMap.set(name, false);
    const stickyEntries = group.filter((entry) => timed.isSticky(entry.id));
    if (stickyEntries.length > 0) {
      for (const entry of group) {
        if (stickyEntries.includes(entry)) continue;
        removeEntry(entry, 'group-lost');
      }
      hasStickyMap.set(name, true);
    }
    for (const entry of group) {
      if (timed.isCooldown(entry.id)) removeEntry(entry, 'cooldown');
    }
    for (const entry of group) {
      if (timed.isDelayed(entry.id)) removeEntry(entry, 'delay');
    }
  }

  // ② 组评分：只保留命中键数最高者（评分开关全局或条目级任一开启才生效）
  for (const [name, group] of grouped) {
    if (!settings.useGroupScoring && !group.some((entry) => entry.useGroupScoring)) continue;
    if (hasStickyMap.get(name)) continue;

    const scores = group.map((entry) => buffer.getScore(entry, scanState));
    const maxScore = Math.max(...scores);
    for (let i = 0; i < group.length; i++) {
      const entry = group[i];
      if (!entry) continue;
      const isScored = entry.useGroupScoring ?? settings.useGroupScoring;
      if (!isScored) continue;
      if ((scores[i] ?? 0) < maxScore) {
        removeEntry(entry, 'group-lost');
        group.splice(i, 1);
        scores.splice(i, 1);
        i--;
      }
    }
  }

  // ③ 组内选一个：prioritize 优先，否则按 groupWeight 加权随机
  for (const [name, group] of grouped) {
    if (hasStickyMap.get(name)) continue;

    // ST 用整串比较 entry.group === key，所以多组条目不会命中这个短路
    if ([...activated.values()].some((entry) => entry.group === name)) {
      for (const entry of group) removeEntry(entry, 'group-lost');
      continue;
    }

    if (group.length <= 1) continue;

    const prios = group.filter((entry) => entry.groupOverride).sort(byOrderDesc);
    const prioWinner = prios[0];
    if (prioWinner) {
      for (const entry of group) {
        if (entry !== prioWinner) removeEntry(entry, 'group-lost');
      }
      continue;
    }

    const totalWeight = group.reduce(
      (acc, entry) => acc + (entry.groupWeight ?? DEFAULT_WEIGHT),
      0,
    );
    const rollValue = random() * totalWeight;
    let currentWeight = 0;
    let winner: WIEntry | null = null;
    for (const entry of group) {
      currentWeight += entry.groupWeight ?? DEFAULT_WEIGHT;
      if (rollValue <= currentWeight) {
        winner = entry;
        break;
      }
    }
    if (!winner) continue;

    for (const entry of group) {
      if (entry !== winner) removeEntry(entry, 'group-lost');
    }
  }
}
