/**
 * 世界书引擎类型（M3 契约 §1.1）。
 *
 * 行为参照 SillyTavern 1.18 `public/scripts/world-info.js`
 * （`checkWorldInfo` / `WorldInfoBuffer` / `WorldInfoTimedEffects` / `getSortedEntries` /
 * `filterByInclusionGroups` / `parseDecorators`）。与 ST 的已知偏差集中记在 `engine.ts` 顶部注释。
 */

/** ST world_info_position：0 角色定义前、1 角色定义后、2/3 作者注释上下、4 @depth、5/6 示例对话前后、7 出口 */
export type WIPosition = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** ST world_info_logic：0 AND_ANY、1 NOT_ALL、2 NOT_ANY、3 AND_ALL */
export type WILogic = 0 | 1 | 2 | 3;
/** ST extension_prompt_roles：0 system、1 user、2 assistant */
export type WIRole = 0 | 1 | 2;

/** 世界书作用域；决定 `getSortedEntries` 的排序分组 */
export type WIScope = 'global' | 'char' | 'chat' | 'persona';

/** ST world_info_insertion_strategy：0 evenly、1 character_first（ST 默认）、2 global_first */
export type WICharacterStrategy = 0 | 1 | 2;

/** ST characterFilter：按角色名/标签白名单或黑名单过滤条目 */
export interface WICharacterFilter {
  isExclude: boolean;
  names: string[];
  tags: string[];
}

export interface WIEntry {
  /** 稳定 id（DB id 或 `${bookId}:${uid}`），时间态与激活结果都用它 */
  id: string;
  bookId: string;
  uid?: number;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  comment?: string;
  constant: boolean;
  selective: boolean;
  selectiveLogic: WILogic;
  position: WIPosition;
  depth?: number;
  order: number;
  probability?: number; // 0–100；undefined 视为 100
  useProbability?: boolean;
  group?: string; // 逗号分隔多组，与 ST 一致
  groupOverride?: boolean;
  groupWeight?: number;
  scanDepth?: number | null;
  caseSensitive?: boolean | null;
  matchWholeWords?: boolean | null;
  useGroupScoring?: boolean | null;
  automationId?: string;
  role?: WIRole | null;
  disabled: boolean;
  sticky?: number | null;
  cooldown?: number | null;
  delay?: number | null;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
  /** boolean 或递归层级数（ST 1.12.4+ 允许数字） */
  delayUntilRecursion?: boolean | number;
  ignoreBudget?: boolean;
  /** ST 1.18 的 checkWorldInfo 不读此字段（向量条目由向量扩展外部激活），引擎仅透传供检查器展示 */
  vectorized?: boolean;
  matchPersonaDescription?: boolean;
  matchCharacterDescription?: boolean;
  matchCharacterPersonality?: boolean;
  matchCharacterDepthPrompt?: boolean;
  matchScenario?: boolean;
  matchCreatorNotes?: boolean;
  outletName?: string;
  /** ST 生成类型触发过滤（entry.triggers ∌ 当前 trigger 则跳过）；空/缺省 = 不过滤 */
  triggers?: string[];
  /** ST 角色/标签过滤 */
  characterFilter?: WICharacterFilter;
  /** CCv3 装饰器归一化结果（已并入以上字段后仍保留原样，便于检查器展示） */
  decorators?: Record<string, unknown>;
  /** 触发它的书名/作用域，供检查器展示 */
  source?: { bookName: string; scope: WIScope };
}

export interface WIBook {
  id: string;
  name: string;
  scope: WIScope;
  entries: WIEntry[];
}

export interface WISettings {
  scanDepth: number; // ST world_info_depth，默认 2
  budgetTokens: number; // 已换算为 token 的预算（ST 是 % × 上下文，换算在服务端做）
  budgetCap: number; // 0 = 无上限
  recursive: boolean; // world_info_recursive
  caseSensitive: boolean;
  matchWholeWords: boolean;
  useGroupScoring: boolean;
  maxRecursionSteps: number; // 0 = 不限
  minActivations: number; // 0 = 关
  minActivationsDepthMax: number;
  includeNames: boolean; // 扫描缓冲带 `名字: ` 前缀
  overflowAlert?: boolean;
  /** ST world_info_character_strategy；缺省 1（character_first，与 ST 默认一致） */
  characterStrategy?: WICharacterStrategy;
}

/**
 * 按消息节点保存的时间态：key 为 entry.id；值为「剩余消息数」。
 *
 * `messageCount` 是写入该快照时的可见历史条数，用于下一轮推导「过去了几条消息」
 * （ST 存的是绝对的 start/end 消息下标，见 engine.ts 顶部「时间态换算」）。
 */
export interface WITimedState {
  sticky: Record<string, number>;
  cooldown: Record<string, number>;
  messageCount?: number;
}

export interface WIScanMessage {
  role: 'user' | 'assistant' | 'system';
  name?: string;
  text: string;
}

/** 扩展扫描源（按条目的 match* 开关取用） */
export interface WIGlobalScanData {
  personaDescription?: string;
  characterDescription?: string;
  characterPersonality?: string;
  characterDepthPrompt?: string;
  scenario?: string;
  creatorNotes?: string;
}

export interface WIScanInput {
  books: WIBook[];
  settings: WISettings;
  /** root→parent 的可见历史（**已做提示词侧正则与宏替换**），最后一条是本轮用户输入 */
  history: WIScanMessage[];
  globalScan: WIGlobalScanData;
  /** 父节点快照；null = 全新 */
  state: WITimedState | null;
  /** 用于 delay / 时间态推进的消息计数（= 可见历史条数） */
  messageCount: number;
  /** 宏替换函数（引擎不知道宏上下文；keys/content 都要过它，与 ST substituteParams 一致） */
  substitute: (text: string) => string;
  /** 确定性随机（probability / 组权重）；返回 [0,1) */
  random: () => number;
  countTokens: (text: string) => number;
  /** 检查器预览：不推进 sticky/cooldown 到 newState */
  dryRun?: boolean;
  /** ST 生成类型（normal / continue / impersonate / swipe / regenerate / quiet）；缺省 'normal' */
  trigger?: string;
  /** entry.characterFilter 判定用 */
  characterName?: string;
  characterTags?: string[];
  /** 提示词注入（ST extensionPrompts 里 scan=true 的注入）也进扫描缓冲 */
  injects?: string[];
}

export type WIActivationReason = 'constant' | 'key' | 'sticky' | 'recursion' | 'minActivations';

export interface WIActivation {
  entry: WIEntry;
  reason: WIActivationReason;
  matchedKeys: string[];
  recursionLevel: number;
  groupWinner?: boolean;
  /** 展开后的内容（宏已替换） */
  content: string;
  tokens: number;
}

export interface WIDepthBucket {
  depth: number;
  role: WIRole;
  entries: WIActivation[];
}

export interface WIScanBuckets {
  before: WIActivation[]; // position 0
  after: WIActivation[]; // 1
  anTop: WIActivation[]; // 2
  anBottom: WIActivation[]; // 3
  emBefore: WIActivation[]; // 5
  emAfter: WIActivation[]; // 6
  depth: WIDepthBucket[]; // 4，按 (depth, role) 分桶
  outlets: Record<string, WIActivation[]>; // 7
}

export type WIRejectReason =
  | 'disabled'
  | 'trigger'
  | 'character-filter'
  | 'delay'
  | 'cooldown'
  | 'delay-until-recursion'
  | 'exclude-recursion'
  | 'dont-activate'
  | 'probability'
  | 'budget'
  | 'group-lost'
  | 'empty-content';

export interface WIScanResult {
  /** 最终激活集合（已过预算、组、概率），按 order 降序 = ST 构建提示词时的遍历顺序 */
  activations: WIActivation[];
  buckets: WIScanBuckets;
  /** 写入新节点；dryRun 时等于输入 state */
  newState: WITimedState;
  budgetUsed: number;
  overflowed: boolean;
  /** 被拒绝的条目与原因（检查器用） */
  rejected: { entryId: string; reason: WIRejectReason }[];
  warnings: string[];
}
