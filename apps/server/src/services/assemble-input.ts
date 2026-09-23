import type { ModelCapabilities } from '@newtavern/providers';
import { and, asc, eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { NO_PRESET } from './assemble.js';
import type {
  AssembleCharacter,
  AssembleExtraInjection,
  AssembleHistoryNode,
  AssembleInputV2,
  AssemblePromptOverrides,
  RegexScript,
  WITimedState,
} from './assemble.js';
import { readAuthorsNote } from './authors-note.js';
import { collectExtraInjections } from './chat-injects.js';
import {
  nextSiblingSeq,
  pathToNode,
  readChatLorebookIds,
  type ChatOverrides,
  type ChatRow,
  type NodeRow,
} from './chat-tree.js';
import type { AssetsService } from './assets.js';
import type { LayoutMode } from './generation-context.js';
import { withTemplateRenderer } from './ejs.js';
import { resolveGlobalSystemPrompt } from './global-system-prompt.js';
import { inlineDocumentParts } from './media-inline.js';
import { toRegexScript } from './regex-map.js';
import {
  withCharacterDraft,
  withLorebookDraft,
  withPresetDraft,
  type AssembleDraft,
} from './studio-draft.js';
import { readGlobalVariables, readVariableTable } from './variables.js';
import { loadWIBooks, mapCharacterDepthPrompt } from './wi-map.js';
import { readGlobalBookIds, readWISettings } from './wi-settings.js';

/**
 * `AssembleInputV2` 的构造（M3 契约 §6 第一条）。generate / inspect / compare 共用。
 *
 * 各字段的来源：
 * - `lorebooks`：全局 `worldInfo.globalBookIds` + `chat_lorebooks` + `personas.lorebook_id` + `characters.book_id`，
 *   同名按 全局 > 聊天 > persona > 角色 去重（AS-13 / WI-11），条目映射见 `wi-map.ts`；
 * - `wiSettings`：`wi-settings.ts`，预算按 AS-7 的 `round(pct × (ctx − maxTokens) / 100) || 1`；
 * - `wiState` / `variables.chat`：沿 root→parent 路径最近的一份节点快照
 *   （`message_nodes.wi_state` / `variables`；user 节点没有快照，所以要向上找）；
 * - `variables.global`：`variables` 表（scope='global'）；
 * - `authorsNote`：`chats.metadata.authorsNote`；`characterDepthPrompt`：卡 `extensions.depth_prompt`；
 * - `globalSystemPrompt`：设置 KV + `chats.overrides` 合并后（已按 enabled / 空文本过滤）；
 * - `regexScripts`：正则表里的全局 → 预设自带 → 角色卡自带（自带的在导入时抽表），均已滤掉 disabled；
 * - `providerCaps`：`adapter.capabilities(model, conn)` 的布局相关子集；
 * - `layoutPolicy.frozenVolatile`：`chats.metadata.frozenVolatile`；
 * - `rng.seed`：`${chatId}:${parentId}:${siblingSeq}`（同一 swipe 位重新生成得到同一随机流）。
 */

/** `personas.role` → ST `extension_prompt_roles` */
const PERSONA_ROLE = { system: 0, user: 1, assistant: 2 } as const;

export interface BuildAssembleInputContext {
  chat: ChatRow;
  overrides: ChatOverrides;
  /** 该聊天的全部节点（`loadNodes` 的结果，避免重复查询） */
  nodes: NodeRow[];
  parentId: string | null;
  provider: string;
  model: string;
  layoutMode: LayoutMode;
  caps: ModelCapabilities;
  /**
   * 资产服务：提供时历史里的文档附件按 M4 §3.3 在组装前内联成文本（`media-inline.ts`）。
   * 缺省时文档 part 原样交给适配器（检查器预览显示占位）。
   */
  assets?: AssetsService;
  /** 检查器预览：不推进 WI 时间态、不产生变量副作用 */
  dryRun?: boolean;
  /**
   * 覆盖 chat 作用域变量（MVU `[InitVar]` 初始化的结果）。
   * generate 在组装前先跑一遍初始化，第一轮的提示词里
   * `{{get_message_variable::stat_data}}` 才能看到初始值。
   */
  variablesOverride?: Record<string, unknown>;
  /** 本轮新节点的兄弟序号；缺省按父节点下一个 */
  siblingSeq?: number;
  now?: Date;
  /** 工作台草稿（M6 §2.4）：代替同 id 的卡 / 预设 / 世界书，只影响本次组装，不落库 */
  draft?: AssembleDraft;
  /**
   * 本次请求临时带的注入（前端卡 `generate({injects})`，M5（三）§3.2）。
   * 会话级的 `injectPrompts` / `/inject`（`chats.metadata.injects`）总是会并进来，不用传。
   */
  extraInjections?: AssembleExtraInjection[];
  /** 前端卡 `generate({overrides})` */
  promptOverrides?: AssemblePromptOverrides;
}

/** 外接生图产生的节点（`routes/imagine.ts` 写入 `extra.generatedBy: 'image'`） */
export function isImageGenNode(node: Pick<NodeRow, 'extra'>): boolean {
  return (node.extra as { generatedBy?: unknown } | null)?.generatedBy === 'image';
}

function numberOf(
  source: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `chats.metadata.frozenVolatile`：segmentId → 冻结文本（脏数据当作没有） */
export function readFrozenVolatile(chat: ChatRow): Record<string, string> {
  const raw = (chat.metadata ?? {})['frozenVolatile'];
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * 沿 root→parent 路径**从近到远**找最近的一份 WI 时间态 / chat 变量快照。
 * 只看直接父节点不行：generate 会先插一条 user 节点，而快照只写在 assistant 节点上。
 */
export function readNearestSnapshots(path: readonly NodeRow[]): {
  wiState: WITimedState | null;
  variables: Record<string, unknown>;
} {
  let wiState: WITimedState | null = null;
  let variables: Record<string, unknown> | null = null;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    const node = path[i];
    if (!node) continue;
    if (wiState === null && node.wiState) wiState = node.wiState as unknown as WITimedState;
    // `{ $pruned: true }` 是 MVU 旧快照清理留下的占位（M5（三）§3.5），跳过它继续往上找
    if (variables === null && node.variables && node.variables.$pruned !== true) {
      variables = node.variables;
    }
    if (wiState !== null && variables !== null) break;
  }
  return { wiState, variables: variables ?? {} };
}

/**
 * 本轮要跑的正则脚本，已滤掉 disabled（契约 §4 `regexScripts`）。
 *
 * 顺序与 ST 的 `getRegexScripts` 一致：**全局 → 预设自带 → 角色卡自带**
 * （ST `SCRIPT_TYPES` 的 `Object.values` 次序就是 global/preset/scoped）。
 * 自带的脚本从表里读——导入时已抽表（`services/embedded-regex.ts`），
 * 不再直接读卡 / 预设里的 `extensions.regex_scripts`，否则同一条会跑两遍。
 */
export function readRegexScripts(
  db: Db,
  owners: { characterId?: string | undefined; presetId?: string | undefined },
) {
  const pick = (scope: 'global' | 'character' | 'preset', ownerId?: string): RegexScript[] => {
    const rows = db
      .select()
      .from(schema.regexScripts)
      .where(
        ownerId === undefined
          ? eq(schema.regexScripts.scope, scope)
          : and(eq(schema.regexScripts.scope, scope), eq(schema.regexScripts.ownerId, ownerId)),
      )
      .orderBy(asc(schema.regexScripts.displayOrder), asc(schema.regexScripts.createdAt))
      .all();
    return rows.map((row) => toRegexScript(row)).filter((script) => !script.disabled);
  };

  return [
    ...pick('global'),
    ...(owners.presetId ? pick('preset', owners.presetId) : []),
    ...(owners.characterId ? pick('character', owners.characterId) : []),
  ];
}

export function buildAssembleInput(db: Db, ctx: BuildAssembleInputContext): AssembleInputV2 {
  const { chat, nodes, parentId } = ctx;
  const characterId = chat.characterIds[0];
  const characterRow = withCharacterDraft(
    characterId
      ? db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()
      : undefined,
    ctx.draft,
  );
  const personaRow = chat.personaId
    ? db.select().from(schema.personas).where(eq(schema.personas.id, chat.personaId)).get()
    : undefined;
  const presetRow = withPresetDraft(
    chat.presetId
      ? db.select().from(schema.presets).where(eq(schema.presets.id, chat.presetId)).get()
      : undefined,
    ctx.draft,
  );

  // 组装器以 options.maxContextTokens 优先（不会再去看预设），
  // 所以这里先取「模型能力 maxContext」与「预设 openai_max_context」的较小值。
  const presetData = presetRow?.data as Record<string, unknown> | undefined;
  const presetMaxContext =
    numberOf(presetRow?.sampling, 'openai_max_context') ??
    numberOf(presetData, 'openai_max_context');
  const maxContextTokens =
    presetMaxContext !== undefined
      ? Math.min(ctx.caps.maxContext, presetMaxContext)
      : ctx.caps.maxContext;
  // ST `getMaxResponseTokens()` = `openai_max_tokens`；没有预设时算 0（WI 预算吃满上下文）
  const maxResponse =
    numberOf(presetRow?.sampling, 'openai_max_tokens') ??
    numberOf(presetData, 'openai_max_tokens') ??
    0;

  const path = parentId ? pathToNode(nodes, parentId) : [];
  // 生图节点（extra.generatedBy==='image'）默认不进提示词，它的子节点照常（M4（二）§D.2）
  const promptPath = path.filter((node) => !isImageGenNode(node));
  const history: AssembleHistoryNode[] = promptPath.map((node) => ({
    id: node.id,
    role: node.role,
    name: node.name,
    // 文本类文档与（模型不收 PDF 时）有抽取文本的 PDF 内联进正文，见 media-inline.ts
    parts: ctx.assets
      ? inlineDocumentParts((node.parts as AssembleHistoryNode['parts'] | null) ?? [], {
          caps: ctx.caps,
          assets: ctx.assets,
        })
      : ((node.parts as AssembleHistoryNode['parts'] | null) ?? []),
    // reasoning.opaque 里 provider/model 不匹配的块由 assemblePrompt 负责丢弃
    reasoning: (node.reasoning as AssembleHistoryNode['reasoning']) ?? null,
    // AS-14：isHidden（ST `is_system`）的消息由组装器整条剔除
    isHidden: node.isHidden,
  }));
  const visibleCount = history.filter((node) => node.isHidden !== true).length;

  // 快照沿路径向上找最近的一份：generate 会先插一条 user 节点（它没有快照），
  // 只看直接父节点会导致每轮 chat 变量与 WI 时间态被清空。
  const snapshots = readNearestSnapshots(path);
  const wiState = snapshots.wiState;
  const chatVariables = ctx.variablesOverride ?? snapshots.variables;

  const characterData = (characterRow?.data ?? null) as AssembleCharacter['data'] | null;
  const siblingSeq = ctx.siblingSeq ?? nextSiblingSeq(nodes, parentId);
  const frozenVolatile = readFrozenVolatile(chat);
  const extraInjections = collectExtraInjections(chat, ctx.extraInjections);

  const input: AssembleInputV2 = {
    chatId: chat.id,
    model: ctx.model,
    provider: ctx.provider,
    // 会话没选预设（或选的已删除）= 「无」：显式传 NO_PRESET（没有主提示词），
    // 不走组装器 `preset ?? DEFAULT_PRESET` 的回退
    preset: presetRow
      ? {
          id: presetRow.id,
          format: presetRow.format,
          data: presetRow.data as Record<string, unknown>,
          sampling: presetRow.sampling ?? null,
        }
      : NO_PRESET,
    character:
      characterRow && characterData
        ? { id: characterRow.id, name: characterRow.name, data: characterData }
        : null,
    persona: personaRow
      ? {
          id: personaRow.id,
          name: personaRow.name,
          description: personaRow.description,
          position: personaRow.descriptionPosition,
          depth: personaRow.depth,
          role: PERSONA_ROLE[personaRow.role],
        }
      : null,
    history,
    layoutMode: ctx.layoutMode,
    options: { maxContextTokens },
    lorebooks: withLorebookDraft(
      db,
      loadWIBooks(db, {
        globalBookIds: readGlobalBookIds(db),
        chatBookIds: readChatLorebookIds(db, chat.id),
        characterBookId: characterRow?.bookId ?? null,
        personaBookId: personaRow?.lorebookId ?? null,
      }),
      ctx.draft,
    ),
    wiSettings: readWISettings(db, { maxContext: maxContextTokens, maxResponse }),
    wiState,
    authorsNote: readAuthorsNote(chat),
    characterDepthPrompt: mapCharacterDepthPrompt(
      isRecord(characterData?.extensions) ? characterData.extensions : undefined,
    ),
    globalSystemPrompt: resolveGlobalSystemPrompt(db, ctx.overrides),
    regexScripts: readRegexScripts(db, {
      characterId,
      ...(presetRow ? { presetId: presetRow.id } : {}),
    }),
    variables: {
      chat: chatVariables,
      global: readGlobalVariables(db),
      // 角色卡变量表（酒馆助手 `{{get_character_variable::}}` 与脚本共用）
      ...(characterId ? { character: readVariableTable(db, 'character', characterId) } : {}),
      // 预设变量表（`{{get_preset_variable::}}`、前端卡 `getVariables({type:'preset'})`，M5（三）§1）
      ...(presetRow ? { preset: readVariableTable(db, 'preset', presetRow.id) } : {}),
    },
    // 会话级注入（injectPrompts / `/inject`）+ 本次请求临时带的（M5（三）§3.2）
    ...(extraInjections.length > 0 ? { extraInjections } : {}),
    ...(ctx.promptOverrides ? { promptOverrides: ctx.promptOverrides } : {}),
    messageCount: visibleCount,
    providerCaps: {
      caching: ctx.caps.caching,
      ...(ctx.caps.cacheMinTokens === undefined ? {} : { cacheMinTokens: ctx.caps.cacheMinTokens }),
      ...(ctx.caps.maxBreakpoints === undefined ? {} : { maxBreakpoints: ctx.caps.maxBreakpoints }),
      systemInMessages: ctx.caps.systemInMessages,
      prefill: ctx.caps.prefill,
    },
    layoutPolicy: {
      // strict 只告警（要与 ST 逐字节一致）；cache-aware 才真的冻结易变段以稳住前缀
      volatileHandling: ctx.layoutMode === 'cache-aware' ? 'freeze' : 'warn',
      frozenVolatile,
    },
    rng: { seed: `${chat.id}:${parentId ?? ''}:${siblingSeq}` },
    now: ctx.now ?? new Date(),
    ...(ctx.dryRun ? { dryRun: true } : {}),
  };
  // EJS 提示词模板（M5（三）§4）：设置里开着就挂渲染器
  return withTemplateRenderer(db, input);
}
