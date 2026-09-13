/**
 * 最小组装流水线（M2）：ST Chat Completion 预设 + 角色卡 + Persona + 历史 → PromptIR。
 *
 * 行为参照 SillyTavern 1.18 `public/scripts/openai.js`
 * （`preparePromptsForChatCompletion` / `populateChatCompletion` / `populateChatHistory` /
 * `populateDialogueExamples` / `populationInjectionPrompts` / `ChatCompletion.squashSystemMessages`）
 * 与 `public/scripts/PromptManager.js`。世界书、作者注释、正则、变量留到 M3。
 *
 * 契约见 docs/M2-CONTRACT.md §2；与 ST 的已知偏差记在该文件 §5。
 */

import { substituteMacrosDetailed, type MacroContext } from '../macros/engine.js';
import { estimateTokens } from '../tokenizer.js';
import { type Part, type PromptIR, type Role, type SamplingParams, type Segment } from './ir.js';

// ───────────────────────── 输入类型（契约 §2） ─────────────────────────

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

export interface AssemblePersona {
  id?: string;
  name: string;
  description: string;
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
  /** M2 两者输出相同段序；仅 cachePlan 不同 */
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

// ───────────────────────── 内置默认预设（契约 §2.3） ─────────────────────────

/** 通用角色扮演系统提示词：中英双语各一段，尽量短，避免与用户预设打架 */
const DEFAULT_MAIN_PROMPT = [
  "You are {{char}} in a collaborative fiction with {{user}}. Stay in character and write only {{char}}'s speech, actions and inner life — never speak, act or decide for {{user}}.",
  'Follow the character sheet, scenario and example dialogue above; keep their tone, advance the scene with concrete sensory detail, and end on an opening for {{user}} to respond.',
  '你在与 {{user}} 共同创作虚构故事，扮演 {{char}}。请始终保持角色，只书写 {{char}} 的言语、行动与内心，绝不替 {{user}} 发言、行动或做决定。',
  '遵循上文的角色设定、场景与示例对话，保持其语气，用具体可感的细节推进剧情，并在结尾为 {{user}} 留下回应的空间。',
].join('\n');

const DEFAULT_PRESET_IDENTIFIERS = [
  'main',
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
  'dialogueExamples',
  'chatHistory',
];

/** 未导入任何 ST 预设时使用；native 只是 st-openai 的子集，走同一套展开逻辑 */
export const DEFAULT_PRESET: AssemblePreset = {
  id: 'builtin:default',
  format: 'native',
  data: {
    prompts: [
      { identifier: 'main', name: 'Main Prompt', role: 'system', content: DEFAULT_MAIN_PROMPT },
      { identifier: 'charDescription', name: 'Char Description', marker: true },
      { identifier: 'charPersonality', name: 'Char Personality', marker: true },
      { identifier: 'scenario', name: 'Scenario', marker: true },
      { identifier: 'personaDescription', name: 'Persona Description', marker: true },
      { identifier: 'dialogueExamples', name: 'Chat Examples', marker: true },
      { identifier: 'chatHistory', name: 'Chat History', marker: true },
    ],
    prompt_order: [
      {
        character_id: 100001,
        order: DEFAULT_PRESET_IDENTIFIERS.map((identifier) => ({ identifier, enabled: true })),
      },
    ],
    // 与 ST 同名的格式串；new_chat_prompt 留空表示不插入「[Start a new Chat]」分隔
    personality_format: '{{personality}}',
    scenario_format: '{{scenario}}',
    new_chat_prompt: '',
    new_example_chat_prompt: '[Example Chat]',
    squash_system_messages: false,
    temperature: 1,
    openai_max_tokens: 4096,
    openai_max_context: 128000,
  },
};

// ───────────────────────── 内部工具 ─────────────────────────

/** ST PromptManager：injection_position 的取值 */
const INJECTION_POSITION_ABSOLUTE = 1;
/** ST PromptManager：DEFAULT_DEPTH / DEFAULT_ORDER */
const DEFAULT_INJECTION_DEPTH = 4;
const DEFAULT_INJECTION_ORDER = 100;

/** ST 全局 prompt_order 的 dummy character_id；100001 优先于 100000 */
const PROMPT_ORDER_DUMMY_IDS = ['100001', '100000'];

/** 深度注入在同一 depth 内的角色次序（越靠后越贴近本轮，ST 认为越重要） */
const INJECTION_ROLE_RANK: Record<Role, number> = { assistant: 0, user: 1, system: 2 };

const STABILITY_RANK: Record<Segment['stability'], number> = {
  static: 0,
  session: 1,
  history: 2,
  turn: 3,
};

/** 参与 squash 时需要跳过的段（对应 ST 的 excludeList：newMainChat / newChat / groupNudge） */
const SQUASH_EXCLUDED_REFS = new Set(['new_chat_prompt', 'new_example_chat_prompt']);

/** ST 预设采样键 → SamplingParams 字段（全部为数值） */
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

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return i;
  }
  return -1;
}

/** 预设里的一条 prompt（从宽松 JSON 收窄） */
interface PresetPrompt {
  identifier: string;
  marker: boolean;
  role: Role;
  content: string;
  injectionPosition?: number;
  injectionDepth: number;
  injectionOrder: number;
  forbidOverrides: boolean;
  /** 被角色卡覆盖时，原预设内容（供 {{original}} 使用） */
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
    prompts.push({
      identifier,
      marker: item.marker === true,
      role: readRole(item.role),
      content: readString(item.content) ?? '',
      injectionPosition: readNumber(item.injection_position),
      injectionDepth: readNumber(item.injection_depth) ?? DEFAULT_INJECTION_DEPTH,
      injectionOrder: readNumber(item.injection_order) ?? DEFAULT_INJECTION_ORDER,
      forbidOverrides: item.forbid_overrides === true,
    });
  }
  return prompts;
}

/** 取 prompt_order：100001（ST 全局 dummy）优先，其次 100000，其次首个 */
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

// ───────────────────────── 主流程 ─────────────────────────

export function assemblePrompt(input: AssembleInput): PromptIR {
  const preset = input.preset ?? DEFAULT_PRESET;
  const data = preset.data;
  const options = input.options ?? {};
  const preferCharacterPrompt = options.preferCharacterPrompt ?? true;
  const warnings: string[] = [];

  // ── 宏上下文：角色卡字段先各自宏替换一遍（对应 ST 的 baseChatReplace）
  const seedCtx: MacroContext = {
    char: input.character?.name ?? '',
    user: input.persona?.name ?? '',
    now: options.now,
  };
  const cardData = input.character?.data ?? {};
  const description = substituteMacrosDetailed(readString(cardData.description) ?? '', seedCtx);
  const personality = substituteMacrosDetailed(readString(cardData.personality) ?? '', seedCtx);
  const scenario = substituteMacrosDetailed(readString(cardData.scenario) ?? '', seedCtx);
  const mesExamples = substituteMacrosDetailed(readString(cardData.mes_example) ?? '', seedCtx);
  const personaDescription = substituteMacrosDetailed(input.persona?.description ?? '', seedCtx);

  const ctx: MacroContext = {
    ...seedCtx,
    persona: personaDescription.text,
    description: description.text,
    personality: personality.text,
    scenario: scenario.text,
    mesExamples: mesExamples.text,
  };

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

  // ── 段构造
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

  /** 一段纯文本的系统槽段；内容（trim 后）为空则不产生段 */
  const addTextSegment = (
    idBase: string,
    role: Role,
    value: { text: string; volatile: boolean },
    origin: Segment['origin'],
    stability: Segment['stability'],
  ): void => {
    if (value.text.trim() === '') return;
    addSystemSegment({
      id: nextId(idBase),
      role,
      parts: [{ type: 'text', text: value.text }],
      origin,
      stability,
      ...(value.volatile ? { volatile: true } : {}),
    });
  };

  // 深度注入先整体收集（ST 在 populateChatHistory 之前算好 absolutePrompts）
  const injections = resolved.filter(
    (prompt) => prompt.injectionPosition === INJECTION_POSITION_ABSOLUTE,
  );

  for (const prompt of resolved) {
    if (prompt.injectionPosition === INJECTION_POSITION_ABSOLUTE) continue;

    if (prompt.marker) {
      switch (prompt.identifier) {
        case 'charDescription':
          addTextSegment(
            'character:description',
            'system',
            description,
            { kind: 'character', ref: 'description' },
            'static',
          );
          break;
        case 'charPersonality':
          addTextSegment(
            'character:personality',
            'system',
            formatField(personality, readString(data.personality_format) ?? '{{personality}}', ctx),
            { kind: 'character', ref: 'personality' },
            'static',
          );
          break;
        case 'scenario':
          addTextSegment(
            'character:scenario',
            'system',
            formatField(scenario, readString(data.scenario_format) ?? '{{scenario}}', ctx),
            { kind: 'character', ref: 'scenario' },
            'static',
          );
          break;
        case 'personaDescription':
          addTextSegment('persona', 'system', personaDescription, { kind: 'persona' }, 'static');
          break;
        case 'dialogueExamples':
          for (const block of splitDialogueExamples(mesExamples.text)) {
            addTextSegment(
              'preset:newExampleChat',
              'system',
              substituteMacrosDetailed(
                readString(data.new_example_chat_prompt) ?? '[Example Chat]',
                ctx,
              ),
              { kind: 'preset', ref: 'new_example_chat_prompt' },
              'static',
            );
            addTextSegment(
              'character:mes_example',
              'system',
              { text: block, volatile: mesExamples.volatile },
              { kind: 'character', ref: 'mes_example' },
              'static',
            );
          }
          break;
        case 'chatHistory':
          // [Start a new Chat]：ST 把它放在历史最前（identifier newMainChat）
          addTextSegment(
            'preset:newMainChat',
            'system',
            substituteMacrosDetailed(readString(data.new_chat_prompt) ?? '[Start a new Chat]', ctx),
            { kind: 'preset', ref: 'new_chat_prompt' },
            'static',
          );
          segments.push(
            ...buildHistory({
              input,
              ctx,
              injections,
              nextId,
              onReasoningDropped: () => {
                droppedReasoning = true;
              },
            }),
          );
          break;
        default:
          // worldInfoBefore / worldInfoAfter 等：M3 之前不产生段
          break;
      }
      continue;
    }

    addTextSegment(
      `preset:${prompt.identifier}`,
      prompt.role,
      substituteMacrosDetailed(prompt.content, promptCtx(ctx, prompt)),
      { kind: 'preset', ref: prompt.identifier },
      'static',
    );
  }

  if (droppedReasoning) {
    warnings.push('部分推理块因 provider/模型切换被丢弃');
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

  // ── 历史裁剪（契约 §2.1-8）
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
  const finalSegments = data.squash_system_messages === true ? squashSystem(segments) : segments;

  // ── cachePlan（契约 §2.1-10）
  const breakpoints: number[] = [];
  const lastStatic = findLastIndex(finalSegments, (segment) => segment.stability === 'static');
  if (lastStatic >= 0) breakpoints.push(lastStatic);
  const historyIndexes = finalSegments.reduce<number[]>((acc, segment, index) => {
    if (segment.origin.kind === 'history' || segment.origin.kind === 'user_input') acc.push(index);
    return acc;
  }, []);
  const secondLastHistory = historyIndexes[historyIndexes.length - 2];
  if (secondLastHistory !== undefined) breakpoints.push(secondLastHistory);

  return {
    model: input.model,
    sampling,
    segments: finalSegments,
    cachePlan: { breakpoints: [...new Set(breakpoints)].sort((a, b) => a - b) },
    meta: {
      chatId: input.chatId,
      presetId: input.preset?.id ?? DEFAULT_PRESET.id,
      layoutMode: input.layoutMode ?? 'strict',
      activations: [],
      warnings,
      tokenEstimate: finalSegments.reduce((sum, segment) => sum + segmentTokens(segment), 0),
    },
  };
}

// ───────────────────────── 子过程 ─────────────────────────

/** 角色卡 system_prompt / post_history_instructions 覆盖 main / jailbreak（契约 §2.1-5） */
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

/** 被覆盖的 prompt 额外提供 {{original}} */
function promptCtx(ctx: MacroContext, prompt: PresetPrompt): MacroContext {
  return prompt.original === undefined ? ctx : { ...ctx, original: prompt.original };
}

/**
 * ST：`charPersonality`/`scenario` 走 `personality_format`/`scenario_format`；
 * 字段本身为空则整段为空，格式串为空则退回字段原文。
 */
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
 * 按 `<START>` 切块（ST `parseExampleIntoIndividual` 的上游切分）。
 * 不含 `<START>` 时整体视为一块；空块丢弃。
 */
function splitDialogueExamples(mesExamples: string): string[] {
  let text = mesExamples.trim();
  if (text === '') return [];
  if (!/^<START>/i.test(text)) text = `<START>\n${text}`;
  return text
    .split(/<START>/gi)
    .slice(1)
    .map((block) => block.trim())
    .filter((block) => block !== '');
}

interface BuildHistoryArgs {
  input: AssembleInput;
  ctx: MacroContext;
  injections: PresetPrompt[];
  nextId: (base: string) => string;
  onReasoningDropped: () => void;
}

/** 历史段 + 深度注入（契约 §2.1-3 的 chatHistory 分支） */
function buildHistory(args: BuildHistoryArgs): Segment[] {
  const { input, ctx, injections, nextId, onReasoningDropped } = args;
  const visible = input.history.filter((node) => node.isHidden !== true);
  const lastUserIndex = findLastIndex(visible, (node) => node.role === 'user');

  const historySegments = visible.map((node, index) =>
    buildHistorySegment(node, index, index === lastUserIndex, input, ctx, onReasoningDropped),
  );

  // 深度注入：depth 0 = 最后一条之后；depth n = 倒数第 n 条之前；超出历史长度则放最前
  const slots: Segment[][] = Array.from({ length: visible.length + 1 }, () => []);
  const ordered = injections
    .map((prompt, index) => ({ prompt, index }))
    .filter(({ prompt }) => prompt.content.trim() !== '')
    .sort(
      (a, b) =>
        a.prompt.injectionOrder - b.prompt.injectionOrder ||
        INJECTION_ROLE_RANK[a.prompt.role] - INJECTION_ROLE_RANK[b.prompt.role] ||
        a.index - b.index,
    );

  for (const { prompt } of ordered) {
    const substituted = substituteMacrosDetailed(prompt.content, ctx);
    const text = substituted.text.trim();
    if (text === '') continue;
    const depth = Math.max(0, prompt.injectionDepth);
    const position = Math.min(Math.max(visible.length - depth, 0), visible.length);
    const slot = slots[position];
    if (slot === undefined) continue;
    slot.push({
      id: nextId(`injection:${prompt.identifier}`),
      role: prompt.role,
      parts: [{ type: 'text', text }],
      origin: { kind: 'injection', ref: prompt.identifier },
      anchor: { slot: 'history', depth, order: prompt.injectionOrder },
      stability: 'turn',
      ...(substituted.volatile ? { volatile: true } : {}),
    });
  }

  const result: Segment[] = [];
  for (let i = 0; i < historySegments.length; i += 1) {
    const segment = historySegments[i];
    result.push(...(slots[i] ?? []));
    if (segment !== undefined) result.push(segment);
  }
  result.push(...(slots[visible.length] ?? []));
  return result;
}

function buildHistorySegment(
  node: AssembleHistoryNode,
  index: number,
  isLastUser: boolean,
  input: AssembleInput,
  ctx: MacroContext,
  onReasoningDropped: () => void,
): Segment {
  const parts: Part[] = [];
  let volatile = false;

  // 推理块回传（契约 §2.1-12）：provider+model 匹配才放回，且放在 parts 开头
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

  for (const part of node.parts) {
    if (part.type !== 'text') {
      // image / document / 已有的 reasoning_opaque 原样保留
      parts.push(part);
      continue;
    }
    // ST 对历史消息同样执行 substituteParams（populateChatHistory → preparePrompt）
    const substituted = substituteMacrosDetailed(part.text, ctx);
    volatile ||= substituted.volatile;
    parts.push({ type: 'text', text: substituted.text });
  }

  return {
    id: `history:${node.id}`,
    role: node.role,
    parts,
    ...(node.name ? { name: node.name } : {}),
    origin: { kind: isLastUser ? 'user_input' : 'history', ref: node.id },
    anchor: { slot: 'history', order: index },
    stability: isLastUser ? 'turn' : 'history',
    ...(volatile ? { volatile: true } : {}),
  };
}

/**
 * ST `ChatCompletion.squashSystemMessages`：把相邻的、无 name 的 system 消息用 `\n` 合并；
 * `newMainChat` / `newChat` 等分隔消息不参与。注意 ST 是在**整条消息列表**上做的，
 * 历史里的 system 消息与深度注入同样会被卷入。
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
      };
      continue;
    }
    result.push(segment);
  }
  return result;
}
