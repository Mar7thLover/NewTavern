/**
 * 组装流水线 v2（M3）：预设 + 角色卡 + Persona + 世界书 + 作者注释 + 正则 + 变量 + 历史 → `PromptIR`。
 *
 * 阶段与顺序见 `docs/M3-CONTRACT.md` §4.1：
 * Collect → Normalize → History → Macros → World Info → Regex → Placement → Layout → IR。
 *
 * 行为参照 SillyTavern 1.18：
 * - `public/scripts/openai.js`：`prepareOpenAIMessages` / `preparePromptsForChatCompletion` /
 *   `populateChatCompletion` / `populateChatHistory` / `populateDialogueExamples` /
 *   `populationInjectionPrompts` / `setOpenAIMessageExamples` / `parseExampleIntoIndividual` /
 *   `formatWorldInfo` / `ChatCompletion.squashSystemMessages`
 * - `public/script.js`：`getExtensionPrompt`（注入按 key 字典序合并）、`parseMesExamples`、
 *   `setExtensionPrompt` 的各个 key（`2_floating_prompt` / `DEPTH_PROMPT` / `customDepthWI_*`）
 * - `public/scripts/authors-note.js`：`setFloatingPrompt`（interval 判定）
 * - `public/scripts/world-info.js`：`getWorldInfoPrompt` 的分桶与 AN 拼接
 *
 * 与 ST 的已知偏差集中记在 `docs/M3-CONTRACT.md` §9。
 */

import {
  substituteMacros,
  substituteMacrosDetailed,
  type MacroContext,
  type MacroHistoryMessage,
} from '../macros/engine.js';
import { applyRegexScripts, REGEX_PLACEMENT, type RegexScript } from '../regex/engine.js';
import { estimateTokens } from '../tokenizer.js';
import { VariableTransaction, type VariableEvent } from '../variables/transaction.js';
import { scanWorldInfo } from '../worldinfo/engine.js';
import {
  type WIActivation,
  type WIBook,
  type WIRole,
  type WIScanMessage,
  type WIScanResult,
  type WISettings,
  type WITimedState,
} from '../worldinfo/types.js';
import {
  type Part,
  type PromptIR,
  type Role,
  type SamplingParams,
  type Segment,
  type WIActivationSummary,
} from './ir.js';
import {
  layoutCacheAware,
  layoutStrict,
  resolveLayoutPolicy,
  type LayoutPolicy,
  type LayoutProviderCaps,
  type LayoutReport,
} from './layout/index.js';

// ───────────────────────── 输入类型（M2 契约 §2 + M3 契约 §4） ─────────────────────────

export interface AssembleCharacter {
  id: string;
  name: string;
  data: {
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    [k: string]: unknown;
  };
}

/**
 * 描述放在哪：ST `persona_description_positions`（`public/scripts/personas.js`）
 * IN_PROMPT(0) / TOP_AN(2) / BOTTOM_AN(3) / AT_DEPTH(4) / NONE(9)；已废弃的 AFTER_CHAR(1) 在 ST 里被改回 IN_PROMPT。
 */
export type PersonaDescriptionPosition = 'in_prompt' | 'top_an' | 'bottom_an' | 'at_depth' | 'none';

export interface AssemblePersona {
  id?: string;
  name: string;
  description: string;
  /** 缺省 = 'in_prompt'（走预设的 `personaDescription` 标记） */
  position?: PersonaDescriptionPosition;
  /** 只在 at_depth 时生效；缺省 = ST `DEFAULT_DEPTH` 2 */
  depth?: number;
  /** 只在 at_depth 时生效；缺省 = ST `DEFAULT_ROLE` 0（system） */
  role?: WIRole;
}

export interface AssemblePreset {
  id: string;
  format: 'st-openai' | 'native';
  /** st-openai：ST 预设 JSON 全量（prompts / prompt_order / 采样键）；native：见 DEFAULT_PRESET 结构 */
  data: Record<string, unknown>;
  sampling?: Record<string, unknown> | null;
}

export interface AssembleHistoryNode {
  id: string;
  role: Role;
  name?: string | null;
  parts: Part[];
  reasoning?: { opaque?: { provider: string; model: string; payload: unknown }[] } | null;
  isHidden?: boolean;
}

/** M2 的输入形状；v2 在其上增字段 */
export interface AssembleInput {
  chatId: string;
  model: string;
  /** 当前 provider+model，用于决定历史里的 reasoning_opaque 是否回传 */
  provider: string;
  preset: AssemblePreset | null;
  character: AssembleCharacter | null;
  persona: AssemblePersona | null;
  /** root→head 线性化后的历史（不含正在生成的节点） */
  history: AssembleHistoryNode[];
  layoutMode?: 'strict' | 'cache-aware';
  options?: {
    /** 默认 true：卡 system_prompt / post_history_instructions 覆盖 main / jailbreak */
    preferCharacterPrompt?: boolean;
    /** 默认取预设 openai_max_context，否则 128000 */
    maxContextTokens?: number;
    now?: Date;
    seed?: number;
  };
}

/** 作者注释（ST `chat_metadata` 的 note_* 系列） */
export interface AssembleAuthorsNote {
  text: string;
  /** 0 IN_PROMPT、1 IN_CHAT、2 BEFORE_PROMPT（ST `extension_prompt_types`） */
  position: 0 | 1 | 2;
  depth: number;
  role: WIRole;
  /** 每 N 条用户消息插一次；1 = 每次 */
  interval: number;
}

/** 角色卡 `extensions.depth_prompt` */
export interface AssembleDepthPrompt {
  text: string;
  depth: number;
  role: WIRole;
}

export interface AssembleGlobalSystemPrompt {
  text: string;
  position: 'before_main' | 'after_main';
}

export interface AssembleInputV2 extends AssembleInput {
  /** 已合并：全局 + 角色（char）+ 聊天（chat）+ persona */
  lorebooks: WIBook[];
  wiSettings: WISettings;
  /** 父节点快照；null / 缺省 = 全新 */
  wiState?: WITimedState | null;
  authorsNote?: AssembleAuthorsNote | null;
  characterDepthPrompt?: AssembleDepthPrompt | null;
  /** 已按 enabled 过滤 */
  globalSystemPrompt?: AssembleGlobalSystemPrompt | null;
  /** 全局（按 display_order）+ 角色（按数组序），已过滤 disabled */
  regexScripts?: RegexScript[];
  variables: { chat: Record<string, unknown>; global: Record<string, unknown> };
  /** 可见历史条数（WI delay 用） */
  messageCount: number;
  providerCaps: LayoutProviderCaps;
  layoutPolicy?: Partial<LayoutPolicy>;
  /** 派生确定性随机（mulberry32）；`pickSeed = seed` */
  rng: { seed: string };
  now?: Date;
  idleDurationMs?: number;
  /** 检查器：不推进 WI 时间态、不返回变量副作用 */
  dryRun?: boolean;
}

export interface AssembleResult {
  ir: PromptIR;
  wiState: WITimedState;
  variables: {
    chat: Record<string, unknown>;
    globalChanges: Record<string, unknown>;
    events: VariableEvent[];
  };
  wi: WIScanResult;
  layout: LayoutReport;
  /** strict 参照（`layoutMode==='cache-aware'` 时才有，供 diff） */
  strictIr?: PromptIR;
}

// ───────────────────────── 内置默认预设（M2 契约 §2.3） ─────────────────────────

const DEFAULT_MAIN_PROMPT = [
  "You are {{char}} in a collaborative fiction with {{user}}. Stay in character and write only {{char}}'s speech, actions and inner life — never speak, act or decide for {{user}}.",
  'Follow the character sheet, scenario and example dialogue above; keep their tone, advance the scene with concrete sensory detail, and end on an opening for {{user}} to respond.',
  '你在与 {{user}} 共同创作虚构故事，扮演 {{char}}。请始终保持角色，只书写 {{char}} 的言语、行动与内心，绝不替 {{user}} 发言、行动或做决定。',
  '遵循上文的角色设定、场景与示例对话，保持其语气，用具体可感的细节推进剧情，并在结尾为 {{user}} 留下回应的空间。',
].join('\n');

const DEFAULT_PRESET_IDENTIFIERS = [
  'main',
  'worldInfoBefore',
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
  'worldInfoAfter',
  'dialogueExamples',
  'chatHistory',
];

export const DEFAULT_PRESET: AssemblePreset = {
  id: 'builtin:default',
  format: 'native',
  data: {
    prompts: [
      { identifier: 'main', name: 'Main Prompt', role: 'system', content: DEFAULT_MAIN_PROMPT },
      { identifier: 'worldInfoBefore', name: 'World Info (before)', marker: true },
      { identifier: 'charDescription', name: 'Char Description', marker: true },
      { identifier: 'charPersonality', name: 'Char Personality', marker: true },
      { identifier: 'scenario', name: 'Scenario', marker: true },
      { identifier: 'personaDescription', name: 'Persona Description', marker: true },
      { identifier: 'worldInfoAfter', name: 'World Info (after)', marker: true },
      { identifier: 'dialogueExamples', name: 'Chat Examples', marker: true },
      { identifier: 'chatHistory', name: 'Chat History', marker: true },
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: DEFAULT_PRESET_IDENTIFIERS.map((identifier) => ({ identifier, enabled: true })),
      },
    ],
    personality_format: '{{personality}}',
    scenario_format: '{{scenario}}',
    new_chat_prompt: '',
    new_example_chat_prompt: '[Example Chat]',
    wi_format: '{0}',
    squash_system_messages: false,
    temperature: 1,
    openai_max_tokens: 4096,
    openai_max_context: 128000,
  },
};

/**
 * 「无预设」：会话没选预设（或选的预设已删除）时由服务端显式传入。
 * 与 DEFAULT_PRESET 同结构，但没有 `main` 条目——只发角色卡字段、用户描述、世界书、示例对话与聊天记录。
 * 采样只给中性的 temperature 1，不设输出上限与上下文上限（交给模型能力与适配器的默认值）。
 * 注意：`assemblePrompt` 在 `preset` 为 null 时仍回退 DEFAULT_PRESET，这里不改变那条回退。
 */
export const NO_PRESET: AssemblePreset = {
  id: 'builtin:none',
  format: 'native',
  data: {
    prompts: (DEFAULT_PRESET.data.prompts as Record<string, unknown>[])
      .filter((prompt) => prompt.identifier !== 'main')
      .map((prompt) => ({ ...prompt })),
    prompt_order: [
      {
        character_id: 100001,
        order: DEFAULT_PRESET_IDENTIFIERS.filter((identifier) => identifier !== 'main').map(
          (identifier) => ({ identifier, enabled: true }),
        ),
      },
    ],
    personality_format: '{{personality}}',
    scenario_format: '{{scenario}}',
    new_chat_prompt: '',
    new_example_chat_prompt: '[Example Chat]',
    wi_format: '{0}',
    squash_system_messages: false,
    temperature: 1,
  },
};

// ───────────────────────── 常量 ─────────────────────────

const INJECTION_POSITION_ABSOLUTE = 1;
const DEFAULT_INJECTION_DEPTH = 4;
const DEFAULT_INJECTION_ORDER = 100;
/** ST personas.js `DEFAULT_DEPTH` */
const PERSONA_DEFAULT_DEPTH = 2;
/** ST `getExtensionPrompt` 只在 order 恰为 100 的组里追加扩展注入 */
const EXTENSION_PROMPT_ORDER = 100;
const PROMPT_ORDER_DUMMY_IDS = ['100001', '100000'];

/** ST `populationInjectionPrompts`：同 depth 内 roles 的遍历序（反转后即最终时序） */
const INJECTION_ROLE_ORDER: readonly Role[] = ['system', 'user', 'assistant'];

/** ST `character_names_behavior` */
const NAMES_BEHAVIOR = { NONE: -1, DEFAULT: 0, COMPLETION: 1, CONTENT: 2 } as const;

/**
 * ST `populateChatCompletion` 只显式处理这些非标记 prompt；
 * 其余 `system_prompt !== false` 的条目被静默丢弃（M3 照抄，见 §9 AS-6）。
 */
const ALWAYS_INCLUDED_IDENTIFIERS = new Set(['main', 'nsfw', 'jailbreak', 'enhanceDefinitions']);

const STABILITY_RANK: Record<Segment['stability'], number> = {
  static: 0,
  session: 1,
  history: 2,
  turn: 3,
};

/** ST `squashSystemMessages` 的 excludeList：newMainChat / newChat / groupNudge */
const SQUASH_EXCLUDED_REFS = new Set(['new_chat_prompt', 'new_example_chat_prompt']);

type NumericSamplingKey =
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'minP'
  | 'frequencyPenalty'
  | 'presencePenalty'
  | 'repetitionPenalty'
  | 'maxTokens'
  | 'seed';

const SAMPLING_MAP: readonly (readonly [NumericSamplingKey, string])[] = [
  ['temperature', 'temperature'],
  ['topP', 'top_p'],
  ['topK', 'top_k'],
  ['minP', 'min_p'],
  ['frequencyPenalty', 'frequency_penalty'],
  ['presencePenalty', 'presence_penalty'],
  ['repetitionPenalty', 'repetition_penalty'],
  ['maxTokens', 'openai_max_tokens'],
  ['seed', 'seed'],
];

// ───────────────────────── 小工具 ─────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readRole(value: unknown): Role {
  return value === 'user' || value === 'assistant' ? value : 'system';
}

/** ST `extension_prompt_roles` → IR role */
function promptRole(role: WIRole | undefined | null): Role {
  return role === 1 ? 'user' : role === 2 ? 'assistant' : 'system';
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return i;
  }
  return -1;
}

/** FNV-1a 32 位哈希（与宏引擎的 `{{pick}}` 同算法） */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32：由 `rng.seed` 派生的确定性 PRNG（契约 §4） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** ST `stringFormat`：`{0}` 占位替换 */
function stringFormat(format: string, ...args: string[]): string {
  return format.replace(/{(\d+)}/g, (match, index: string) => args[Number(index)] ?? match);
}

/** ST `formatWorldInfo`：空值不产生内容；`wi_format` 只含空白时原样返回 */
function formatWorldInfo(value: string, format: string): string {
  if (!value) return '';
  if (format.trim() === '') return value;
  return stringFormat(format, value);
}

function segmentTokens(segment: Segment): number {
  let total = 0;
  for (const part of segment.parts) {
    if (part.type === 'text') total += estimateTokens(part.text);
  }
  return total;
}

function textOf(segment: Segment): string | undefined {
  if (segment.parts.length !== 1) return undefined;
  const part = segment.parts[0];
  if (part === undefined || part.type !== 'text') return undefined;
  return part.text;
}

// ───────────────────────── 预设读取 ─────────────────────────

interface PresetPrompt {
  identifier: string;
  marker: boolean;
  role: Role;
  content: string;
  /** ST 只把 `system_prompt === false` 的自定义 prompt 加进消息列表 */
  systemPrompt: boolean | undefined;
  injectionPosition?: number;
  injectionDepth: number;
  injectionOrder: number;
  forbidOverrides: boolean;
  /** 预设 `extensions.newtavern.locked`：布局器不得移动 */
  locked: boolean;
  /** 被角色卡覆盖时，原预设内容（供 `{{original}}` 使用） */
  original?: string;
}

function readPrompts(data: Record<string, unknown>): PresetPrompt[] {
  const raw = data.prompts;
  if (!Array.isArray(raw)) return [];
  const prompts: PresetPrompt[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const identifier = readString(item.identifier);
    if (identifier === undefined) continue;
    const extensions = isRecord(item.extensions) ? item.extensions : undefined;
    const newtavern =
      extensions && isRecord(extensions.newtavern) ? extensions.newtavern : undefined;
    prompts.push({
      identifier,
      marker: item.marker === true,
      role: readRole(item.role),
      content: readString(item.content) ?? '',
      systemPrompt: typeof item.system_prompt === 'boolean' ? item.system_prompt : undefined,
      injectionPosition: readNumber(item.injection_position),
      injectionDepth: readNumber(item.injection_depth) ?? DEFAULT_INJECTION_DEPTH,
      injectionOrder: readNumber(item.injection_order) ?? DEFAULT_INJECTION_ORDER,
      forbidOverrides: item.forbid_overrides === true,
      locked: newtavern?.locked === true,
    });
  }
  return prompts;
}

function readPromptOrder(data: Record<string, unknown>): string[] | undefined {
  const raw = data.prompt_order;
  if (!Array.isArray(raw)) return undefined;
  const lists = raw.filter(isRecord);
  if (lists.length === 0) return undefined;
  let picked: Record<string, unknown> | undefined;
  for (const dummyId of PROMPT_ORDER_DUMMY_IDS) {
    picked = lists.find((list) => String(list.character_id) === dummyId);
    if (picked) break;
  }
  picked ??= lists[0];
  if (picked === undefined || !Array.isArray(picked.order)) return undefined;
  const identifiers: string[] = [];
  for (const entry of picked.order) {
    if (!isRecord(entry) || entry.enabled !== true) continue;
    const identifier = readString(entry.identifier);
    if (identifier !== undefined) identifiers.push(identifier);
  }
  return identifiers;
}

// ───────────────────────── 示例对话（ST parseMesExamples / parseExampleIntoIndividual） ─────────────────────────

/** ST `parseMesExamples`（`main_api==='openai'` 分支：blockHeading 固定为 `<START>\n`） */
export function parseMesExampleBlocks(examples: string): string[] {
  if (!examples || examples.length === 0 || examples === '<START>') return [];
  let text = examples;
  if (!text.startsWith('<START>')) text = `<START>\n${text.trim()}`;
  return text
    .split(/<START>/gi)
    .slice(1)
    .map((block) => `<START>\n${block.trim()}\n`);
}

export interface ExampleMessage {
  name: 'example_user' | 'example_assistant';
  content: string;
}

/**
 * ST `parseExampleIntoIndividual`（非群聊分支）：按 `用户名:` / `角色名:` 切成独立消息，
 * 每条 role 都是 system，`name` 为 `example_user` / `example_assistant`。
 */
export function parseExampleIntoIndividual(
  block: string,
  userName: string,
  charName: string,
): ExampleMessage[] {
  const replaced = block.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
  const lines = replaced.split('\n');
  const result: ExampleMessage[] = [];
  let currentLines: string[] = [];
  let inUser = false;
  let inBot = false;

  const addMessage = (name: string, systemName: ExampleMessage['name']): void => {
    const content = currentLines.join('\n').replace(`${name}:`, '').trim();
    result.push({ name: systemName, content });
    currentLines = [];
  };

  // 跳过首行（总是 `{Example Dialogue:}`）
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (userName !== '' && line.startsWith(`${userName}:`)) {
      if (inBot) addMessage(charName, 'example_assistant');
      inUser = true;
      inBot = false;
    } else if (charName !== '' && line.startsWith(`${charName}:`)) {
      if (inUser) addMessage(userName, 'example_user');
      inBot = true;
      inUser = false;
    }
    currentLines.push(line);
  }
  if (inUser) addMessage(userName, 'example_user');
  else if (inBot) addMessage(charName, 'example_assistant');

  return result;
}

// ───────────────────────── 主流程 ─────────────────────────

export function assemblePrompt(input: AssembleInputV2): AssembleResult {
  const preset = input.preset ?? DEFAULT_PRESET;
  const data = preset.data;
  const options = input.options ?? {};
  const preferCharacterPrompt = options.preferCharacterPrompt ?? true;
  const warnings: string[] = [];
  const now = input.now ?? options.now;
  const regexScripts = input.regexScripts ?? [];
  const wiFormat = readString(data.wi_format) ?? '{0}';
  const namesBehavior = readNumber(data.names_behavior) ?? NAMES_BEHAVIOR.DEFAULT;

  // ── Collect：随机源与变量事务
  const random = mulberry32(fnv1a(input.rng.seed));
  const transaction = new VariableTransaction(input.variables);

  const charName = input.character?.name ?? '';
  const userName = input.persona?.name ?? '';
  const cardData = input.character?.data ?? {};

  // ── Macros：先用「种子上下文」展开卡字段（对应 ST 的 baseChatReplace）
  const seedCtx: MacroContext = {
    char: charName,
    user: userName,
    now,
    model: input.model,
    variables: transaction,
    rng: random,
    pickSeed: input.rng.seed,
    ...(input.idleDurationMs === undefined ? {} : { idleDurationMs: input.idleDurationMs }),
  };

  const description = substituteMacrosDetailed(readString(cardData.description) ?? '', seedCtx);
  const personality = substituteMacrosDetailed(readString(cardData.personality) ?? '', seedCtx);
  const scenario = substituteMacrosDetailed(readString(cardData.scenario) ?? '', seedCtx);
  const mesExamples = substituteMacrosDetailed(readString(cardData.mes_example) ?? '', seedCtx);
  const personaDescription = substituteMacrosDetailed(input.persona?.description ?? '', seedCtx);
  const personaPosition = input.persona?.position ?? 'in_prompt';
  // ST 判的是原始描述（`!power_user.persona_description`），不是宏替换后的结果
  const personaHasDescription = (input.persona?.description ?? '') !== '';
  const creatorNotes = readString(cardData.creator_notes) ?? '';
  const charDepthPromptText = input.characterDepthPrompt?.text ?? '';

  const macroHistory: MacroHistoryMessage[] = input.history
    .filter((node) => node.isHidden !== true)
    .map((node, index) => ({
      role: node.role,
      ...(node.name ? { name: node.name } : {}),
      text: node.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
      id: index,
    }));

  const outlets: Record<string, string> = {};

  const ctx: MacroContext = {
    ...seedCtx,
    persona: personaDescription.text,
    description: description.text,
    personality: personality.text,
    scenario: scenario.text,
    // ST `{{mesExamples}}` = `parseMesExamples(card.mes_example).join('')`（每块带 `<START>\n` 头与尾换行）
    mesExamples: parseMesExampleBlocks(mesExamples.text).join(''),
    charVersion: readString(cardData.character_version),
    charPrompt: readString(cardData.system_prompt),
    charJailbreak: readString(cardData.post_history_instructions),
    charDepthPrompt: charDepthPromptText,
    creatorNotes,
    history: macroHistory,
    outlets,
  };

  const substitute = (text: string, postProcess?: (value: string) => string): string =>
    substituteMacros(text, postProcess ? { ...ctx, postProcess } : ctx);

  // ── History：root→parent 可见历史 → 提示词侧正则 → 宏
  const visible = input.history.filter((node) => node.isHidden !== true);
  const lastUserIndex = findLastIndex(visible, (node) => node.role === 'user');
  const userMessageCount = visible.filter((node) => node.role === 'user').length;

  interface PreparedHistoryNode {
    node: AssembleHistoryNode;
    index: number;
    depth: number;
    parts: Part[];
    text: string;
    volatile: boolean;
  }

  const prepared: PreparedHistoryNode[] = visible.map((node, index) => {
    const depth = visible.length - 1 - index;
    const placement = node.role === 'user' ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT;
    const parts: Part[] = [];
    let volatile = false;
    const texts: string[] = [];
    for (const part of node.parts) {
      if (part.type !== 'text') {
        parts.push(part);
        continue;
      }
      const regexed =
        node.role === 'system'
          ? part.text
          : applyRegexScripts(regexScripts, part.text, {
              placement,
              direction: 'prompt',
              depth,
              substitute,
            });
      const substituted = substituteMacrosDetailed(regexed, ctx);
      volatile ||= substituted.volatile;
      parts.push({ type: 'text', text: substituted.text });
      texts.push(substituted.text);
    }
    return { node, index, depth, parts, text: texts.join('\n'), volatile };
  });

  // ── World Info
  const scanHistory: WIScanMessage[] = prepared.map((item) => ({
    role: item.node.role,
    ...(item.node.name ? { name: item.node.name } : {}),
    text: item.text,
  }));

  const wi = scanWorldInfo({
    books: input.lorebooks,
    settings: input.wiSettings,
    history: scanHistory,
    globalScan: {
      personaDescription: personaDescription.text,
      characterDescription: description.text,
      characterPersonality: personality.text,
      characterDepthPrompt: charDepthPromptText,
      scenario: scenario.text,
      creatorNotes,
    },
    state: input.wiState ?? null,
    messageCount: input.messageCount,
    // AT_DEPTH 的描述在 ST 里以 `scan: true` 注册成扩展提示词（script.js
    // `addPersonaDescriptionExtensionPrompt`），WI 扫描时 `buffer.addInject` 会把它并进扫描源
    // （world-info.js `checkWorldInfo`）。ST 在扫描之后才设置它，所以切换聊天后的第一次生成
    // 扫不到（`clearChat` 清空了 extension_prompts）；这里取稳态行为，每次都并入。
    ...(personaPosition === 'at_depth' && personaHasDescription
      ? { injects: [personaDescription.text] }
      : {}),
    substitute: (text: string) => substitute(text),
    random,
    countTokens: estimateTokens,
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    ...(charName === '' ? {} : { characterName: charName }),
  });
  warnings.push(...wi.warnings);

  // ── Regex：WI 内容过 placement 5 的提示词侧正则，空内容剔除（ST 在建提示词时做）
  const wiContent = (activation: WIActivation): string => {
    const atDepth = activation.entry.position === 4;
    return applyRegexScripts(regexScripts, activation.content, {
      placement: REGEX_PLACEMENT.WORLD_INFO,
      direction: 'prompt',
      ...(atDepth ? { depth: activation.entry.depth ?? DEFAULT_INJECTION_DEPTH } : {}),
      substitute,
    });
  };
  const bucketTexts = (list: readonly WIActivation[]): string[] =>
    list.map(wiContent).filter((text) => text !== '');

  const wiBeforeTexts = bucketTexts(wi.buckets.before);
  const wiAfterTexts = bucketTexts(wi.buckets.after);
  const wiAnTopTexts = bucketTexts(wi.buckets.anTop);
  const wiAnBottomTexts = bucketTexts(wi.buckets.anBottom);

  for (const [name, list] of Object.entries(wi.buckets.outlets)) {
    outlets[name] = bucketTexts(list).join('\n');
  }

  /** WI 段的稳定层：触发式 = turn、聊天书 constant = session、其余 constant = static */
  const wiStability = (list: readonly WIActivation[]): Segment['stability'] => {
    let session = false;
    for (const activation of list) {
      if (activation.reason !== 'constant' && activation.reason !== 'sticky') return 'turn';
      if (activation.reason === 'sticky') session = true;
      if (activation.entry.source?.scope === 'chat') session = true;
    }
    return session ? 'session' : 'static';
  };

  // ── 作者注释（ST setFloatingPrompt 的 interval 判定；计数用**用户消息**条数）
  const an = input.authorsNote ?? null;
  const anInterval = an?.interval ?? 1;
  const anDepth = an?.depth ?? DEFAULT_INJECTION_DEPTH;
  const anRole = an?.role ?? 0;
  const anPosition = an?.position ?? 1;
  const anCount = anInterval === 1 ? 1 : userMessageCount;
  let anShouldAdd = anCount > 0 && anInterval > 0;
  if (anShouldAdd) {
    const till = anCount >= anInterval ? anCount % anInterval : anInterval - anCount;
    anShouldAdd = till === 0;
  }
  const anBaseText = anShouldAdd ? substitute(an?.text ?? '') : '';
  // ST world-info.js：`${ANTop}\n${AN}\n${ANBottom}` 后去掉首尾各一个换行
  const anWithWi = anShouldAdd
    ? `${wiAnTopTexts.join('\n')}\n${anBaseText}\n${wiAnBottomTexts.join('\n')}`.replace(
        /(^\n)|(\n$)/g,
        '',
      )
    : '';
  // 用户档案描述 TOP_AN / BOTTOM_AN：ST script.js `addPersonaDescriptionExtensionPrompt`
  // 在 WI 并入 AN 之后执行，同样只在 `shouldWIAddPrompt`（AN interval 命中）时拼接，不做 trim
  let anText = anWithWi;
  if (anShouldAdd && personaHasDescription) {
    if (personaPosition === 'top_an') anText = `${personaDescription.text}\n${anWithWi}`;
    else if (personaPosition === 'bottom_an') anText = `${anWithWi}\n${personaDescription.text}`;
  }

  // ── 预设 prompts 与顺序
  const prompts = readPrompts(data);
  const promptById = new Map<string, PresetPrompt>();
  for (const prompt of prompts) {
    if (!promptById.has(prompt.identifier)) promptById.set(prompt.identifier, prompt);
  }
  const orderIdentifiers = readPromptOrder(data) ?? prompts.map((prompt) => prompt.identifier);

  const resolved: PresetPrompt[] = [];
  for (const identifier of orderIdentifiers) {
    const prompt = promptById.get(identifier);
    if (!prompt) continue;
    resolved.push(applyCardOverride(prompt, cardData, preferCharacterPrompt));
  }

  // ── Placement
  const segments: Segment[] = [];
  const idCounts = new Map<string, number>();
  let slotOrder = 0;
  let droppedReasoning = false;

  const nextId = (base: string): string => {
    const used = idCounts.get(base) ?? 0;
    idCounts.set(base, used + 1);
    return used === 0 ? base : `${base}#${used}`;
  };

  const addSystemSegment = (segment: Omit<Segment, 'anchor'>): void => {
    segments.push({ ...segment, anchor: { slot: 'system', order: slotOrder } });
    slotOrder += 1;
  };

  interface TextSegmentOptions {
    role?: Role;
    name?: string;
    locked?: boolean;
  }

  const addTextSegment = (
    idBase: string,
    value: { text: string; volatile: boolean },
    origin: Segment['origin'],
    stability: Segment['stability'],
    extra: TextSegmentOptions = {},
  ): void => {
    if (value.text === '') return;
    addSystemSegment({
      id: nextId(idBase),
      role: extra.role ?? 'system',
      parts: [{ type: 'text', text: value.text }],
      ...(extra.name === undefined ? {} : { name: extra.name }),
      origin,
      stability,
      ...(value.volatile ? { volatile: true } : {}),
      ...(extra.locked ? { locked: true } : {}),
    });
  };

  const plain = (text: string): { text: string; volatile: boolean } => ({ text, volatile: false });

  // 深度注入（ST 在 populateChatHistory 之前算好 absolutePrompts）
  const injections = resolved.filter(
    (prompt) => prompt.injectionPosition === INJECTION_POSITION_ABSOLUTE,
  );

  const globalSystemPrompt = input.globalSystemPrompt ?? null;
  const gspText = globalSystemPrompt
    ? substituteMacrosDetailed(globalSystemPrompt.text, ctx)
    : null;
  let gspEmitted = false;
  const hasMain = resolved.some(
    (prompt) =>
      prompt.identifier === 'main' &&
      !prompt.marker &&
      prompt.injectionPosition !== INJECTION_POSITION_ABSOLUTE,
  );

  const addGlobalSystemPrompt = (position: 'before_main' | 'after_main'): void => {
    if (gspText === null || globalSystemPrompt === null) return;
    if (globalSystemPrompt.position !== position) return;
    addTextSegment('global_system', gspText, { kind: 'global_system' }, 'static');
    gspEmitted = true;
  };

  const addAuthorsNoteRelative = (which: 'start' | 'end'): void => {
    if (anText === '') return;
    // ST getPromptPosition：BEFORE_PROMPT(2) → 'start'、IN_PROMPT(0) → 'end'、IN_CHAT(1) → 不相对插入
    const target = anPosition === 2 ? 'start' : anPosition === 0 ? 'end' : null;
    if (target !== which) return;
    addTextSegment('authors_note', plain(anText), { kind: 'authors_note' }, 'session', {
      role: promptRole(anRole),
    });
  };

  if (!hasMain) {
    // ST：没有 main 时，相对插入的扩展提示词会被丢弃；GSP 是我们自己的概念，放 system 槽最前
    if (gspText !== null) {
      addTextSegment('global_system', gspText, { kind: 'global_system' }, 'static');
      gspEmitted = true;
    }
    if (anText !== '' && (anPosition === 0 || anPosition === 2)) {
      warnings.push('预设里没有 main 提示词，相对定位的作者注释被丢弃（与 ST 一致）');
    }
  }

  for (const prompt of resolved) {
    if (prompt.injectionPosition === INJECTION_POSITION_ABSOLUTE) continue;

    if (prompt.marker) {
      switch (prompt.identifier) {
        case 'worldInfoBefore':
          addTextSegment(
            'worldinfo:before',
            plain(formatWorldInfo(wiBeforeTexts.join('\n'), wiFormat)),
            { kind: 'worldinfo', ref: 'before' },
            wiStability(wi.buckets.before),
            { locked: prompt.locked },
          );
          break;
        case 'worldInfoAfter':
          addTextSegment(
            'worldinfo:after',
            plain(formatWorldInfo(wiAfterTexts.join('\n'), wiFormat)),
            { kind: 'worldinfo', ref: 'after' },
            wiStability(wi.buckets.after),
            { locked: prompt.locked },
          );
          break;
        case 'charDescription':
          addTextSegment(
            'character:description',
            description,
            { kind: 'character', ref: 'description' },
            'static',
            { locked: prompt.locked },
          );
          break;
        case 'charPersonality':
          addTextSegment(
            'character:personality',
            formatField(personality, readString(data.personality_format) ?? '{{personality}}', ctx),
            { kind: 'character', ref: 'personality' },
            'static',
            { locked: prompt.locked },
          );
          break;
        case 'scenario':
          addTextSegment(
            'character:scenario',
            formatField(scenario, readString(data.scenario_format) ?? '{{scenario}}', ctx),
            { kind: 'character', ref: 'scenario' },
            'static',
            { locked: prompt.locked },
          );
          break;
        case 'personaDescription':
          // ST openai.js `preparePromptsForChatCompletion`：只有 IN_PROMPT 才进 personaDescription 标记
          if (personaPosition !== 'in_prompt') break;
          addTextSegment('persona', personaDescription, { kind: 'persona' }, 'static', {
            locked: prompt.locked,
          });
          break;
        case 'dialogueExamples': {
          const separator = substituteMacrosDetailed(
            readString(data.new_example_chat_prompt) ?? '[Example Chat]',
            ctx,
          );
          for (const block of buildExampleBlocks(
            mesExamples.text,
            wi.buckets.emBefore.map(wiContent).filter((text) => text !== ''),
            wi.buckets.emAfter.map(wiContent).filter((text) => text !== ''),
          )) {
            const messages = parseExampleIntoIndividual(block, userName, charName);
            if (messages.length === 0) continue;
            addTextSegment(
              'preset:newExampleChat',
              separator,
              { kind: 'preset', ref: 'new_example_chat_prompt' },
              'static',
            );
            for (const message of messages) {
              addTextSegment(
                'character:mes_example',
                plain(message.content),
                { kind: 'character', ref: 'mes_example' },
                'static',
                { name: message.name },
              );
            }
          }
          break;
        }
        case 'chatHistory':
          addTextSegment(
            'preset:newMainChat',
            substituteMacrosDetailed(readString(data.new_chat_prompt) ?? '[Start a new Chat]', ctx),
            { kind: 'preset', ref: 'new_chat_prompt' },
            'static',
          );
          segments.push(
            ...buildHistory({
              input,
              ctx,
              prepared,
              lastUserIndex,
              namesBehavior,
              injections,
              substitute,
              anText,
              anPosition,
              anDepth,
              anRole,
              characterDepthPrompt: input.characterDepthPrompt ?? null,
              personaDepthPrompt:
                personaPosition === 'at_depth' && personaHasDescription
                  ? {
                      text: personaDescription.text,
                      volatile: personaDescription.volatile,
                      depth: input.persona?.depth ?? PERSONA_DEFAULT_DEPTH,
                      role: input.persona?.role ?? 0,
                    }
                  : null,
              wiDepth: wi.buckets.depth,
              wiContent,
              nextId,
              onReasoningDropped: () => {
                droppedReasoning = true;
              },
            }),
          );
          break;
        default:
          break;
      }
      continue;
    }

    // 非标记 prompt：ST 只加入 main / nsfw / jailbreak / enhanceDefinitions 与 system_prompt === false 的条目
    if (!ALWAYS_INCLUDED_IDENTIFIERS.has(prompt.identifier) && prompt.systemPrompt !== false) {
      warnings.push(
        `预设提示词「${prompt.identifier}」带 system_prompt:true 且不在 ST 的白名单里，已按 ST 丢弃`,
      );
      continue;
    }

    if (prompt.identifier === 'main') {
      addGlobalSystemPrompt('before_main');
      addAuthorsNoteRelative('start');
      addTextSegment(
        'preset:main',
        substituteMacrosDetailed(prompt.content, promptCtx(ctx, prompt)),
        { kind: 'preset', ref: 'main' },
        'static',
        { role: prompt.role, locked: prompt.locked },
      );
      addAuthorsNoteRelative('end');
      addGlobalSystemPrompt('after_main');
      continue;
    }

    addTextSegment(
      `preset:${prompt.identifier}`,
      substituteMacrosDetailed(prompt.content, promptCtx(ctx, prompt)),
      { kind: 'preset', ref: prompt.identifier },
      'static',
      { role: prompt.role, locked: prompt.locked },
    );
  }

  if (globalSystemPrompt !== null && gspText !== null && gspText.text !== '' && !gspEmitted) {
    warnings.push('全局系统提示词没有找到 main 段作为锚点，已放在 system 槽最前');
    segments.unshift({
      id: 'global_system',
      role: 'system',
      parts: [{ type: 'text', text: gspText.text }],
      origin: { kind: 'global_system' },
      anchor: { slot: 'system', order: -1 },
      stability: 'static',
    });
  }

  if (droppedReasoning) {
    warnings.push('部分推理块因 provider/模型切换被丢弃');
  }

  // ── `{{outlet::name}}` 二次替换（WI 扫描必须先于 outlet 展开）
  if (Object.keys(outlets).length > 0) {
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (segment === undefined) continue;
      if (!segment.parts.some((part) => part.type === 'text' && part.text.includes('{{outlet'))) {
        continue;
      }
      segments[i] = {
        ...segment,
        parts: segment.parts.map((part) =>
          part.type === 'text' ? { type: 'text', text: substitute(part.text) } : part,
        ),
      };
    }
  }

  // ── 采样参数
  const samplingSource = isRecord(preset.sampling) ? preset.sampling : data;
  const readSampling = (key: string): number | undefined =>
    readNumber(samplingSource[key]) ?? readNumber(data[key]);
  const sampling: SamplingParams = {};
  for (const [target, key] of SAMPLING_MAP) {
    const value = readSampling(key);
    if (value !== undefined) sampling[target] = value;
  }

  // ── 历史裁剪
  const maxContextTokens =
    options.maxContextTokens ?? readSampling('openai_max_context') ?? 128_000;
  const budget = Math.max(0, maxContextTokens - (sampling.maxTokens ?? 0));
  let total = segments.reduce((sum, segment) => sum + segmentTokens(segment), 0);
  let dropped = 0;
  while (total > budget) {
    const index = segments.findIndex((segment) => segment.origin.kind === 'history');
    const victim = index < 0 ? undefined : segments[index];
    if (victim === undefined) break;
    total -= segmentTokens(victim);
    segments.splice(index, 1);
    dropped += 1;
  }
  if (dropped > 0) {
    warnings.push(`上下文预算不足，已丢弃最早的 ${dropped} 条历史消息`);
  }

  // ── squash_system_messages
  const placed = data.squash_system_messages === true ? squashSystem(segments) : segments;

  // ── Layout
  const layoutMode = input.layoutMode ?? 'strict';
  const policy = resolveLayoutPolicy(input.layoutPolicy);
  const layoutCtx = {
    providerCaps: input.providerCaps,
    policy,
    countTokens: estimateTokens,
  };
  const strict = layoutStrict(placed, layoutCtx);
  const chosen = layoutMode === 'cache-aware' ? layoutCacheAware(placed, layoutCtx) : strict;

  const activations: WIActivationSummary[] = wi.activations.map((activation) => ({
    entryId: activation.entry.id,
    bookId: activation.entry.bookId,
    position: activation.entry.position,
    ...(activation.entry.depth === undefined ? {} : { depth: activation.entry.depth }),
    role: promptRole(activation.entry.role),
    order: activation.entry.order,
  }));

  const makeIr = (result: typeof strict, mode: 'strict' | 'cache-aware'): PromptIR => ({
    model: input.model,
    sampling,
    segments: result.segments,
    cachePlan: result.cachePlan,
    meta: {
      chatId: input.chatId,
      presetId: input.preset?.id ?? DEFAULT_PRESET.id,
      layoutMode: mode,
      activations,
      warnings: [...warnings, ...result.report.warnings],
      tokenEstimate: result.segments.reduce((sum, segment) => sum + segmentTokens(segment), 0),
    },
  });

  const ir = makeIr(chosen, layoutMode);
  const commit = transaction.commit();

  return {
    ir,
    wiState: wi.newState,
    variables: input.dryRun
      ? { chat: { ...input.variables.chat }, globalChanges: {}, events: transaction.events }
      : { chat: commit.chat, globalChanges: commit.globalChanges, events: transaction.events },
    wi,
    layout: chosen.report,
    ...(layoutMode === 'cache-aware' ? { strictIr: makeIr(strict, 'strict') } : {}),
  };
}

// ───────────────────────── 子过程 ─────────────────────────

function applyCardOverride(
  prompt: PresetPrompt,
  cardData: Record<string, unknown>,
  preferCharacterPrompt: boolean,
): PresetPrompt {
  if (!preferCharacterPrompt || prompt.forbidOverrides) return prompt;
  const field =
    prompt.identifier === 'main'
      ? 'system_prompt'
      : prompt.identifier === 'jailbreak'
        ? 'post_history_instructions'
        : null;
  if (field === null) return prompt;
  const override = (readString(cardData[field]) ?? '').trim();
  if (override === '') return prompt;
  return { ...prompt, content: override, original: prompt.content };
}

function promptCtx(ctx: MacroContext, prompt: PresetPrompt): MacroContext {
  return prompt.original === undefined ? ctx : { ...ctx, original: prompt.original };
}

function formatField(
  field: { text: string; volatile: boolean },
  format: string | undefined,
  ctx: MacroContext,
): { text: string; volatile: boolean } {
  if (field.text === '') return field;
  if (format === undefined || format === '') return field;
  const formatted = substituteMacrosDetailed(format, ctx);
  return { text: formatted.text, volatile: formatted.volatile || field.volatile };
}

/**
 * 示例块列表：卡的 `mes_example` 切块，再按 ST 的 `EMEntries` 顺序把 WI 示例块插到前后。
 *
 * ST 在 `EMEntries`（order 升序）上依次 `unshift` / `push`，因此**前置**块的最终顺序是
 * order 降序、**后置**块是 order 升序（见 `docs/M3-CONTRACT.md` §9 AS-4）。
 */
function buildExampleBlocks(
  mesExamples: string,
  emBefore: readonly string[],
  emAfter: readonly string[],
): string[] {
  const own = parseMesExampleBlocks(mesExamples);
  const before = [...emBefore].reverse().flatMap((text) => parseMesExampleBlocks(text));
  const after = emAfter.flatMap((text) => parseMesExampleBlocks(text));
  return [...before, ...own, ...after];
}

interface PreparedNode {
  node: AssembleHistoryNode;
  index: number;
  depth: number;
  parts: Part[];
  text: string;
  volatile: boolean;
}

interface BuildHistoryArgs {
  input: AssembleInputV2;
  ctx: MacroContext;
  prepared: PreparedNode[];
  lastUserIndex: number;
  namesBehavior: number;
  injections: PresetPrompt[];
  substitute: (text: string) => string;
  anText: string;
  anPosition: 0 | 1 | 2;
  anDepth: number;
  anRole: WIRole;
  characterDepthPrompt: AssembleDepthPrompt | null;
  /** 用户档案描述 AT_DEPTH（文本已宏替换） */
  personaDepthPrompt: (AssembleDepthPrompt & { volatile: boolean }) | null;
  wiDepth: WIScanResult['buckets']['depth'];
  wiContent: (activation: WIActivation) => string;
  nextId: (base: string) => string;
  onReasoningDropped: () => void;
}

/** 一条深度注入的来源（合并同 (depth, order, role) 时用来决定 id / origin / stability） */
interface InjectionSource {
  id: string;
  origin: Segment['origin'];
  stability: Segment['stability'];
  text: string;
  volatile: boolean;
}

/** 历史段 + 深度注入（ST `populateChatHistory` + `populationInjectionPrompts`） */
function buildHistory(args: BuildHistoryArgs): Segment[] {
  const {
    input,
    ctx,
    prepared,
    lastUserIndex,
    namesBehavior,
    injections,
    substitute,
    anText,
    anPosition,
    anDepth,
    anRole,
    characterDepthPrompt,
    personaDepthPrompt,
    wiDepth,
    wiContent,
    nextId,
    onReasoningDropped,
  } = args;

  const historySegments = prepared.map((item) =>
    buildHistorySegment(
      item,
      item.index === lastUserIndex,
      namesBehavior,
      input,
      onReasoningDropped,
    ),
  );

  /**
   * ST `getExtensionPrompt(IN_CHAT, depth, '\n', role)`：按 key 字典序合并。
   * 相关 key 的字典序：`2_floating_prompt` < `DEPTH_PROMPT` < `PERSONA_DESCRIPTION` < `customDepthWI_*`。
   */
  const extensionAt = (depth: number, role: WIRole): InjectionSource[] => {
    const sources: InjectionSource[] = [];
    if (anText !== '' && anPosition === 1 && anDepth === depth && anRole === role) {
      sources.push({
        id: 'authors_note',
        origin: { kind: 'authors_note' },
        stability: 'session',
        text: anText,
        volatile: false,
      });
    }
    const charDepth = characterDepthPrompt;
    if (
      charDepth &&
      charDepth.text !== '' &&
      charDepth.depth === depth &&
      charDepth.role === role
    ) {
      sources.push({
        id: 'injection:char_depth_prompt',
        origin: { kind: 'character', ref: 'depth_prompt' },
        stability: 'static',
        text: substitute(charDepth.text),
        volatile: false,
      });
    }
    // ST script.js `addPersonaDescriptionExtensionPrompt`：
    // setExtensionPrompt('PERSONA_DESCRIPTION', desc, IN_CHAT, depth, true, role)
    const persona = personaDepthPrompt;
    if (persona && persona.text !== '' && persona.depth === depth && persona.role === role) {
      sources.push({
        id: 'persona:depth',
        origin: { kind: 'persona', ref: 'depth' },
        stability: 'static',
        text: persona.text,
        volatile: persona.volatile,
      });
    }
    for (const bucket of wiDepth) {
      if (bucket.depth !== depth || bucket.role !== role) continue;
      const text = bucket.entries
        .map(wiContent)
        .filter((item) => item !== '')
        .join('\n');
      if (text === '') continue;
      sources.push({
        id: `worldinfo:depth:${depth}:${role}`,
        origin: { kind: 'worldinfo', ref: `depth:${depth}` },
        stability: 'turn',
        text,
        volatile: false,
      });
    }
    return sources;
  };

  // 预设的绝对注入：按 depth → order（降序遍历，反转后即升序）→ role 分组
  const presetByDepth = new Map<number, PresetPrompt[]>();
  const depths = new Set<number>();
  for (const prompt of injections) {
    const depth = Math.max(0, prompt.injectionDepth);
    const list = presetByDepth.get(depth) ?? [];
    list.push(prompt);
    presetByDepth.set(depth, list);
    depths.add(depth);
  }
  if (anText !== '' && anPosition === 1) depths.add(anDepth);
  if (characterDepthPrompt && characterDepthPrompt.text !== '') {
    depths.add(characterDepthPrompt.depth);
  }
  if (personaDepthPrompt && personaDepthPrompt.text !== '') {
    depths.add(personaDepthPrompt.depth);
  }
  for (const bucket of wiDepth) depths.add(bucket.depth);

  const slots = new Map<number, Segment[]>();

  for (const depth of [...depths].sort((a, b) => a - b)) {
    const depthPrompts = (presetByDepth.get(depth) ?? []).filter(
      (prompt) => prompt.content.trim() !== '',
    );
    const orders = new Set<number>([EXTENSION_PROMPT_ORDER]);
    for (const prompt of depthPrompts) orders.add(prompt.injectionOrder);

    const roleMessages: Segment[] = [];
    // ST 按 order 降序遍历，最后整体反转 → 时序为 order 升序
    for (const order of [...orders].sort((a, b) => b - a)) {
      for (const role of INJECTION_ROLE_ORDER) {
        const sources: InjectionSource[] = depthPrompts
          .filter((prompt) => prompt.injectionOrder === order && prompt.role === role)
          .map((prompt) => {
            const substituted = substituteMacrosDetailed(prompt.content, promptCtx(ctx, prompt));
            return {
              id: `injection:${prompt.identifier}`,
              origin: { kind: 'injection', ref: prompt.identifier } as Segment['origin'],
              stability: 'turn' as Segment['stability'],
              text: substituted.text,
              volatile: substituted.volatile,
            };
          })
          .filter((source) => source.text !== '');

        if (order === EXTENSION_PROMPT_ORDER) {
          sources.push(...extensionAt(depth, roleToWiRole(role)));
        }

        const parts = sources.map((source) => source.text.trim()).filter((text) => text !== '');
        if (parts.length === 0) continue;
        const first = sources.find((source) => source.text.trim() !== '');
        if (first === undefined) continue;
        const locked = depthPrompts.some(
          (prompt) => prompt.injectionOrder === order && prompt.role === role && prompt.locked,
        );
        roleMessages.push({
          id: nextId(first.id),
          role,
          parts: [{ type: 'text', text: parts.join('\n') }],
          origin: first.origin,
          anchor: { slot: 'history', depth, order },
          stability: sources.reduce<Segment['stability']>(
            (acc, source) =>
              STABILITY_RANK[source.stability] > STABILITY_RANK[acc] ? source.stability : acc,
            'static',
          ),
          ...(sources.some((source) => source.volatile) ? { volatile: true } : {}),
          ...(locked ? { locked: true } : {}),
        });
      }
    }

    if (roleMessages.length > 0) {
      slots.set(depth, roleMessages.reverse());
    }
  }

  const length = historySegments.length;
  const result: Segment[] = [];
  // depth 降序：depth ≥ 历史长度的注入全都堆在最前，且 ST 里更深的排在更前面
  const slotEntries = [...slots.entries()].sort((a, b) => b[0] - a[0]);
  for (let i = 0; i <= length; i += 1) {
    for (const [depth, list] of slotEntries) {
      const position = Math.min(Math.max(length - depth, 0), length);
      if (position === i) result.push(...list);
    }
    const segment = historySegments[i];
    if (segment !== undefined) result.push(segment);
  }
  return result;
}

function roleToWiRole(role: Role): WIRole {
  return role === 'user' ? 1 : role === 'assistant' ? 2 : 0;
}

function buildHistorySegment(
  item: PreparedNode,
  isLastUser: boolean,
  namesBehavior: number,
  input: AssembleInputV2,
  onReasoningDropped: () => void,
): Segment {
  const { node } = item;
  const parts: Part[] = [];

  // 推理块回传：provider+model 匹配才放回，且放在 parts 开头
  for (const block of node.reasoning?.opaque ?? []) {
    if (block.provider === input.provider && block.model === input.model) {
      parts.push({
        type: 'reasoning_opaque',
        provider: block.provider,
        model: block.model,
        payload: block.payload,
      });
    } else {
      onReasoningDropped();
    }
  }

  // ST `setOpenAIMessages` 的 names_behavior：CONTENT 把名字写进正文，COMPLETION 才用 name 字段
  const name = node.name ?? '';
  let first = true;
  for (const part of item.parts) {
    if (part.type === 'text' && first && namesBehavior === NAMES_BEHAVIOR.CONTENT && name !== '') {
      parts.push({ type: 'text', text: `${name}: ${part.text}` });
      first = false;
      continue;
    }
    if (part.type === 'text') first = false;
    parts.push(part);
  }

  return {
    id: `history:${node.id}`,
    role: node.role,
    parts,
    ...(namesBehavior === NAMES_BEHAVIOR.COMPLETION && name !== '' ? { name } : {}),
    origin: { kind: isLastUser ? 'user_input' : 'history', ref: node.id },
    anchor: { slot: 'history', order: item.index },
    stability: isLastUser ? 'turn' : 'history',
    ...(item.volatile ? { volatile: true } : {}),
  };
}

/**
 * ST `ChatCompletion.squashSystemMessages`：把相邻的、无 name 的 system 消息用 `\n` 合并；
 * `newMainChat` / `newChat` / `groupNudge` 不参与。作用于**整条消息列表**。
 */
function squashSystem(segments: readonly Segment[]): Segment[] {
  const squashable = (segment: Segment): boolean =>
    segment.role === 'system' &&
    segment.name === undefined &&
    !SQUASH_EXCLUDED_REFS.has(segment.origin.ref ?? '') &&
    textOf(segment) !== undefined;

  const result: Segment[] = [];
  for (const segment of segments) {
    const previous = result[result.length - 1];
    if (previous !== undefined && squashable(previous) && squashable(segment)) {
      result[result.length - 1] = {
        ...previous,
        parts: [{ type: 'text', text: `${textOf(previous)}\n${textOf(segment)}` }],
        stability:
          STABILITY_RANK[segment.stability] > STABILITY_RANK[previous.stability]
            ? segment.stability
            : previous.stability,
        ...(previous.volatile || segment.volatile ? { volatile: true } : {}),
        ...(previous.locked || segment.locked ? { locked: true } : {}),
      };
      continue;
    }
    result.push(segment);
  }
  return result;
}
