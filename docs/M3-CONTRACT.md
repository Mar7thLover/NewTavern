# M3 契约：组装流水线与缓存

M3 目标（`docs/PLAN.md` §四）：宏 / 正则 / 世界书引擎、prompt_order 全量语义、作者注释、全局系统提示词；strict + cache-aware 布局；提示词检查器与 diff；黄金测试；基础美化。
验收：fixture 的 strict 输出与 ST 1.18 实际请求逐字节一致（目标 30 组）；20 轮会话 cache-aware 命中率 ≥ 70%；导入 10 张主流卡 + 5 个主流预设正常对话。

本文是各子系统的接口契约。并行开发时以本文为准；发现缺陷**在本文修改并注明**（附代号与日期），不要私改。ST 源码 `D:\Projects\SillyTavern`（1.18.0）是行为的**权威参考**：契约与 ST 冲突时按 ST 实现并把修正写进 §9。

版本：2026-09-14 v1

## 0. 范围与分工

| 代号 | 范围                                                                                                                 | 目录                                                         | 阶段 |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---- |
| WI   | 世界书激活引擎（ST 算法移植 + CCv3 装饰器 + 按节点快照的时间态）                                                     | `packages/core/src/worldinfo/**`                             | A    |
| RX   | 正则引擎、宏引擎 v2、变量事务                                                                                        | `packages/core/src/{regex,macros,variables}/**`              | A    |
| FX   | 公开可分发的合成 fixture + 驱动本机 ST 1.18 录制真实请求快照的工具                                                   | `tools/fixtures/**`、`tools/golden/**`（仅 harness 部分）    | A    |
| SA   | 服务端地基：卡内嵌世界书抽表、正则脚本 CRUD/导入、聊天世界书绑定、WI/全局系统提示词/作者注释存储、节点快照字段       | `apps/server/**`（不含 generate 的组装切换）                 | A    |
| AS   | 组装流水线 v2（Collect→Normalize→History→Macros→WI→Regex→Placement→Layout→IR）+ strict / cache-aware 布局 + 黄金测试 | `packages/core/src/prompt/**`、`tools/golden/**`（测试部分） | B    |
| SB   | 服务端接入组装 v2（generate / inspect / 变量与 WI 快照提交）                                                         | `apps/server/**`                                             | B    |
| WEB  | 提示词检查器、作者注释、聊天世界书绑定、WI 设置、全局系统提示词、正则管理、显示侧正则、布局模式、基础美化            | `apps/web/**`、`packages/i18n/**`                            | B    |

通用约定沿用 `docs/M2-CONTRACT.md` §0（错误形状、ISO 时间、i18n 只有 WEB 改、各改各目录、需他人配合写进 §9「待协调」）。`packages/core` 仍然**不能**依赖 DOM / Node / 其他 workspace 包（测试文件例外：可 devDependency `@newtavern/compat`）。

## 1. 世界书引擎 `packages/core/src/worldinfo`（WI）

移植 ST `public/scripts/world-info.js` 的 `checkWorldInfo` / `WorldInfoBuffer` / `WorldInfoTimedEffects` / 组评分 / 递归 / 预算，行为以源码为准。

### 1.1 类型（`types.ts`）

```ts
export type WIPosition = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; // before, after, ANTop, ANBottom, atDepth, EMTop, EMBottom, outlet
export type WILogic = 0 | 1 | 2 | 3; // AND_ANY, NOT_ALL, NOT_ANY, AND_ALL
export type WIRole = 0 | 1 | 2; // system, user, assistant（ST extension_prompt_roles）

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
  vectorized?: boolean; // vectorized 条目在本引擎里恒不激活（M3 无向量）
  matchPersonaDescription?: boolean;
  matchCharacterDescription?: boolean;
  matchCharacterPersonality?: boolean;
  matchCharacterDepthPrompt?: boolean;
  matchScenario?: boolean;
  matchCreatorNotes?: boolean;
  outletName?: string;
  /** CCv3 装饰器归一化结果（已并入以上字段后仍保留原样，便于检查器展示） */
  decorators?: Record<string, unknown>;
  /** 触发它的书名/作用域，供检查器展示 */
  source?: { bookName: string; scope: 'global' | 'char' | 'chat' | 'persona' };
}

export interface WIBook {
  id: string;
  name: string;
  scope: 'global' | 'char' | 'chat' | 'persona';
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
}

/** 按消息节点保存的时间态：key 为 entry.id；值为「剩余消息数」 */
export interface WITimedState {
  sticky: Record<string, number>;
  cooldown: Record<string, number>;
}

export interface WIScanMessage {
  role: 'user' | 'assistant' | 'system';
  name?: string;
  text: string;
}

export interface WIScanInput {
  books: WIBook[];
  settings: WISettings;
  /** root→parent 的可见历史（**已做提示词侧正则与宏替换**，见 §4 流水线顺序），最后一条是本轮用户输入 */
  history: WIScanMessage[];
  /** 扩展扫描源（按条目的 match* 开关取用） */
  globalScan: {
    personaDescription?: string;
    characterDescription?: string;
    characterPersonality?: string;
    characterDepthPrompt?: string;
    scenario?: string;
    creatorNotes?: string;
  };
  /** 父节点快照；null = 全新 */
  state: WITimedState | null;
  /** 用于 delay 判定的消息计数（可见历史条数） */
  messageCount: number;
  /** 宏替换函数（引擎不知道宏上下文；keys/content 都要过它，与 ST substituteParams 一致） */
  substitute: (text: string) => string;
  /** 确定性随机（probability）；返回 [0,1) */
  random: () => number;
  countTokens: (text: string) => number;
  dryRun?: boolean; // 检查器预览：不消耗 sticky/cooldown（ST isDryRun 语义）
}

export interface WIActivation {
  entry: WIEntry;
  reason: 'constant' | 'key' | 'sticky' | 'recursion' | 'minActivations';
  matchedKeys: string[];
  recursionLevel: number;
  groupWinner?: boolean;
  /** 展开后的内容（宏已替换，且 ST 会 trim） */
  content: string;
  tokens: number;
}

export interface WIScanResult {
  activations: WIActivation[]; // 最终激活集合（已过预算、组、概率）
  buckets: {
    before: WIActivation[]; // position 0，按 order 排序后的顺序
    after: WIActivation[]; // 1
    anTop: WIActivation[]; // 2
    anBottom: WIActivation[]; // 3
    emBefore: WIActivation[]; // 5
    emAfter: WIActivation[]; // 6
    depth: { depth: number; role: WIRole; entries: WIActivation[] }[]; // 4，按 (depth, role) 分桶
    outlets: Record<string, WIActivation[]>; // 7
  };
  newState: WITimedState; // 写入新节点；dryRun 时等于输入 state
  budgetUsed: number;
  overflowed: boolean;
  /** 被拒绝的条目与原因（检查器用）：probability / budget / group-lost / cooldown / delay / disabled / vectorized */
  rejected: { entryId: string; reason: string }[];
  warnings: string[];
}
```

### 1.2 API（`engine.ts`）

```ts
export function scanWorldInfo(input: WIScanInput): WIScanResult;
/** 把 ST/CCv3 装饰器（@@depth @@position @@role @@activate_only_after @@activate_only_every @@keep_activate_after_match @@dont_activate_after_match @@scan_depth @@additional_keys @@exclude_keys @@is_greeting @@ignore_on_max_context @@constant @@disable …）从 content 头部解析出来并覆写字段；返回新 entry 与剩余 content */
export function applyDecorators(entry: WIEntry): WIEntry;
/** ST 的排序：order 降序? —— 以源码 `sortEntries` / `world_info_character_strategy` 为准；导出供 Placement 使用 */
export function sortActivations(list: WIActivation[]): WIActivation[];
```

行为要点（均以 ST 源码为准，此处只提醒易漏项）：

- 扫描缓冲：取最近 `scanDepth` 条历史（ST 用 `#` 连接、`includeNames` 时加 `name: `），每条条目可用 `scanDepth` 覆盖；递归时追加已激活内容到缓冲（`WorldInfoBuffer.addRecurse`）。`globalScan` 各源按条目开关追加。
- 键匹配：`caseSensitive` / `matchWholeWords` 条目优先于全局；`/regex/flags` 形式的键按正则匹配；否则子串（whole words 时用 ST 的 `matchWholeWords` 边界逻辑，含 CJK 的特殊处理）。
- `selective` 时二级键按 `selectiveLogic`；二级键为空则忽略 selective。
- `constant` 直接激活（仍受 disabled / delay / cooldown / 预算约束）；`vectorized` 永不激活。
- 概率：`useProbability && probability < 100` 时用 `random()`；sticky 中的条目跳过概率检查。
- 组：同组只保留一个——`groupOverride`（prioritize）优先，否则 `useGroupScoring` 时按匹配键数评分，最高者胜（同分按权重随机），否则按 `groupWeight` 加权随机。
- 时间态：sticky 激活后 N 条内持续激活；cooldown 在 sticky 结束（或激活）后 N 条内禁止激活；delay 要求 `messageCount >= delay`。状态**只按输入 state + 本次结果推导**，不读全局；`dryRun` 不推进。
- 递归：`recursive` 开启时，激活条目的 content 进入缓冲再扫；`excludeRecursion` 的条目不会被递归激活；`preventRecursion` 的条目内容不进缓冲；`delayUntilRecursion` 的条目只在递归层级 ≥ 指定值时才可激活；`maxRecursionSteps` 限制轮数；`minActivations` 在无激活时逐步加深扫描（`minActivationsDepthMax`）。
- 预算：按 `countTokens(content)` 累加，超出 `budgetTokens`（再受 `budgetCap`）时停止加入（`ignoreBudget` 例外），`overflowed=true`。
- 输出内容 `content` 已 `substitute()` 且 trim；`buckets.*` 内顺序 = ST 最终插入顺序。

### 1.3 测试

`engine.test.ts`：每个行为要点至少一例，外加：递归收敛、组评分、sticky→cooldown 状态机跨三轮、delay、dryRun 不推进、预算溢出、装饰器覆写、正则键、CJK whole-word、includeNames。用 `random: () => 0.5` 之类的固定函数保证确定性。

## 2. 正则、宏 v2、变量 `packages/core/src/{regex,macros,variables}`（RX）

### 2.1 正则引擎 `regex/engine.ts`

```ts
export interface RegexScript {
  id: string;
  name: string;
  findRegex: string; // `/pattern/flags` 或裸 pattern（ST regexFromString 语义）
  replaceString: string; // 支持 {{match}}、$1…$n、宏
  trimStrings: string[];
  placement: number[]; // 1 USER_INPUT, 2 AI_OUTPUT, 3 SLASH_COMMAND, 5 WORLD_INFO, 6 REASONING
  disabled: boolean;
  markdownOnly: boolean; // 仅显示
  promptOnly: boolean; // 仅提示词
  runOnEdit: boolean;
  substituteRegex: 0 | 1 | 2; // NONE / RAW / ESCAPED
  minDepth?: number | null;
  maxDepth?: number | null;
  scope: 'global' | 'character';
}
export interface RegexRunContext {
  placement: number;
  /** 'prompt' = 组装侧（isPrompt），'display' = 渲染侧（isMarkdown） */
  direction: 'prompt' | 'display';
  depth?: number; // 历史消息深度（0 = 最新）
  isEdit?: boolean;
  substitute: (text: string) => string; // 宏替换（find 与 replace 都可能需要）
}
export function runRegexScript(script: RegexScript, text: string, ctx: RegexRunContext): string;
export function applyRegexScripts(
  scripts: RegexScript[],
  text: string,
  ctx: RegexRunContext,
): string;
export function regexFromString(input: string): RegExp | null; // ST utils.regexFromString 语义
```

过滤规则照 ST `getRegexedString`：`(markdownOnly && display) || (promptOnly && prompt) || (!markdownOnly && !promptOnly && !display)`；`isEdit && !runOnEdit` 跳过；min/maxDepth 只在给了 depth 时生效；`{{match}}` → `$0`；trimStrings 对每个捕获组生效；`substituteRegex` 1/2 时 find 里的宏先替换（ESCAPED 转义正则元字符，见 `sanitizeRegexMacro`）。

### 2.2 宏引擎 v2 `macros/engine.ts`

在 M2 的 `substituteMacros / substituteMacrosDetailed` 基础上扩展，签名不变，`MacroContext` 增字段（全部可选）：

```ts
interface MacroContext {
  // M2 已有：char user persona description personality scenario mesExamples original now
  model?: string;
  group?: string;
  charVersion?: string;
  charPrompt?: string;
  charJailbreak?: string;
  input?: string;
  history?: {
    role: 'user' | 'assistant' | 'system';
    name?: string;
    text: string;
    id: number;
    swipeId?: number;
    swipeCount?: number;
  }[]; // 供 lastMessage / lastUserMessage / lastCharMessage / lastMessageId / currentSwipeId / lastSwipeId
  firstIncludedMessageId?: number;
  idleDurationMs?: number;
  variables?: VariableStore; // getvar/setvar/addvar/incvar/decvar 与 *global* 变体
  rng?: () => number; // random / roll
  pickSeed?: string; // pick 的会话稳定种子（chatId + 段 id）
  outlets?: Record<string, string>; // {{outlet::name}}
  timezoneOffsetMinutes?: number; // time_UTC±X
}
```

M3 必须支持：M2 集合 + `{{lastMessage}} {{lastMessageId}} {{lastUserMessage}} {{lastCharMessage}} {{firstIncludedMessageId}} {{currentSwipeId}} {{lastSwipeId}} {{model}} {{group}} {{charVersion}} {{charPrompt}} {{charJailbreak}} {{input}} {{weekday}} {{isotime}} {{isodate}} {{time_UTC±X}} {{idle_duration}} {{datetimeformat X}} {{random:a,b}} {{random::a::b}} {{pick:...}} {{roll:XdY}} {{roll:N}} {{getvar::k}} {{setvar::k::v}} {{addvar::k::v}} {{incvar::k}} {{decvar::k}} {{getglobalvar::k}} {{setglobalvar::k::v}} {{addglobalvar::k::v}} {{incglobalvar::k}} {{decglobalvar::k}} {{outlet::name}} {{reverse:...}} {{banned "..."}}`（banned 直接删除）`{{timeDiff::a::b}}`。求值顺序与 ST `macros.js` 一致（变量宏先于其他；`{{original}}` 只展开一次）。`volatile` 标记：time/date/weekday/iso*/idle_duration/random/roll/lastMessage*/datetimeformat/time_UTC。`{{pick}}` 用 `pickSeed` 做稳定哈希，不算 volatile。未知宏原样保留。`datetimeformat` 用自写的 moment 子集（`YYYY MM DD HH mm ss A dddd MMMM Do`）。

### 2.3 变量事务 `variables/transaction.ts`

```ts
export interface VariableStore {
  get(scope: 'chat' | 'global', key: string): unknown;
  set(scope, key, value: unknown): void;
  snapshot(scope): Record<string, unknown>;
}
export class VariableTransaction implements VariableStore {
  constructor(base: { chat: Record<string, unknown>; global: Record<string, unknown> });
  readonly events: {
    scope: 'chat' | 'global';
    op: 'set' | 'delete';
    key: string;
    oldValue: unknown;
    newValue: unknown;
  }[];
  commit(): { chat: Record<string, unknown>; globalChanges: Record<string, unknown> }; // chat 是完整新快照；global 只给变更键
  rollback(): void;
}
```

ST 变量值都是字符串（数字也存字符串）；`addvar` 数值相加、非数值字符串拼接；`incvar/decvar` ±1。以 `public/scripts/variables.js` 为准。

### 2.4 测试

正则：placement 过滤、direction 过滤、depth 边界、`{{match}}`、捕获组 trim、substituteRegex 三种、runOnEdit、无效正则不抛（返回原文 + 可选 warning 回调）。宏：每个新宏一例 + 变量宏的副作用进事务 + pick 稳定 + volatile 标记。变量：commit/rollback、events 顺序、字符串数值语义。

## 3. 服务端地基（SA）

### 3.1 卡内嵌世界书抽表（M1 遗留）

- 导入角色时，若 `data.character_book` 存在：创建 `lorebooks`（scope `char`，name = book.name ?? `${角色名}的世界书`），条目按 `worldbook.ts` 的映射写入 `lorebook_entries`（`extra.raw` 保留原条目），`characters.book_id` 指向它。**`characters.data.character_book` 保持原样不删**（导出无修改卡时仍走原始字节）。
- 编辑过的角色导出：以 `lorebooks` 表重建 `character_book`（raw 叠加变动列），写回 `data.character_book`。
- 启动时回填：`services/backfill.ts` 对 `book_id IS NULL` 且 `data.character_book.entries` 非空的角色执行抽表（幂等，记日志一行）。

### 3.2 正则脚本

- `GET /api/regex` → `RegexScriptRow[]`（全局）；`POST /api/regex`（单条创建）；`PUT /api/regex/:id`；`DELETE /api/regex/:id`；`POST /api/import/regex`（multipart，ST 单脚本 JSON 或数组；用 compat `regex.ts` 解析；返回创建的行）；`PUT /api/regex/order` body `{ ids: string[] }` 重排 `display_order`。
- 角色级脚本来自 `characters.data.extensions.regex_scripts`，不落 `regex_scripts` 表；`GET /api/characters/:id/regex` 把它们解析为同一形状（`scope:'character'`，`id = \`${charId}:${index}\``）供前端与组装使用。
- 服务端对外形状与 §2.1 `RegexScript` 一致（`id/name/findRegex/replaceString/trimStrings/placement/disabled/markdownOnly/promptOnly/runOnEdit/substituteRegex/minDepth/maxDepth/scope`），DB 列的 `direction` 字段映射：`prompt`→`promptOnly`、`display`→`markdownOnly`、`both`→两者 false。

### 3.3 聊天世界书绑定与全局选择

- `PUT /api/chats/:id/lorebooks` body `{ bookIds: string[] }`（全量替换 `chat_lorebooks`）；`ChatDetail` 与 `ChatSummary` 增 `lorebookIds: string[]`。
- 设置 KV：`worldInfo.globalBookIds: string[]`、`worldInfo.settings: WISettings 的 UI 形态`（`budgetPercent` 而非 token：`{ scanDepth, budgetPercent, budgetCap, recursive, caseSensitive, matchWholeWords, useGroupScoring, maxRecursionSteps, minActivations, minActivationsDepthMax, includeNames }`，默认值照 ST：2 / 25 / 0 / true / false / false / false / 0 / 0 / 0 / false）。服务端 `services/wi-settings.ts` 提供读取 + 默认值合并 + `budgetTokens = floor(maxContext * budgetPercent / 100)`。

### 3.4 作者注释与全局系统提示词

- 作者注释存 `chats.metadata.authorsNote = { text: string; position: 0 | 1 | 2 /* IN_PROMPT, IN_CHAT, BEFORE_PROMPT */; depth: number; role: 0 | 1 | 2; interval: number /* 每 N 条插一次，1 = 每次 */ }`；`PATCH /api/chats/:id` 接受 `metadata.authorsNote`。角色默认作者注释（ST `extensions.depth_prompt` 是另一个东西：`{ prompt, depth, role }` = 「角色深度提示」，作为独立注入处理，见 §4）。
- 全局系统提示词存设置 KV `globalSystemPrompt = { enabled: boolean; text: string; position: 'before_main' | 'after_main' }`；`chats.overrides.globalSystemPrompt?: { enabled?: boolean; text?: string; position?: ... }` 可按会话覆盖。

### 3.5 节点快照字段

`message_nodes.wi_state`（已有列）存 `WITimedState`；`message_nodes.variables` 存 chat 作用域完整快照；全局变量走 `variables` 表（scope `global`，ownerId `''`）+ `variable_events`。SA 提供 `services/variables.ts`：`readGlobalVariables()`、`applyGlobalChanges(changes, nodeId)`。

### 3.6 inspect 端点骨架

`GET /api/chats/:id/inspect?parentId&connectionId&model&layoutMode` → SA 先实现路由与参数解析、连接/模型解析、`404/400` 分支，返回 `{ todo: true }`；SB 接入组装 v2 后填充（形状见 §6）。

### 3.7 测试

`app.test.ts` / 新文件：抽表幂等与导出重建 deep-equal；正则 CRUD 与导入；聊天世界书绑定；设置默认值合并；作者注释 PATCH 校验。

## 4. 组装流水线 v2 `packages/core/src/prompt`（AS）

`assemblePrompt(input)` 升级为 v2，**签名改为返回 `AssembleResult`**（M2 的调用方只有服务端，由 SB 同步改）。

```ts
export interface AssembleInputV2 extends AssembleInput /* M2 字段保留 */ {
  lorebooks: WIBook[]; // 已合并：全局 + 角色（char）+ 聊天（chat）+ persona（预留）
  wiSettings: WISettings;
  wiState: WITimedState | null;
  authorsNote: { text; position: 0 | 1 | 2; depth; role: 0 | 1 | 2; interval } | null;
  characterDepthPrompt: { text; depth; role: 0 | 1 | 2 } | null; // 卡 extensions.depth_prompt
  globalSystemPrompt: { text; position: 'before_main' | 'after_main' } | null; // 已按 enabled 过滤
  regexScripts: RegexScript[]; // 全局（按 display_order）+ 角色（按数组序），已过滤 disabled
  variables: { chat: Record<string, unknown>; global: Record<string, unknown> };
  messageCount: number; // 可见历史条数（AN interval / WI delay）
  providerCaps: {
    caching: 'none' | 'prefix-auto' | 'breakpoints' | 'explicit-object';
    cacheMinTokens?: number;
    maxBreakpoints?: number;
    systemInMessages: boolean;
    prefill: boolean;
  };
  layoutPolicy?: LayoutPolicy; // 见 §5
  rng: { seed: string }; // 派生确定性 random（xorshift/mulberry32）；pickSeed = seed
  now?: Date;
  idleDurationMs?: number;
  dryRun?: boolean; // 检查器：不推进 WI 时间态、不产生变量副作用（事务照算但不返回）
}
export interface AssembleResult {
  ir: PromptIR;
  wiState: WITimedState;
  variables: {
    chat: Record<string, unknown>;
    globalChanges: Record<string, unknown>;
    events: VariableTransaction['events'];
  };
  wi: WIScanResult;
  layout: LayoutReport; // 见 §5
  /** strict 参照（layoutMode 为 cache-aware 时才有，供 diff） */
  strictIr?: PromptIR;
}
```

### 4.1 阶段与顺序（与 ST 一致的地方以 ST 为准）

1. **Collect**：同 M2 + 新输入。
2. **Normalize**：`applyDecorators` 处理所有条目；卡内 `character_book` 已由服务端抽成 `scope:'char'` 的书。
3. **History**：root→parent 可见历史 → 按 depth（0 = 最新）对每条应用**提示词侧**正则（placement 1 用户 / 2 AI，`direction:'prompt'`）→ 得到扫描与组装共用的历史文本。
4. **Macros**：对预设 prompt、卡字段、AN、GSP、WI keys/content（经 `substitute` 回调）、历史（ST 也替换）做宏替换；变量宏走 `VariableTransaction`；`volatile` 标记落到段。
5. **World Info**：`scanWorldInfo`（history = 第 3 步结果，globalScan 取卡/persona 字段）。结果分桶。WI 内容再过 placement 5 的提示词侧正则（ST 顺序：WI 内容先正则再插入）。
6. **Placement**：在 M2 展开规则之上：
   - `worldInfoBefore` / `worldInfoAfter` 标记 → `buckets.before/after` 各合成**一段**（ST 用 `\n` 连接后作为单条 system；`wi_format`（默认 `{0}`）包裹）。
   - 作者注释：`interval` 判定（`messageCount % interval === 0`，interval ≤ 1 恒真）；`position 2 BEFORE_PROMPT` → 放在 system 槽最前（ST `insertAtStart`）；`0 IN_PROMPT` → system 槽最后（ST 在 `main…` 之后、`chatHistory` 之前——以 `populateChatCompletion` 里 `authorsNote` 的实际落点为准）；`1 IN_CHAT` → 深度注入 `(depth, role)`。`anTop/anBottom` 桶的内容与 AN 文本以 `\n` 拼成一段（ST 把它们塞进同一个 extension prompt）；AN 为空但桶非空时仍产生段。
   - WI `depth` 桶 → 深度注入，同 (depth, role) 的条目合并为一段（ST 行为，`\n` 连接）；与预设 `injection_position=1`、AN in-chat、`characterDepthPrompt` 一起按 M2 §2.5-3 的排序规则落位。
   - `emBefore/emAfter` → 作为示例块插到 `dialogueExamples` 前/后（ST `populateDialogueExamples` 里 WI 示例的格式），每块一段。
   - `outlets`：`{{outlet::name}}` 宏由 Macros 阶段读取（**因此 WI 扫描要先于含 outlet 宏的文本最终替换**：实现上对含 `{{outlet` 的文本做二次替换）。
   - 全局系统提示词：`before_main` → 紧贴 `main` 段之前；`after_main` → 之后；`origin.kind='global_system'`，`stability='static'`。无 `main` 时放 system 槽最前。
   - `personaDescription` 位置：M3 仍只支持 marker 位置（ST 的 persona position 选项留 M4）。
   - 每段填 `anchor`（strict 依据）、`stability`（WI 触发式条目 = `turn`，constant 条目 = `static`（全局/角色书）或 `session`（聊天书）；AN = `session`；GSP/预设/卡 = `static`；历史 = `history`；深度注入 = `turn`）、`volatile`、`locked`（来自 `layoutPolicy.lockedSegmentIds` 或预设 prompt 的 `extensions.newtavern.locked`）。
7. **Layout**：§5。
8. **IR**：`meta.activations` 填 WI 激活摘要；`meta.warnings` 汇总；`tokenEstimate`。

### 4.2 黄金测试 `tools/golden`

新 workspace 包 `tools/golden`（`@newtavern/golden`，private，devDependencies：core / compat / providers / vitest）。`src/golden.test.ts` 遍历 `tools/fixtures/st-requests/cases.json`：用 compat 解析 fixture 文件 → 构造 `AssembleInputV2`（`layoutMode:'strict'`，`rng.seed` 固定，`now` 固定为用例记录的时间，WI 设置取用例）→ `assemblePrompt` → `openaiChatAdapter.buildRequest` → 断言 `body.messages` 与快照 `request.messages` **deep-equal**（顺序、role、content、name），并断言映射了的采样参数相等。每个用例独立 `it`，失败时输出首个不一致下标与两侧文本 diff（自写简短 diff）。用例元数据允许 `knownDeviations: string[]`（明确列出且经协调者批准才可标 `it.skip`）。

## 5. 布局 `packages/core/src/prompt/layout`（AS）

```ts
export interface LayoutPolicy {
  tailWindow: number;                    // k，默认 4
  lockedSegmentIds?: string[];
  volatileHandling: 'freeze' | 'warn';   // static 段含易变宏时：freeze = 本会话冻结为首次值（由服务端传入冻结表），warn = 只告警
  frozenVolatile?: Record<string, string>; // segmentId → 冻结文本（服务端从 chat.metadata 取/存）
  wiCarrierRole: 'system' | 'user';      // 移入尾部的触发式 WI 的承载角色（systemInMessages=false 时强制 user，包裹 `[World Info]\n…`）
  ttl?: '5m' | '1h';
}
export interface LayoutMove { segmentId: string; kind: 'moved' | 'clamped' | 'frozen'; from: Segment['anchor']; to: Segment['anchor']; reason: string }
export interface LayoutReport { mode: 'strict' | 'cache-aware'; moves: LayoutMove[]; breakpoints: { index: number; segmentId: string; layer: 'static' | 'session' | 'history' | 'tools'; estTokens: number; belowMin?: boolean }[]; estimatedCacheablePrefixTokens: number; warnings: string[] }
export function layoutStrict(segments: Segment[], ctx: LayoutContext): { segments: Segment[]; cachePlan: PromptIR['cachePlan']; report: LayoutReport };
export function layoutCacheAware(segments: Segment[], ctx: LayoutContext): { ... };
export function diffLayouts(strict: PromptIR, cacheAware: PromptIR): { moved: string[]; clamped: string[]; unchanged: number };
```

规则（`docs/PLAN.md` §3.2 的落地）：

- **不变量**：只做跨层移动，不改层内相对顺序，以 segment 为粒度；`locked` 段绝不动。
- **strict**：段序原样；断点：static 层末尾 1 个；`caching==='breakpoints'` 时再在「最后一条未受深度注入影响的历史段」加 1 个（若存在且 ≥2 条历史）。
- **cache-aware**：
  1. 触发式 WI（`origin.kind='worldinfo'` 且 `stability='turn'`）若落在 static 区（position 0/1/5/6 产生的段），移入尾部：以 `depth = k` 作为深度注入，role 按 `wiCarrierRole`；多个合并为一段（`\n\n` 连接，保持原顺序），`kind:'moved'`。
  2. 深度注入（`anchor.slot='history'` 且 `depth > k`）夹紧到 `k`（`kind:'clamped'`），`locked` 例外。
  3. static 段含 `volatile`：`freeze` 模式用 `frozenVolatile[segmentId]` 替换文本（无则记录本次文本到 report 供服务端存）；`warn` 模式只告警。
  4. session 层（聊天书 constant、AN、sticky）放在 static 层之后、历史之前（若它们原本就在那里则无 move）。
  5. 断点：`breakpoints` 模式 → BP1 = static 末尾，BP2 = session 末尾，BP3 = 最后一条历史（尾部窗口之前的最后一条）；不超过 `maxBreakpoints`；估算段小于 `cacheMinTokens` 时标 `belowMin` 并告警。`prefix-auto` → 无显式断点，report 仍给出 `estimatedCacheablePrefixTokens`（static + session）。`none` → 空。
- `diffLayouts` 用 `Segment.id` 对齐。

### 5.1 测试

strict 不动任何段；cache-aware 各规则一例；locked 不动；断点数量与 `belowMin`；`diffLayouts` 输出；`estimatedCacheablePrefixTokens` 计算。

## 6. 服务端接入（SB）

- `generate`：构造 `AssembleInputV2`（书：`worldInfo.globalBookIds` + `characters.book_id` + `chat_lorebooks`；`wiSettings` 由 `wi-settings.ts` 用 `caps.maxContext` 换算；`wiState`/`variables.chat` 取父节点（无则 null/{}）；`variables.global` 读表；AN 取 `chat.metadata.authorsNote`；GSP 合并设置与 `chat.overrides`；regex = 全局表 + 角色；`providerCaps` 取 `adapter.capabilities`；`layoutPolicy.frozenVolatile` 取 `chat.metadata.frozenVolatile`；`rng.seed = chatId + ':' + parentId + ':' + siblingSeq`；`messageCount`）。生成成功后：新节点写 `wi_state`、`variables`；`applyGlobalChanges`；`frozenVolatile` 新增项写回 `chat.metadata`；`extra.layout = LayoutReport`；`extra.activations = ir.meta.activations`。
- `GET /api/chats/:id/inspect?parentId&connectionId&model&layoutMode` → `{ layoutMode, ir, request /* 去 headers */, strictIr, diff, layout: LayoutReport, wi: { activations, rejected, budgetUsed, overflowed }, warnings, tokenEstimate, lastUsage /* parentId 所在路径最近一条 assistant 的 usage */ }`（`dryRun: true`）。
- `POST /api/inspect/compare` body `{ chatId, parentId?, connectionId?, model?, stRequest: unknown }` → 把粘贴的 ST 请求体 `messages` 与本地 strict 输出逐条比对，返回 `{ same: boolean; firstDiffIndex; ours: {role, content}[]; theirs: ...; hints: string[] }`。
- `PATCH /api/chats/:id` 允许 `metadata.frozenVolatile` 清空（`null`）。

## 7. 前端（WEB）

### 7.1 提示词检查器 `features/inspector/`

- 入口：ChatView 顶栏「检查器」按钮，桌面在右侧面板与会话面板互斥切换（或替换为第三栏 tab：会话 / 检查器），移动端全屏 Drawer。
- 顶部：布局模式切换（strict / cache-aware，写 `overrides.layoutMode`）、模型徽标、token 估算、预计可缓存前缀比例、上一轮实际 cacheRead/cacheWrite。
- 段列表：每段一行卡片，左侧 4px 色条按 `origin.kind`（preset 琥珀、character 玫瑰、persona 青、worldinfo 绿、authors_note 紫、history 中性、injection 橙、user_input 蓝、global_system 金——用 token 变量定义，明暗各一套），右上 `stability` 徽标与 `volatile`/`locked` 图标，正文可折叠（默认折叠到 3 行），token 数；断点位置以一条带标签的分隔线表示（「缓存断点 · static · ~1,234 tok」，`belowMin` 时红色告警）。
- Diff 视图（cache-aware 时）：被移动/夹紧的段标「已移动 ← 原位置」「深度 12 → 4」，可点击跳到原位。
- 世界书面板：激活条目（书名 / 标题 / 触发键 / 原因）与被拒条目（原因）两组。
- 原始请求：只读 JSON 视图（高亮、可复制）。
- 「与 ST 请求比对」：文本框粘贴 JSON → `POST /api/inspect/compare` → 首个差异并排展示。
- 数据来自 `GET inspect`，在 head 变化 / 面板打开 / 布局切换时刷新；生成中不刷新。

### 7.2 会话面板与设置

- SessionPanel：作者注释编辑（文本、位置 3 选、深度、角色、间隔）、聊天世界书多选（`PUT lorebooks`）、全局系统提示词按会话覆盖开关。
- 设置页新增分区：世界书（全局书多选 + WISettings 表单）、全局系统提示词（开关 / 文本 / 位置）、正则脚本（导入 ST JSON、列表拖拽排序、启用/禁用、删除、查看 find/replace）。
- 显示侧正则：MessageItem 渲染前对文本应用 `direction:'display'` 的脚本（全局 + 当前角色，placement 按消息角色 1/2；depth = 距 head 距离）。核心引擎从 `@newtavern/core` 导入。
- 基础美化：明暗主题各自检一遍对话页/库页/设置页；空态与错误态统一；检查器配色进入 `tokens.css`。

## 8. Fixture 与录制工具（FX）

### 8.1 目录与格式

```
tools/fixtures/
  README.md                 # 已有，补充本节内容
  cards/*.json              # 合成卡（CCv3 JSON；需要 PNG 的用 compat 现场生成，不提交二进制）
  presets/*.json            # 合成 ST 预设
  worldbooks/*.json         # 合成 ST 世界书
  chats/*.jsonl             # 合成 ST 聊天
  personas/*.json           # { name, description }
  st-requests/cases.json    # 用例清单
  st-requests/<case-id>.json# { id, description, stVersion:'1.18.0', capturedAt, inputs:{ card, preset, worldbooks[], chat, persona, settings:{ worldInfo:{...ST 设置键}, authorsNote?:{...}, characterDepthPrompt? } , userMessage }, request: <ST 后端转发给端点的原始 body>, notes?: string[] }
```

**所有 fixture 必须是自创内容、CC0**，不得含任何第三方角色/预设文本；覆盖矩阵（至少 30 组）：预设 × {默认 / 含深度注入 / squash / 覆盖 system_prompt / forbid_overrides / 空 prompt / `new_chat_prompt` 非空 / `wi_format` 自定义}；世界书 × {position 0–6 各一 / constant / selective 四种逻辑 / 正则键 / 概率 100 / 组（prioritize、评分）/ sticky-cooldown 跨轮 / delay / 递归两层 / prevent_recursion / exclude_recursion / 预算溢出 / CJK whole word / includeNames}；作者注释 × {三个位置 / interval 2}；角色 depth_prompt；宏 × {char/user/description/scenario/mesExamples/random（用 seed 无法对齐——**用例里不放 random/roll/time 类宏**，另建单元测试）}；示例对话多块；历史含 system 消息与隐藏消息；正则 × {用户输入 / AI 输出 / min-max depth / WI}。

### 8.2 录制工具 `tools/golden/record/`

- `record.mjs`：① 启动 mock OpenAI 端点（可复用会话 scratchpad 里 `mock-openai.mjs` 的思路：记录每次 `/chat/completions` 的 body，返回固定短回复）；② 以独立 `--dataRoot`（scratch 目录，**绝不使用 `D:\Projects\SillyTavern\data`**）与独立端口启动 `node server.js`（在 ST 目录内运行但不修改其任何文件；`--listen false --browserLaunchEnabled false --whitelist false --disableCsrf true`，以 `node server.js --help` 实际输出为准）；③ 把用例 inputs 写入该 dataRoot（characters PNG 用 compat `writeCardToPng` 生成、`OpenAI Settings`、`worlds`、`chats/<角色名>/`、`settings.json` 里的 `world_info` 设置与 `oai_settings`（custom 源、`custom_url` = mock、模型名、选中预设）、persona）；④ 用 headless Chrome + CDP（参考 W 的 `shot.mjs` 思路，用 `Runtime.evaluate` 调 `SillyTavern.getContext()`：选角色、打开聊天、设 AN、发送 `userMessage` 触发 `Generate`）；⑤ 从 mock 取 body，写 `<case-id>.json`。
- 每个用例可重录；`cases.json` 记录用例列表与 `capturedAt`。工具只在本机开发用，CI 不跑；`tools/golden` 的 vitest 只读快照。
- 若某用例在 ST 里的行为依赖随机（probability < 100、组随机），fixture 设计上避开；组评分用确定性用例。
- 文档：`tools/fixtures/README.md` 写清录制步骤、前置条件（ST 路径由环境变量 `NT_ST_DIR` 指定，默认 `D:\Projects\SillyTavern`）、如何新增用例。

## 9. 待协调与修正

（格式：`- [代号→代号] 事项`；契约修正另起 `### 修正` 小节注明日期）

- [AS→SB] `assemblePrompt` 返回类型改为 `AssembleResult`，SB 同步改 `routes/chats.ts`；M2 的 `apps/server/src/services/assemble.ts` 是唯一切换点。
- [WI/RX→AS] 引擎导出名以本文 §1–2 为准；若实现时增删字段，先改本文再改代码。
- [FX→AS] 用例 inputs 的 settings 键名用 ST 原名（`world_info_depth` 等），AS 在黄金测试里映射到 `WISettings`。
- [SA→SB] `services/generation-context.ts` 是 generate / inspect 共用的前置解析，签名：
  `resolveGenerationContext(db, providers, { chatId, parentId?, connectionId?, model?, layoutMode? }) → Promise<GenerationContext>`，
  `GenerationContext = { chat, overrides, nodes, parentId, connectionId, model, resolved, layoutMode }`；
  失败抛 `GenerationContextError { status: 400 | 404; body }`，路由层 `c.json(e.body, e.status)`。
  `readGenerationDefault(db)` 也移到了这里（原在 `routes/chats.ts`）。
- [SA→SB] `WISettings` 暂在 `apps/server/src/services/wi-settings.ts` 本地声明（与 §1.1 同名同形）；
  WI 引擎并入 `@newtavern/core` 的 index 导出后，SB 把服务端改为从 core 导入并删掉本地声明。
- [SA→SB] `PATCH /api/chats/:id` 的 `metadata` 是**浅合并**：值为 `null` 的键被删除（`{"metadata":{"frozenVolatile":null}}` 即清空冻结表，满足 §6），`metadata: null` 清空整个对象。
- [SA→WEB/SB] `PUT /api/chats/:id/lorebooks` 返回完整 `ChatDetail`（不是 204）；`ChatSummary`/`ChatDetail` 已带 `lorebookIds: string[]`（插入顺序）。不存在的 bookId → 400。

### 修正（2026-09-14，SA）

- §3.1「编辑过的角色导出重建」：M1/M3 都还没有「编辑角色」路由，无从判断卡是否被编辑。
  落地规则退化为：抽表时把 `lorebooks.created_at`/`updated_at` 都置为**角色导入时间**，
  导出时若 `characters.book_id` 有值且该书 `updated_at > created_at`（即书被改过），
  就用表重建 `data.character_book` 并放弃「导出原始字节」的捷径；否则导出仍走原件。
  以后加了角色编辑/世界书编辑路由，只要写库时刷新 `updated_at` 即自动生效。
- §3.4 作者注释：`PATCH` 只强制 `text: string`，其余字段缺省补 ST 默认值 `position=1 (IN_CHAT)`、
  `depth=4`、`role=0 (system)`、`interval=1`；字段类型/取值非法 → 400。
- §3.4 全局系统提示词：`enabled=false` **或文本 trim 后为空** → `resolveGlobalSystemPrompt` 返回 `null`。
- §3.2 正则：ST 旧版 `substituteRegex` 为布尔，导入时 `true → 1 (RAW)`、`false → 0 (NONE)`；
  卡内 `extensions.regex_scripts` 里缺 `scriptName`/`findRegex` 的项被跳过（不报错），其余项 id 仍按原下标编号。
- §3.6 inspect：`layoutMode` 取值非法（既不是 `strict` 也不是 `cache-aware`）→ 400 `{ error: 'invalid' }`；
  该校验位于 `resolveGenerationContext`，因此 `POST /generate` 的同名字段也一并生效。
  `parentId` 缺省 = 会话 head，显式传空串（`?parentId=`）= 从根开始。

### 修正（2026-09-14，WI / RX 实现后对照 ST 1.18，主会话汇总）

**世界书（§1）**

- WI-1 `WIActivation.content` **不 trim**（ST 只 trim 扫描缓冲里的消息，条目内容原样 `join('\n')`）。
- WI-2 `vectorized` 条目照常参与键匹配（ST `checkWorldInfo` 不读该字段），`rejected` 无 `vectorized` 原因。
- WI-3 `dryRun`：照常判定 sticky/cooldown，只是 `newState === 输入 state`（有意偏离 ST 的「dry run 跳过时间态检查」，为的是检查器预览与真实生成一致）。
- WI-4 `WITimedState` 增 `messageCount?: number`（快照写入时的消息计数，用于换算剩余数）；引擎自己维护，调用方原样回传。
- WI-5 新增字段：`WISettings.characterStrategy?: 0|1|2`（默认 1 = character_first）、`WIEntry.triggers?`、`WIEntry.characterFilter?`、`WIScanInput.trigger? / characterName? / characterTags? / injects?`。
- WI-6 桶内顺序：`before/after/anTop/anBottom/emBefore/emAfter/depth[].entries` 为 **order 升序**（同 order 后激活者在前）；`outlets[name]` 为 order 降序；`buckets.depth` 桶的顺序为首次出现顺序。AS 直接按数组序 `join('\n')`，不要再排序。
- WI-7 `sortActivations` = order 降序、稳定；`activations` 是全集（含空内容），只有 `buckets` 才落地。
- WI-8 预算：溢出后仍继续找 `ignoreBudget` 条目；被预算拒掉的条目内容仍进递归缓冲（照搬 ST）。
- WI-9 CCv3 装饰器：ST 1.18 只认 `@@activate/@@dont_activate`；本引擎按契约实现完整集合，`@@activate_only_every/@@is_greeting/@@ignore_on_max_context` 仅记录并告警。
- WI-10 §3.3 默认值更正：ST `world_info_recursive = false`、`world_info_include_names = true`（SA 已按契约旧值实现，**SB 接入时改为 ST 默认值**）。
- WI-11 角色书与全局书重名去重由服务端在组装 `books` 时保证（引擎不做）。

**正则 / 宏 / 变量（§2）**

- RX-1 `RegexRunContext.direction` 增第三个取值 `'stored'`；`markdownOnly` 只在 display、`promptOnly` 只在 prompt，**两者皆假的脚本在三个方向都跑**（ST 里它们改写存档消息，我们不改存档，故在提示词侧与显示侧都应用以得到等价结果）。
- RX-2 `substitute` 回调签名为 `(text, postProcess?) => string`；`MacroContext.postProcess?` 对每个宏的展开结果后处理（ESCAPED 模式转义的是宏展开结果，不是整条 find）。
- RX-3 宏求值顺序照 ST `evaluateMacros`：`<USER>/<BOT>/<CHAR>/<GROUP>` → `{{roll}}` → 变量宏 → `newline/trim/noop` → `{{input}}` → env。
- RX-4 env 内 `{{user}} {{char}} {{group}} {{model}}` 在卡字段**之后**替换（M2 顺序错误，已修，卡描述里的 `{{char}}` 现在会展开）。
- RX-5 `incvar/decvar` 会把新值输出到文本；`setvar/addvar` 输出空。
- RX-6 变量值语义 1:1 照 ST：`addvar` 数值分支存 number；`getvar` 读出纯数值字符串转 number；数组值 JSON 存取。
- RX-7 `{{roll::2d6}}` 无效（分隔符只认一个字符）、`{{setvar::k::{{char}}}}` 的值截断到第一个 `}`——照 ST 保留。
- RX-8 新增 `MacroContext` 字段：`charDepthPrompt`、`creatorNotes`、`postProcess`；未实现 `{{maxPrompt}}` 系列（需 token 预算字段，AS 需要时加）。
- RX-9 ST 正则脚本合并顺序为 全局 → 预设 → 角色；M3 无预设级正则。

**导出（主会话）**：`packages/core/src/index.ts` 已导出 `worldinfo/engine`、`worldinfo/types`、`regex/engine`、`variables/transaction`；`prompt/ir.ts` 的精简版激活类型改名为 `WIActivationSummary`。
