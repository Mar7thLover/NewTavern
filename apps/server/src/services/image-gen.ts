import fs from 'node:fs';
import { createRequire } from 'node:module';

import type { PromptIR, Segment } from '@newtavern/core';
import {
  getImageBackend,
  IMAGE_DEFAULT_BASE_URLS,
  isImageBackendId,
  type GenEvent,
  type ImageBackend,
  type ImageConnection,
} from '@newtavern/providers';
import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { isImageGenNode } from './assemble-input.js';
import { pathToNode, textOfParts, type ChatRow, type NodeRow } from './chat-tree.js';
import { readGenerationDefault } from './generation-context.js';
import { buildProviderRequest, type ThinkingOptions } from './provider-request.js';
import type { ProviderService } from './providers.js';

/**
 * 外接生图（docs/M4-CONTRACT.md 第二部分 §D.2）：设置、连接解析、「画最后一条消息 / 画角色」的提示词撰写。
 * 路由在 `routes/imagine.ts`；后端适配在 `packages/providers/src/image/`。
 */

/* ------------------------------------------------------------------ */
/* 设置 KV `imageGen`                                                   */
/* ------------------------------------------------------------------ */

export const IMAGE_GEN_SETTINGS_KEY = 'imageGen';

export interface ImageGenDefaults {
  width: number;
  height: number;
  steps: number;
  cfg: number;
  /** 空串 = 后端默认 */
  sampler: string;
  negative: string;
}

export interface ImageGenSettings {
  connectionId: string | null;
  model?: string;
  defaults: ImageGenDefaults;
  /** 写生图提示词用的聊天连接；缺省 = 会话连接 */
  promptWriter?: { connectionId: string; model: string };
  comfyWorkflow?: Record<string, unknown>;
  /** 拼在提示词最前面的画风串 */
  stylePrefix?: string;
}

export const DEFAULT_IMAGE_GEN_DEFAULTS: ImageGenDefaults = {
  width: 512,
  height: 768,
  steps: 28,
  cfg: 7,
  sampler: '',
  negative: '',
};

/** 尺寸边界：各后端都能接受的范围 */
export const IMAGE_SIZE_MIN = 64;
export const IMAGE_SIZE_MAX = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveNumber(value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

export function clampSize(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(IMAGE_SIZE_MIN, Math.min(IMAGE_SIZE_MAX, n));
}

export function normalizeImageGenSettings(value: unknown): ImageGenSettings {
  const raw = isRecord(value) ? value : {};
  const defaults = isRecord(raw.defaults) ? raw.defaults : {};
  const writer = isRecord(raw.promptWriter) ? raw.promptWriter : null;
  return {
    connectionId:
      typeof raw.connectionId === 'string' && raw.connectionId ? raw.connectionId : null,
    ...(typeof raw.model === 'string' && raw.model ? { model: raw.model } : {}),
    defaults: {
      width: clampSize(defaults.width, DEFAULT_IMAGE_GEN_DEFAULTS.width),
      height: clampSize(defaults.height, DEFAULT_IMAGE_GEN_DEFAULTS.height),
      steps: Math.round(positiveNumber(defaults.steps, DEFAULT_IMAGE_GEN_DEFAULTS.steps, 200)),
      cfg: positiveNumber(defaults.cfg, DEFAULT_IMAGE_GEN_DEFAULTS.cfg, 50),
      sampler: typeof defaults.sampler === 'string' ? defaults.sampler.trim() : '',
      negative: typeof defaults.negative === 'string' ? defaults.negative : '',
    },
    ...(writer &&
    typeof writer.connectionId === 'string' &&
    writer.connectionId &&
    typeof writer.model === 'string' &&
    writer.model
      ? { promptWriter: { connectionId: writer.connectionId, model: writer.model } }
      : {}),
    ...(isRecord(raw.comfyWorkflow) ? { comfyWorkflow: raw.comfyWorkflow } : {}),
    ...(typeof raw.stylePrefix === 'string' && raw.stylePrefix.trim()
      ? { stylePrefix: raw.stylePrefix.trim() }
      : {}),
  };
}

export function readImageGenSettings(db: Db): ImageGenSettings {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, IMAGE_GEN_SETTINGS_KEY))
    .get();
  return normalizeImageGenSettings(row?.value);
}

/* ------------------------------------------------------------------ */
/* 连接                                                                 */
/* ------------------------------------------------------------------ */

/** 路由直接把它转成 HTTP 错误响应 */
export class ImageGenError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImageGenError';
  }
}

export interface ResolvedImageConnection {
  row: typeof schema.connections.$inferSelect;
  conn: ImageConnection;
  backend: ImageBackend;
}

/** 解析生图连接：解密 Key（与对话连接同一套轮换计数）、查出后端 */
export function resolveImageConnection(
  db: Db,
  providers: ProviderService,
  id: string,
): ResolvedImageConnection {
  const row = db.select().from(schema.connections).where(eq(schema.connections.id, id)).get();
  if (!row) throw new ImageGenError(404, 'not_found', `生图连接不存在：${id}`);
  if (!isImageBackendId(row.provider)) {
    throw new ImageGenError(400, 'not_image_backend', `「${row.label || id}」不是生图后端`);
  }
  const apiKey = providers.nextApiKey(row);
  const conn: ImageConnection = {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl || IMAGE_DEFAULT_BASE_URLS[row.provider],
    ...(apiKey ? { apiKey } : {}),
    ...(row.headers ? { headers: row.headers } : {}),
    ...(row.proxy ? { proxy: row.proxy } : {}),
    ...(row.label ? { label: row.label } : {}),
  };
  return { row, conn, backend: getImageBackend(row.provider) };
}

/* ------------------------------------------------------------------ */
/* 生图节点                                                             */
/* ------------------------------------------------------------------ */

/** 生图节点：`extra.generatedBy === 'image'`（组装时跳过，判定写在 assemble-input.ts） */
export { isImageGenNode };

/* ------------------------------------------------------------------ */
/* 提示词撰写（last_message / character）                                */
/* ------------------------------------------------------------------ */

export type ImagineMode = 'free' | 'last_message' | 'character';
export type PromptLanguage = 'zh-CN' | 'en';

const require = createRequire(import.meta.url);
const templateCache = new Map<PromptLanguage, Record<'last_message' | 'character', string>>();

/** `packages/i18n/prompts/imagine.<lang>.md`：按 `## last_message` / `## character` 切段 */
export function loadImagineTemplates(
  lang: PromptLanguage,
): Record<'last_message' | 'character', string> {
  const cached = templateCache.get(lang);
  if (cached) return cached;
  const file = require.resolve(`@newtavern/i18n/prompts/imagine.${lang}.md`);
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const sections: Record<string, string> = {};
  let current: string | null = null;
  const lines: string[] = [];
  const flush = () => {
    if (current) sections[current] = lines.join('\n').trim();
    lines.length = 0;
  };
  for (const line of text.split('\n')) {
    const heading = /^##\s+([a-z_]+)\s*$/.exec(line);
    if (heading?.[1]) {
      flush();
      current = heading[1];
    } else if (current) {
      lines.push(line);
    }
  }
  flush();
  const templates = {
    last_message: sections.last_message ?? '',
    character: sections.character ?? '',
  };
  templateCache.set(lang, templates);
  return templates;
}

/** 正文里只留看得见的叙述：去掉代码块、HTML、多余空白，截最后 n 字 */
export function visibleText(text: string, limit: number): string {
  const cleaned = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > limit ? chars.slice(chars.length - limit).join('') : cleaned;
}

function applyNames(text: string, names: { char: string; user: string }): string {
  return text.replace(/\{\{char\}\}/gi, names.char).replace(/\{\{user\}\}/gi, names.user);
}

export interface WriterContext {
  mode: 'last_message' | 'character';
  chat: ChatRow;
  nodes: NodeRow[];
  parentId: string | null;
  lang: PromptLanguage;
}

/** 构造撰写提示词的 IR：system = 模板，user = 素材（最近几条消息 / 角色资料） */
export function buildWriterIr(db: Db, ctx: WriterContext, model: string): PromptIR {
  const characterId = ctx.chat.characterIds[0];
  const characterRow = characterId
    ? db.select().from(schema.characters).where(eq(schema.characters.id, characterId)).get()
    : undefined;
  const personaRow = ctx.chat.personaId
    ? db.select().from(schema.personas).where(eq(schema.personas.id, ctx.chat.personaId)).get()
    : undefined;
  const names = { char: characterRow?.name ?? 'Character', user: personaRow?.name ?? 'User' };
  const template = applyNames(loadImagineTemplates(ctx.lang)[ctx.mode], names);

  let material: string;
  if (ctx.mode === 'character') {
    const data = (characterRow?.data ?? {}) as Record<string, unknown>;
    const field = (key: string, limit: number) =>
      typeof data[key] === 'string' && data[key]
        ? visibleText(applyNames(data[key], names), limit)
        : '';
    const blocks = [
      `Name: ${names.char}`,
      field('description', 4000) && `Description:\n${field('description', 4000)}`,
      field('personality', 800) && `Personality:\n${field('personality', 800)}`,
      field('scenario', 800) && `Scenario:\n${field('scenario', 800)}`,
    ].filter(Boolean);
    if (!characterRow) {
      throw new ImageGenError(400, 'no_character', '这个会话没有角色，不能「画角色」');
    }
    material = blocks.join('\n\n');
  } else {
    const path = ctx.parentId ? pathToNode(ctx.nodes, ctx.parentId) : [];
    const messages = path
      .filter((node) => !node.isHidden && !isImageGenNode(node) && node.role !== 'system')
      .map((node) => ({
        name: node.role === 'user' ? (node.name ?? names.user) : (node.name ?? names.char),
        text: visibleText(textOfParts((node.parts as never) ?? []), 1500),
      }))
      .filter((message) => message.text !== '');
    if (messages.length === 0) {
      throw new ImageGenError(400, 'no_message', '还没有可以描绘的消息');
    }
    const recent = messages.slice(-4);
    const last = recent[recent.length - 1] as { name: string; text: string };
    material = [
      ...recent.slice(0, -1).map((message) => `${message.name}: ${message.text}`),
      `[Last message]\n${last.name}: ${last.text}`,
    ].join('\n\n');
  }

  const segment = (id: string, role: 'system' | 'user', text: string, order: number): Segment => ({
    id,
    role,
    parts: [{ type: 'text', text }],
    origin: { kind: 'injection', ref: 'imagine' },
    anchor: { slot: role === 'system' ? 'system' : 'history', order },
    stability: role === 'system' ? 'static' : 'turn',
  });
  return {
    model,
    sampling: { maxTokens: 400, temperature: 0.6 },
    segments: [
      segment('imagine_instructions', 'system', template, 0),
      segment('imagine_material', 'user', material, 1),
    ],
    cachePlan: { breakpoints: [] },
    meta: {
      chatId: ctx.chat.id,
      presetId: '',
      layoutMode: 'strict',
      activations: [],
      warnings: [],
      tokenEstimate: 0,
    },
  };
}

/**
 * 模型回复 → 可直接给生图后端的一行关键词：去代码块、引号、推理标签，换行变逗号，折叠空白与重复逗号。
 * 不做 ST 那种「只留 ASCII」的清洗——用户可能真的想要非英文提示词（NovelAI 之外的后端都认）。
 */
export function cleanImagePrompt(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/```[a-z]*\n?|```/gi, ' ')
    .replace(/^\s*(prompt|keywords|tags)\s*[:：]\s*/i, '')
    .replace(/["“”`]/g, '')
    .replace(/\s*\n+\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .split(',')
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .join(', ')
    .trim();
}

/* 一次性调用：优先用 M6 §1.5 的 callLlm（F1），未交付时直接走适配器 */

interface LlmResultLike {
  text: string;
  error?: { message: string; kind?: string };
}

type CallLlm = (
  db: Db,
  dataDir: string,
  input: {
    connectionId: string;
    model: string;
    ir: PromptIR;
    thinking?: ThinkingOptions;
    signal?: AbortSignal;
  },
) => Promise<LlmResultLike>;

let callLlmPromise: Promise<CallLlm | null> | null = null;

function loadCallLlm(): Promise<CallLlm | null> {
  callLlmPromise ??= (async () => {
    try {
      // 变量说明符：llm.ts（F1）交付前不存在，类型检查与打包都不该因此失败
      const specifier = './llm.js';
      const mod = (await import(/* @vite-ignore */ specifier)) as { callLlm?: unknown };
      return typeof mod.callLlm === 'function' ? (mod.callLlm as CallLlm) : null;
    } catch {
      return null;
    }
  })();
  return callLlmPromise;
}

async function directCall(
  providers: ProviderService,
  input: { connectionId: string; model: string; ir: PromptIR; signal: AbortSignal },
): Promise<LlmResultLike> {
  const resolved = await providers.resolveConnection(input.connectionId);
  const request = buildProviderRequest(resolved.adapter, input.ir, resolved.conn, input.model, {
    enabled: false,
  });
  let text = '';
  let error: LlmResultLike['error'];
  const stream = resolved.adapter.stream(
    resolved.conn,
    request,
    input.signal,
  ) as AsyncIterable<GenEvent>;
  for await (const event of stream) {
    if (event.type === 'text.delta') text += event.text;
    else if (event.type === 'error')
      error = { message: event.error.message, kind: event.error.kind };
  }
  return { text, ...(error ? { error } : {}) };
}

/** 撰写提示词用的聊天连接：设置里的 promptWriter > 会话覆盖 > 全局默认 */
export function resolveWriterTarget(
  db: Db,
  chat: ChatRow,
  settings: ImageGenSettings,
): { connectionId: string; model: string } {
  if (settings.promptWriter) return settings.promptWriter;
  const overrides = (chat.overrides ?? {}) as { connectionId?: unknown; model?: unknown };
  const fallback = readGenerationDefault(db);
  const connectionId =
    typeof overrides.connectionId === 'string' && overrides.connectionId
      ? overrides.connectionId
      : fallback.connectionId;
  const model =
    typeof overrides.model === 'string' && overrides.model ? overrides.model : fallback.model;
  if (!connectionId || !model) {
    throw new ImageGenError(400, 'no_writer', '没有可用来写提示词的对话连接与模型');
  }
  return { connectionId, model };
}

export async function writeImagePrompt(
  db: Db,
  dataDir: string,
  providers: ProviderService,
  input: { connectionId: string; model: string; ir: PromptIR; signal: AbortSignal },
): Promise<string> {
  const callLlm = await loadCallLlm();
  const result = callLlm
    ? await callLlm(db, dataDir, { ...input, thinking: { enabled: false } })
    : await directCall(providers, input);
  const prompt = cleanImagePrompt(result.text);
  if (prompt === '') {
    throw new Error(
      result.error ? `写生图提示词失败：${result.error.message}` : '模型没有写出生图提示词',
    );
  }
  return prompt;
}
