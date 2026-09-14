/**
 * 时间态（sticky / cooldown / delay）：移植 ST 1.18 `world-info.js` 的 `WorldInfoTimedEffects`，
 * 但把「全局 chat_metadata.timedWorldInfo + 绝对消息下标」改为「按节点快照 + 剩余消息数」。
 *
 * ## 换算（ST → 本引擎）
 * ST 为每个效果存 `{ start, end }`，`start = chat.length`（激活当轮的消息条数），
 * `end = start + entry[type]`；下一轮以 `chat.length >= end` 判定结束，`chat.length < end` 判定仍生效。
 * 本引擎存 `remaining = end - messageCount`，并在快照里记下当轮的 `messageCount`：
 * - 新建效果：`remaining = entry.sticky / entry.cooldown`（等价于 `end - start`）；
 * - 下一轮：`delta = messageCount_now - state.messageCount`，`remaining -= delta`；
 *   `remaining > 0` ⇔ ST 的 `chat.length < end`（仍生效），`remaining <= 0` ⇔ ST 的 `chat.length >= end`（结束）。
 * 一个「你一句我一句」的回合会让 messageCount +2，所以 sticky=2 只覆盖激活当轮，sticky=3 才多撑一轮——
 * 与 ST 完全一致（ST 的 sticky 也是按**消息**而非按回合计数）。
 *
 * ## 有意的行为差异
 * - ST 的「chat 未前进就删除效果」（`chat.length <= start && !protected`）是为了修补 swipe / 重生在全局
 *   metadata 上双重推进的问题（见 docs/PLAN.md §七-7）。按节点快照时 swipe 会带着同一个父快照重扫，
 *   `delta = 0`，时间态自然不前进，因此该清理规则不再需要，也不移植（`protected` 标记同理不需要）。
 * - `dryRun`：ST 的 isDryRun 会**完全跳过** sticky/cooldown 的检查（等于这两种效果失效）；
 *   检查器需要预览与真实生成一致的结果，所以本引擎照常判定，只是不把新状态写回（契约 §1.1）。
 */

import { type WIEntry, type WITimedState } from './types.js';

export type TimedEffectType = 'sticky' | 'cooldown';

export class TimedEffects {
  /** 剩余消息数，相对本轮 messageCount */
  readonly #sticky = new Map<string, number>();
  readonly #cooldown = new Map<string, number>();
  readonly #activeSticky = new Set<string>();
  readonly #activeCooldown = new Set<string>();
  readonly #activeDelay = new Set<string>();
  readonly #messageCount: number;
  readonly #dryRun: boolean;
  readonly #inputState: WITimedState | null;

  constructor(
    entries: readonly WIEntry[],
    state: WITimedState | null,
    messageCount: number,
    dryRun: boolean,
  ) {
    this.#messageCount = messageCount;
    this.#dryRun = dryRun;
    this.#inputState = state;

    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    // 分支/swipe 会拿同一个父快照重扫，delta = 0；负数同样视为 0（不倒退）
    const delta = state ? Math.max(0, messageCount - (state.messageCount ?? messageCount)) : 0;

    for (const [id, remaining] of Object.entries(state?.sticky ?? {})) {
      const left = remaining - delta;
      const entry = byId.get(id);
      // 条目当前不可见（比如换了角色书）：只保留计时，不激活（ST：entry not found）
      if (!entry) {
        if (left > 0) this.#sticky.set(id, left);
        continue;
      }
      // 条目已取消 sticky 配置：丢弃
      if (!entry.sticky) continue;
      if (left > 0) {
        this.#sticky.set(id, left);
        this.#activeSticky.add(id);
        continue;
      }
      // sticky 结束：ST 的 onEnded 会立刻挂上 cooldown，并在**本轮**就生效
      if (entry.cooldown) {
        this.#cooldown.set(id, entry.cooldown);
        this.#activeCooldown.add(id);
      }
    }

    for (const [id, remaining] of Object.entries(state?.cooldown ?? {})) {
      // 本轮刚由 sticky 结束触发的冷却覆盖旧值（ST 直接覆写 metadata 同 key）
      if (this.#cooldown.has(id)) continue;
      const left = remaining - delta;
      const entry = byId.get(id);
      if (!entry) {
        if (left > 0) this.#cooldown.set(id, left);
        continue;
      }
      if (!entry.cooldown) continue;
      if (left > 0) {
        this.#cooldown.set(id, left);
        this.#activeCooldown.add(id);
      }
    }

    // delay 不是持久状态：直接比消息计数（ST `#checkDelayEffect`）
    for (const entry of entries) {
      if (entry.delay && messageCount < entry.delay) {
        this.#activeDelay.add(entry.id);
      }
    }
  }

  isSticky(entryId: string): boolean {
    return this.#activeSticky.has(entryId);
  }

  isCooldown(entryId: string): boolean {
    return this.#activeCooldown.has(entryId);
  }

  isDelayed(entryId: string): boolean {
    return this.#activeDelay.has(entryId);
  }

  /** ST `setTimedEffects`：本轮激活的条目挂上 sticky / cooldown（已存在的不重置计时） */
  setTimedEffects(activated: Iterable<WIEntry>): void {
    for (const entry of activated) {
      if (entry.sticky && !this.#sticky.has(entry.id)) {
        this.#sticky.set(entry.id, entry.sticky);
      }
      if (entry.cooldown && !this.#cooldown.has(entry.id)) {
        this.#cooldown.set(entry.id, entry.cooldown);
      }
    }
  }

  /** 写入新节点的快照；dryRun 时等于输入 state（契约 §1.1） */
  toState(): WITimedState {
    if (this.#dryRun) {
      return {
        sticky: { ...this.#inputState?.sticky },
        cooldown: { ...this.#inputState?.cooldown },
        messageCount: this.#inputState?.messageCount ?? this.#messageCount,
      };
    }
    return {
      sticky: Object.fromEntries(this.#sticky),
      cooldown: Object.fromEntries(this.#cooldown),
      messageCount: this.#messageCount,
    };
  }
}
