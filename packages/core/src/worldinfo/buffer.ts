/**
 * 扫描缓冲：移植 ST 1.18 `world-info.js` 的 `WorldInfoBuffer`
 * （`#initDepthBuffer` / `get` / `matchKeys` / `getScore` / `addRecurse` / `advanceScan` / `getDepth`）。
 */

import { type WIEntry, type WIGlobalScanData, type WILogic, type WISettings } from './types.js';

/** ST MAX_SCAN_DEPTH */
export const MAX_SCAN_DEPTH = 1000;

/** ST scan_state */
export const SCAN_STATE = {
  NONE: 0,
  INITIAL: 1,
  RECURSION: 2,
  MIN_ACTIVATIONS: 3,
} as const;
export type ScanState = (typeof SCAN_STATE)[keyof typeof SCAN_STATE];

const AND_ANY: WILogic = 0;
const AND_ALL: WILogic = 3;

/** ST 用 \x01 标记每条消息的开头，让整词匹配的 `(?:^|\W)` 边界在消息首字也成立 */
const MATCHER = '\x01';
const JOINER = '\n' + MATCHER;

/** ST utils.escapeRegex */
export function escapeRegex(input: string): string {
  return input.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * ST `parseRegexFromString`：只接受 `/pattern/flags` 形式，且模式内的 `/` 必须转义。
 * 注意 ST 用 `pattern.replace('\\/', '/')` 反转义——只替换**第一个**出现，此处照搬。
 */
export function parseKeyRegex(input: string): RegExp | null {
  const match = /^\/([\w\W]+?)\/([gimsuy]*)$/.exec(input);
  if (!match) return null;
  let pattern = match[1] ?? '';
  const flags = match[2] ?? '';
  if (/(^|[^\\])\//.test(pattern)) return null;
  pattern = pattern.replace('\\/', '/');
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

export class ScanBuffer {
  /** 按深度升序（下标 0 = 最新一条），已 trim */
  readonly #depthBuffer: string[] = [];
  readonly #recurseBuffer: string[] = [];
  readonly #injectBuffer: string[] = [];
  readonly #globalScan: WIGlobalScanData;
  readonly #settings: WISettings;
  /** min activations 逐步加深用的偏移 */
  #skew = 0;

  /**
   * @param messages 倒序（最新在前）的消息文本，含 includeNames 前缀
   */
  constructor(messages: readonly string[], globalScan: WIGlobalScanData, settings: WISettings) {
    this.#globalScan = globalScan;
    this.#settings = settings;
    for (let depth = 0; depth < MAX_SCAN_DEPTH; depth++) {
      const message = messages[depth];
      if (message !== undefined) {
        this.#depthBuffer[depth] = message.trim();
      }
      if (depth === messages.length - 1) break;
    }
  }

  #transformString(str: string, entry: WIEntry): string {
    const caseSensitive = entry.caseSensitive ?? this.#settings.caseSensitive;
    return caseSensitive ? str : str.toLowerCase();
  }

  /** ST `get`：最近 depth 条消息 + 各 match* 扫描源 + 注入 + （非 min-activations 时）递归缓冲 */
  get(entry: WIEntry, scanState: ScanState): string {
    let depth = entry.scanDepth ?? this.getDepth();
    // ST: startDepth 恒为 0，所以 scanDepth <= 0 的条目什么都扫不到
    if (depth <= 0) return '';
    if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH;

    let result = MATCHER + this.#depthBuffer.slice(0, depth).join(JOINER);

    const global = this.#globalScan;
    if (entry.matchPersonaDescription && global.personaDescription) {
      result += JOINER + global.personaDescription;
    }
    if (entry.matchCharacterDescription && global.characterDescription) {
      result += JOINER + global.characterDescription;
    }
    if (entry.matchCharacterPersonality && global.characterPersonality) {
      result += JOINER + global.characterPersonality;
    }
    if (entry.matchCharacterDepthPrompt && global.characterDepthPrompt) {
      result += JOINER + global.characterDepthPrompt;
    }
    if (entry.matchScenario && global.scenario) {
      result += JOINER + global.scenario;
    }
    if (entry.matchCreatorNotes && global.creatorNotes) {
      result += JOINER + global.creatorNotes;
    }
    if (this.#injectBuffer.length > 0) {
      result += JOINER + this.#injectBuffer.join(JOINER);
    }
    // min activations 的加深扫描不看递归缓冲
    if (this.#recurseBuffer.length > 0 && scanState !== SCAN_STATE.MIN_ACTIVATIONS) {
      result += JOINER + this.#recurseBuffer.join(JOINER);
    }

    return result;
  }

  /** ST `matchKeys`：`/re/flags` 形式的键走正则并忽略其余开关，否则按条目/全局的大小写与整词设置 */
  matchKeys(haystack: string, needle: string, entry: WIEntry): boolean {
    const keyRegex = parseKeyRegex(needle);
    if (keyRegex) {
      return keyRegex.test(haystack);
    }

    const hay = this.#transformString(haystack, entry);
    const transformed = this.#transformString(needle, entry);
    const matchWholeWords = entry.matchWholeWords ?? this.#settings.matchWholeWords;

    if (matchWholeWords) {
      // 多词键退化为子串匹配（ST 的行为）
      if (transformed.split(/\s+/).length > 1) {
        return hay.includes(transformed);
      }
      // ST 用 \W 作边界，因此 CJK（\W）两侧的 CJK 键仍能命中，只有紧邻 [A-Za-z0-9_] 时才失败
      return new RegExp(`(?:^|\\W)(${escapeRegex(transformed)})(?:$|\\W)`).test(hay);
    }

    return hay.includes(transformed);
  }

  /** ST `getScore`：主键命中数（+ AND_ANY/AND_ALL 下的副键命中数），供组评分使用 */
  getScore(entry: WIEntry, scanState: ScanState): number {
    const bufferState = this.get(entry, scanState);
    let primaryScore = 0;
    let secondaryScore = 0;

    // ST 在评分时**不做**宏替换（与主匹配循环不同），此处照搬
    for (const key of entry.keys) {
      if (this.matchKeys(bufferState, key, entry)) primaryScore++;
    }
    for (const key of entry.secondaryKeys) {
      if (this.matchKeys(bufferState, key, entry)) secondaryScore++;
    }

    if (entry.keys.length === 0) return 0;

    if (entry.secondaryKeys.length > 0) {
      if (entry.selectiveLogic === AND_ANY) return primaryScore + secondaryScore;
      if (entry.selectiveLogic === AND_ALL) {
        return secondaryScore === entry.secondaryKeys.length
          ? primaryScore + secondaryScore
          : primaryScore;
      }
    }

    return primaryScore;
  }

  addRecurse(message: string): void {
    this.#recurseBuffer.push(message);
  }

  addInject(message: string): void {
    this.#injectBuffer.push(message);
  }

  hasRecurse(): boolean {
    return this.#recurseBuffer.length > 0;
  }

  advanceScan(): void {
    this.#skew++;
  }

  getDepth(): number {
    return this.#settings.scanDepth + this.#skew;
  }
}
