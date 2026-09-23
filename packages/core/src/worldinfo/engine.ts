/**
 * 世界书激活引擎：移植 SillyTavern 1.18 `public/scripts/world-info.js` 的
 * `checkWorldInfo` + `getSortedEntries`（扫描缓冲、键匹配、包含组、递归、时间态、预算、装饰器）。
 * 契约见 docs/M3-CONTRACT.md §1；纯 TS，随机 / 分词 / 宏替换全部由调用方注入。
 *
 * ## 已知的对 ST 的偏差（契约 §9 待同步）
 * 1. **不 trim 内容**：契约 §1.1 说「ST 会 trim」，但 ST 只 trim 扫描缓冲里的消息，
 *    条目内容原样进提示词（`worldInfoBefore = entries.join('\n')`）。为了 strict 逐字节一致，此处不 trim。
 * 2. **vectorized 不特殊处理**：ST 1.18 的 checkWorldInfo 完全不读 `entry.vectorized`，
 *    向量条目照常参与键匹配（向量扩展只是额外**强制**激活它们）。契约说「恒不激活」，此处按 ST。
 * 3. **dryRun**：ST 的 isDryRun 会跳过 sticky/cooldown 的判定；此处照常判定、只是不写回状态（见 timed.ts）。
 * 4. **@depth 分桶**：ST 查桶用 `depth ?? 4`、建桶用原始 `depth`（未归一），会让 depth 缺省的条目
 *    与 depth=4 的条目落进两个桶又互相吸附；此处统一归一为 `depth ?? 4`。
 * 5. **空内容**：ST 在正则处理后判空并剔除；本引擎在正则之前（WI 正则由 AS 在 §4.1 第 5 步应用），
 *    所以只剔除宏替换后就已为空的条目，AS 应在正则之后再剔一次。
 * 6. **组过滤的越界删除**：见 groups.ts 顶部注释。
 * 7. **CCv3 装饰器**：ST 只认 `@@activate` / `@@dont_activate`，其余按契约实现，见 decorators.ts。
 * 8. 时间态的「剩余消息数」换算与 swipe 语义见 timed.ts 顶部注释。
 */

import { MAX_SCAN_DEPTH, SCAN_STATE, ScanBuffer, type ScanState } from './buffer.js';
import { UNSUPPORTED_DECORATORS, applyDecorators } from './decorators.js';
import { filterByInclusionGroups } from './groups.js';
import { TimedEffects } from './timed.js';
import {
  type WIActivation,
  type WIActivationDiagnostic,
  type WIActivationReason,
  type WIBook,
  type WIEntry,
  type WILogic,
  type WIRejectReason,
  type WIRole,
  type WIScanBuckets,
  type WIScanInput,
  type WIScanResult,
  type WISettings,
} from './types.js';

export { applyDecorators, parseDecorators } from './decorators.js';

/** ST DEFAULT_DEPTH：position=4 未指定深度时的默认值 */
export const DEFAULT_DEPTH = 4;

const AND_ANY: WILogic = 0;
const NOT_ALL: WILogic = 1;
const NOT_ANY: WILogic = 2;
const AND_ALL: WILogic = 3;

const ROLE_SYSTEM: WIRole = 0;

/** ST sortFn：order 降序；Array#sort 稳定，同 order 保持入参顺序 */
export function sortActivations(list: readonly WIActivation[]): WIActivation[] {
  return [...list].sort((a, b) => b.entry.order - a.entry.order);
}

const byOrderDesc = (a: WIEntry, b: WIEntry): number => b.order - a.order;

/**
 * ST `getSortedEntries`：按 `world_info_character_strategy` 排序全局/角色书，
 * 聊天书永远最前、其次 persona 书；并在此处解析装饰器（与 ST 同一时机）。
 */
export function getSortedEntries(books: readonly WIBook[], settings: WISettings): WIEntry[] {
  const global: WIEntry[] = [];
  const char: WIEntry[] = [];
  const chat: WIEntry[] = [];
  const persona: WIEntry[] = [];
  const buckets = { global, char, chat, persona };

  for (const book of books) {
    for (const raw of book.entries) {
      buckets[book.scope].push(
        applyDecorators({
          ...raw,
          bookId: raw.bookId || book.id,
          source: raw.source ?? { bookName: book.name, scope: book.scope },
        }),
      );
    }
  }

  let merged: WIEntry[];
  switch (settings.characterStrategy ?? 1) {
    case 1: // character_first（ST 默认）
      merged = [...char.sort(byOrderDesc), ...global.sort(byOrderDesc)];
      break;
    case 2: // global_first
      merged = [...global.sort(byOrderDesc), ...char.sort(byOrderDesc)];
      break;
    default: // evenly
      merged = [...global, ...char].sort(byOrderDesc);
      break;
  }

  return [...chat.sort(byOrderDesc), ...persona.sort(byOrderDesc), ...merged];
}

/** ST `matchSecondaryKeys`：四种 selectiveLogic 的短路顺序逐行照搬 */
function matchSecondaryKeys(
  entry: WIEntry,
  textToScan: string,
  buffer: ScanBuffer,
  substitute: (text: string) => string,
): boolean {
  const logic = entry.selectiveLogic ?? AND_ANY;
  let hasAnyMatch = false;
  let hasAllMatch = true;

  for (const key of entry.secondaryKeys) {
    const substituted = substitute(key);
    const matched = !!substituted && buffer.matchKeys(textToScan, substituted.trim(), entry);
    if (matched) hasAnyMatch = true;
    else hasAllMatch = false;

    if (logic === AND_ANY && matched) return true;
    if (logic === NOT_ALL && !matched) return true;
  }

  if (logic === NOT_ANY && !hasAnyMatch) return true;
  if (logic === AND_ALL && hasAllMatch) return true;
  return false;
}

interface ActivationDraft {
  entry: WIEntry;
  reason: WIActivationReason;
  matchedKeys: string[];
  recursionLevel: number;
  groupWinner: boolean;
  diagnostic?: WIActivationDiagnostic;
}

function emptyBuckets(): WIScanBuckets {
  return {
    before: [],
    after: [],
    anTop: [],
    anBottom: [],
    emBefore: [],
    emAfter: [],
    depth: [],
    outlets: {},
  };
}

export function scanWorldInfo(input: WIScanInput): WIScanResult {
  const { settings, substitute, random, countTokens } = input;
  const warnings: string[] = [];
  const rejected: { entryId: string; reason: WIRejectReason }[] = [];
  const rejectedSeen = new Set<string>();
  const reject = (entry: WIEntry, reason: WIRejectReason): void => {
    const key = `${entry.id}\u0000${reason}`;
    if (rejectedSeen.has(key)) return;
    rejectedSeen.add(key);
    rejected.push({ entryId: entry.id, reason });
  };

  const sortedEntries = getSortedEntries(input.books, settings);
  for (const entry of sortedEntries) {
    for (const name of UNSUPPORTED_DECORATORS) {
      if (entry.decorators && name in entry.decorators) {
        warnings.push(`条目 ${entry.id} 的装饰器 @@${name} 未实现，已忽略`);
      }
    }
    if (entry.scanDepth !== undefined && entry.scanDepth !== null) {
      if (entry.scanDepth < 0 || entry.scanDepth > MAX_SCAN_DEPTH) {
        warnings.push(`条目 ${entry.id} 的扫描深度 ${entry.scanDepth} 非法`);
      }
    }
  }

  // ST: chatForWI = coreChat.map(includeNames ? `${name}: ${mes}` : mes).reverse()
  const messages = input.history
    .map((message) =>
      settings.includeNames && message.name ? `${message.name}: ${message.text}` : message.text,
    )
    .reverse();
  const buffer = new ScanBuffer(messages, input.globalScan, settings);
  for (const inject of input.injects ?? []) buffer.addInject(inject);

  const timed = new TimedEffects(
    sortedEntries,
    input.state,
    input.messageCount,
    input.dryRun === true,
  );

  let budget = Math.round(settings.budgetTokens) || 1;
  if (settings.budgetCap > 0 && budget > settings.budgetCap) budget = settings.budgetCap;

  if (sortedEntries.length === 0) {
    return {
      activations: [],
      buckets: emptyBuckets(),
      newState: timed.toState(),
      budgetUsed: 0,
      overflowed: false,
      rejected,
      warnings,
    };
  }

  const orderIndex = new Map(sortedEntries.map((entry, index) => [entry.id, index]));

  /** ST：delayUntilRecursion 的层级队列，从最小层开始逐层开闸 */
  const availableRecursionDelayLevels = [
    ...new Set(
      sortedEntries
        .filter((entry) => entry.delayUntilRecursion)
        .map((entry) =>
          entry.delayUntilRecursion === true ? 1 : Number(entry.delayUntilRecursion),
        ),
    ),
  ].sort((a, b) => a - b);
  let currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0;

  const activated = new Map<string, WIEntry>();
  const drafts = new Map<string, ActivationDraft>();
  const failedProbability = new Set<string>();
  /** id → 已宏替换的内容（ST 就地改 entry.content，替换结果跨轮复用） */
  const substituted = new Map<string, string>();
  const contentOf = (entry: WIEntry): string => substituted.get(entry.id) ?? entry.content;

  let scanState: ScanState = SCAN_STATE.INITIAL;
  let recursionLevel = 0;
  let overflowed = false;
  let count = 0;
  let allActivatedText = '';

  while (scanState !== SCAN_STATE.NONE) {
    // maxRecursionSteps 非零时 min activations 失效，反之亦然（ST 注释）
    if (settings.maxRecursionSteps && settings.maxRecursionSteps <= count) break;
    count++;

    let nextScanState: ScanState = SCAN_STATE.NONE;
    let nextRecursionLevel = recursionLevel;
    const activatedNow: WIEntry[] = [];
    const reasons = new Map<
      string,
      { reason: WIActivationReason; matchedKeys: string[]; diagnostic?: WIActivationDiagnostic }
    >();

    const keyReason: WIActivationReason =
      scanState === SCAN_STATE.RECURSION
        ? 'recursion'
        : scanState === SCAN_STATE.MIN_ACTIVATIONS
          ? 'minActivations'
          : 'key';

    for (const entry of sortedEntries) {
      // 已激活或已被概率淘汰的条目不再考虑
      if (failedProbability.has(entry.id) || activated.has(entry.id)) continue;

      if (entry.disabled) {
        reject(entry, 'disabled');
        continue;
      }

      // `@@is_greeting` 的条目是开场白而非世界书内容，永不注入（见 openers.ts）
      if (entry.isGreeting !== undefined) {
        reject(entry, 'greeting');
        continue;
      }

      if (entry.triggers && entry.triggers.length > 0) {
        if (!entry.triggers.includes(input.trigger ?? 'normal')) {
          reject(entry, 'trigger');
          continue;
        }
      }

      const filter = entry.characterFilter;
      if (filter && filter.names.length > 0) {
        const included = filter.names.includes(input.characterName ?? '');
        if (filter.isExclude ? included : !included) {
          reject(entry, 'character-filter');
          continue;
        }
      }
      if (filter && filter.tags.length > 0 && input.characterTags) {
        const includesTag = input.characterTags.some((tag) => filter.tags.includes(tag));
        if (filter.isExclude ? includesTag : !includesTag) {
          reject(entry, 'character-filter');
          continue;
        }
      }

      const isSticky = timed.isSticky(entry.id);

      if (timed.isDelayed(entry.id)) {
        reject(entry, 'delay');
        continue;
      }
      if (timed.isCooldown(entry.id) && !isSticky) {
        reject(entry, 'cooldown');
        continue;
      }

      // 递归相关的门禁只在「本轮由递归触发」时才放行
      if (scanState !== SCAN_STATE.RECURSION && entry.delayUntilRecursion && !isSticky) {
        reject(entry, 'delay-until-recursion');
        continue;
      }
      if (
        scanState === SCAN_STATE.RECURSION &&
        entry.delayUntilRecursion &&
        Number(entry.delayUntilRecursion) > currentRecursionDelayLevel &&
        !isSticky
      ) {
        reject(entry, 'delay-until-recursion');
        continue;
      }
      if (
        scanState === SCAN_STATE.RECURSION &&
        settings.recursive &&
        entry.excludeRecursion &&
        !isSticky
      ) {
        reject(entry, 'exclude-recursion');
        continue;
      }

      if (entry.decorators?.['activate'] === true) {
        activatedNow.push(entry);
        reasons.set(entry.id, {
          reason: 'constant',
          matchedKeys: [],
          ...(input.diagnostics ? { diagnostic: { via: 'decorator' } } : {}),
        });
        continue;
      }
      if (entry.decorators?.['dont_activate'] === true) {
        reject(entry, 'dont-activate');
        continue;
      }

      if (entry.constant) {
        activatedNow.push(entry);
        reasons.set(entry.id, { reason: 'constant', matchedKeys: [] });
        continue;
      }
      if (isSticky) {
        activatedNow.push(entry);
        reasons.set(entry.id, { reason: 'sticky', matchedKeys: [] });
        continue;
      }

      if (entry.keys.length === 0) continue;

      const textToScan = buffer.get(entry, scanState);
      // ST 用 find 取首个命中键；matchKeys 是纯函数，这里收集全部命中键供检查器展示
      const matchedKeys = entry.keys.filter((key) => {
        const value = substitute(key);
        return !!value && buffer.matchKeys(textToScan, value.trim(), entry);
      });
      if (matchedKeys.length === 0) continue;

      // 副键为空时忽略 selective（ST：所有条目的 selective 都为 true）
      const hasSecondaryKeywords = entry.selective && entry.secondaryKeys.length > 0;
      if (!hasSecondaryKeywords) {
        activatedNow.push(entry);
        reasons.set(entry.id, { reason: keyReason, matchedKeys });
        continue;
      }

      if (!matchSecondaryKeys(entry, textToScan, buffer, substitute)) continue;
      activatedNow.push(entry);
      reasons.set(entry.id, {
        reason: keyReason,
        matchedKeys,
        ...(input.diagnostics
          ? {
              diagnostic: {
                via: 'secondary',
                // 与主键同样收集全部命中的副键（matchKeys 是纯函数，不影响判定）
                matchedSecondaryKeys: entry.secondaryKeys.filter((key) => {
                  const value = substitute(key);
                  return !!value && buffer.matchKeys(textToScan, value.trim(), entry);
                }),
              },
            }
          : {}),
      });
    }

    // sticky 优先，其次按 sortedEntries 的顺序（ST 用于概率与预算检查的顺序）
    const newEntries = [...activatedNow].sort((a, b) => {
      const stickyDiff = (timed.isSticky(b.id) ? 1 : 0) - (timed.isSticky(a.id) ? 1 : 0);
      return stickyDiff || (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0);
    });

    const groupedIds = new Set(newEntries.filter((entry) => entry.group).map((entry) => entry.id));
    const textToScanTokens = countTokens(allActivatedText);

    filterByInclusionGroups({
      newEntries,
      activated,
      buffer,
      scanState,
      timed,
      settings,
      random,
      onRemoved: reject,
    });

    let newContent = '';
    let ignoresBudget = newEntries.filter((entry) => entry.ignoreBudget).length;

    for (const entry of newEntries) {
      ignoresBudget -= entry.ignoreBudget ? 1 : 0;
      if (overflowed && !entry.ignoreBudget) {
        reject(entry, 'budget');
        // 后面还有 ignoreBudget 条目就继续找，否则整轮到此为止
        if (ignoresBudget > 0) continue;
        break;
      }

      // 概率：sticky 的条目不重摇
      const probability = entry.probability ?? 100;
      if (entry.useProbability && probability !== 100 && !timed.isSticky(entry.id)) {
        if (random() * 100 > probability) {
          failedProbability.add(entry.id);
          reject(entry, 'probability');
          continue;
        }
      }

      const content = substitute(entry.content);
      substituted.set(entry.id, content);
      newContent += `${content}\n`;

      if (!entry.ignoreBudget && textToScanTokens + countTokens(newContent) >= budget) {
        if (!overflowed) {
          overflowed = true;
          if (settings.overflowAlert) {
            warnings.push(`世界书预算 ${budget} token 已用尽，在 ${activated.size} 条后停止`);
          }
        }
        reject(entry, 'budget');
        continue;
      }

      activated.set(entry.id, entry);
      drafts.set(entry.id, {
        entry,
        reason: reasons.get(entry.id)?.reason ?? 'key',
        matchedKeys: reasons.get(entry.id)?.matchedKeys ?? [],
        recursionLevel,
        groupWinner: groupedIds.has(entry.id),
        ...(reasons.get(entry.id)?.diagnostic
          ? { diagnostic: reasons.get(entry.id)?.diagnostic }
          : {}),
      });
    }

    // 注意：ST 把「进了预算之外」的条目也算作成功条目，它们的内容照样进递归缓冲
    const successfulNewEntries = newEntries.filter((entry) => !failedProbability.has(entry.id));
    const forRecursion = successfulNewEntries.filter((entry) => !entry.preventRecursion);

    if (settings.recursive && !overflowed && forRecursion.length > 0) {
      nextScanState = SCAN_STATE.RECURSION;
      nextRecursionLevel = recursionLevel + 1;
    }
    // min activations 轮次结束后若已有递归缓冲，先做一次递归扫描再继续加深
    if (
      settings.recursive &&
      !overflowed &&
      scanState === SCAN_STATE.MIN_ACTIVATIONS &&
      buffer.hasRecurse()
    ) {
      nextScanState = SCAN_STATE.RECURSION;
      nextRecursionLevel = recursionLevel + 1;
    }

    const minActivationsNotSatisfied =
      settings.minActivations > 0 && activated.size < settings.minActivations;
    if (nextScanState === SCAN_STATE.NONE && !overflowed && minActivationsNotSatisfied) {
      const overMax =
        (settings.minActivationsDepthMax > 0 &&
          buffer.getDepth() > settings.minActivationsDepthMax) ||
        buffer.getDepth() > input.messageCount;
      if (!overMax) {
        nextScanState = SCAN_STATE.MIN_ACTIVATIONS;
        buffer.advanceScan();
      }
    }

    // 扫描本该结束，但还有未开闸的 delayUntilRecursion 层级
    if (nextScanState === SCAN_STATE.NONE && availableRecursionDelayLevels.length > 0) {
      nextScanState = SCAN_STATE.RECURSION;
      currentRecursionDelayLevel = availableRecursionDelayLevels.shift() ?? 0;
      nextRecursionLevel = recursionLevel + 1;
    }

    scanState = nextScanState;
    recursionLevel = nextRecursionLevel;

    if (scanState !== SCAN_STATE.NONE) {
      const text = forRecursion.map((entry) => contentOf(entry)).join('\n');
      if (text) {
        buffer.addRecurse(text);
        allActivatedText = text + '\n' + allActivatedText;
      }
    }
  }

  timed.setTimedEffects(activated.values());

  // 前几轮的压制只是中间状态：最终激活了的条目不算「被拒」
  const stillRejected = rejected.filter((item) => !activated.has(item.entryId));
  rejected.length = 0;
  rejected.push(...stillRejected);

  // ── 构建分桶：ST 按 order 降序遍历并 unshift，所以桶内最终是 order 升序 ──
  const activations: WIActivation[] = sortActivations(
    [...drafts.values()].map((draft) => {
      const content = contentOf(draft.entry);
      return {
        entry: draft.entry,
        reason: draft.reason,
        matchedKeys: draft.matchedKeys,
        recursionLevel: draft.recursionLevel,
        groupWinner: draft.groupWinner,
        content,
        tokens: countTokens(content),
        ...(draft.diagnostic ? { diagnostic: draft.diagnostic } : {}),
      };
    }),
  );

  const buckets = emptyBuckets();
  for (const activation of activations) {
    if (!activation.content) {
      reject(activation.entry, 'empty-content');
      continue;
    }
    switch (activation.entry.position) {
      case 0:
        buckets.before.unshift(activation);
        break;
      case 1:
        buckets.after.unshift(activation);
        break;
      case 2:
        buckets.anTop.unshift(activation);
        break;
      case 3:
        buckets.anBottom.unshift(activation);
        break;
      case 5:
        buckets.emBefore.unshift(activation);
        break;
      case 6:
        buckets.emAfter.unshift(activation);
        break;
      case 4: {
        const depth = activation.entry.depth ?? DEFAULT_DEPTH;
        const role = activation.entry.role ?? ROLE_SYSTEM;
        const bucket = buckets.depth.find((item) => item.depth === depth && item.role === role);
        if (bucket) bucket.entries.unshift(activation);
        else buckets.depth.push({ depth, role, entries: [activation] });
        break;
      }
      case 7: {
        const name = activation.entry.outletName;
        if (!name) {
          warnings.push(`条目 ${activation.entry.id} 的位置是出口但没有出口名，已跳过`);
          break;
        }
        const list = buckets.outlets[name];
        // ST 对出口用 push（不是 unshift），所以出口内是 order 降序
        if (list) list.push(activation);
        else buckets.outlets[name] = [activation];
        break;
      }
    }
  }

  const budgetUsed = countTokens(activations.map((item) => `${item.content}\n`).join(''));

  return {
    activations,
    buckets,
    newState: timed.toState(),
    budgetUsed,
    overflowed,
    rejected,
    warnings,
  };
}
