import type { PromptIR, Segment } from '@newtavern/core';
import type { GenEvent } from '@newtavern/providers';
import { eq } from 'drizzle-orm';

import { loadChat, loadNodes } from './chat-tree.js';
import { readGenerationDefault } from './generation-context.js';
import { buildProviderRequest, type ThinkingOptions } from './provider-request.js';
import type { ProviderService } from './providers.js';
import { listSprites, normalizeSpriteLabel } from './sprites.js';
import { schema, type Db } from '../db/client.js';

/**
 * 表情选择（M4（二）契约 §B.2）：手动指定，或用一次短调用把节点正文分类到该角色已有立绘的标签上。
 * 结果写进节点 `extra.expression`。
 */

export const SPRITES_SETTINGS_KEY = 'sprites';

export type SpriteMode = 'off' | 'classify' | 'manual';

export interface SpriteSettings {
  mode: SpriteMode;
  connectionId?: string;
  model?: string;
  /** 分类失败 / 角色没有立绘时用的标签 */
  fallback: string;
}

export const DEFAULT_SPRITE_SETTINGS: SpriteSettings = { mode: 'classify', fallback: 'neutral' };

export function readSpriteSettings(db: Db): SpriteSettings {
  const value = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, SPRITES_SETTINGS_KEY))
    .get()?.value as Record<string, unknown> | null | undefined;
  if (!value || typeof value !== 'object') return { ...DEFAULT_SPRITE_SETTINGS };
  const mode = value['mode'];
  return {
    mode: mode === 'off' || mode === 'manual' || mode === 'classify' ? mode : 'classify',
    ...(typeof value['connectionId'] === 'string' && value['connectionId']
      ? { connectionId: value['connectionId'] }
      : {}),
    ...(typeof value['model'] === 'string' && value['model'] ? { model: value['model'] } : {}),
    fallback: normalizeSpriteLabel(value['fallback']) ?? DEFAULT_SPRITE_SETTINGS.fallback,
  };
}

export class ExpressionError extends Error {
  constructor(
    readonly status: 400 | 404,
    message: string,
  ) {
    super(message);
  }
}

/** 分类只看正文：去掉代码块与 HTML，截最后 1500 字 */
export function expressionSourceText(parts: unknown): string {
  const list = Array.isArray(parts) ? parts : [];
  const text = list
    .map((part) =>
      part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
        ? String((part as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n');
  const cleaned = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > 1500 ? chars.slice(chars.length - 1500).join('') : cleaned;
}

/** 从模型回复里认出标签：先当 JSON 读 `label`，再找第一个出现的已知标签 */
export function parseExpressionReply(text: string, labels: readonly string[]): string | null {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const json = /\{[\s\S]*\}/.exec(trimmed)?.[0];
  if (json) {
    try {
      const value = (JSON.parse(json) as { label?: unknown }).label;
      if (typeof value === 'string') candidates.push(value);
    } catch {
      // 不是 JSON：往下按纯文本找
    }
  }
  candidates.push(trimmed.replace(/^["'`]+|["'`.。！!]+$/g, ''));
  for (const candidate of candidates) {
    const label = normalizeSpriteLabel(candidate);
    if (label && labels.includes(label)) return label;
  }
  const lower = trimmed.toLowerCase();
  let best: { label: string; at: number } | null = null;
  for (const label of labels) {
    const at = lower.indexOf(label.toLowerCase());
    if (at >= 0 && (best === null || at < best.at)) best = { label, at };
  }
  return best?.label ?? null;
}

/* ------------------------------------------------------------------ */
/* 一次性调用：优先用 M6 §1.5 的 callLlm，F1 未交付时退回直接走适配器        */
/* ------------------------------------------------------------------ */

interface LlmResultLike {
  text: string;
  toolCalls?: { parsed?: unknown; args?: string }[];
  error?: { message: string };
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

/** `services/llm.ts`（F1）存在就用它（写 generation_log、结构化输出降级）；不存在返回 null */
function loadCallLlm(): Promise<CallLlm | null> {
  callLlmPromise ??= (async () => {
    try {
      // 变量说明符：F1 交付前 llm.ts 不存在，类型检查与打包都不该因此失败
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
  const args: string[] = [];
  let error: { message: string } | undefined;
  for await (const event of resolved.adapter.stream(resolved.conn, request, input.signal) as AsyncIterable<GenEvent>) {
    if (event.type === 'text.delta') text += event.text;
    else if (event.type === 'tool.call') args.push(event.argsDelta);
    else if (event.type === 'error') error = { message: event.error.message };
  }
  return {
    text,
    ...(args.length > 0 ? { toolCalls: [{ args: args.join('') }] } : {}),
    ...(error ? { error } : {}),
  };
}

function classifierIr(chatId: string, model: string, labels: string[], text: string): PromptIR {
  const system: Segment = {
    id: 'expression_system',
    role: 'system',
    parts: [
      {
        type: 'text',
        text:
          'You label the emotion a roleplay character shows in the message below.\n' +
          `Pick exactly one label from this list: ${labels.join(', ')}.\n` +
          'Answer with JSON only: {"label": "<one of the labels>"}',
      },
    ],
    origin: { kind: 'injection', ref: 'expression' },
    anchor: { slot: 'system', order: 0 },
    stability: 'static',
  };
  const user: Segment = {
    id: 'expression_message',
    role: 'user',
    parts: [{ type: 'text', text }],
    origin: { kind: 'injection', ref: 'expression' },
    anchor: { slot: 'history', order: 1 },
    stability: 'turn',
  };
  const ir: PromptIR & {
    responseFormat?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  } = {
    model,
    sampling: { maxTokens: 32, temperature: 0 },
    segments: [system, user],
    cachePlan: { breakpoints: [] },
    meta: {
      chatId,
      presetId: '',
      layoutMode: 'strict',
      activations: [],
      warnings: [],
      tokenEstimate: 0,
    },
    // M6 §1.1 的结构化输出；F1 交付前适配器不认这个字段，靠系统提示词里的 JSON 约定兜底
    responseFormat: {
      name: 'expression',
      schema: {
        type: 'object',
        properties: { label: { type: 'string', enum: labels } },
        required: ['label'],
        additionalProperties: false,
      },
      strict: true,
    },
  };
  return ir;
}

export interface ChooseExpressionInput {
  chatId: string;
  nodeId: string;
  /** 带了 = 手动指定 */
  label?: unknown;
  signal?: AbortSignal;
}

/** 选表情并写进节点 `extra.expression`；返回 `{ label }` */
export async function chooseExpression(
  db: Db,
  dataDir: string,
  providers: ProviderService,
  input: ChooseExpressionInput,
): Promise<{ label: string; source: 'manual' | 'classify' | 'fallback' }> {
  const chat = loadChat(db, input.chatId);
  if (!chat) throw new ExpressionError(404, '会话不存在');
  const node = loadNodes(db, chat.id).find((row) => row.id === input.nodeId);
  if (!node) throw new ExpressionError(404, '节点不存在');
  const settings = readSpriteSettings(db);

  let label: string;
  let source: 'manual' | 'classify' | 'fallback';
  if (input.label !== undefined && input.label !== null) {
    const manual = normalizeSpriteLabel(input.label);
    if (!manual) throw new ExpressionError(400, '表情标签不合法');
    label = manual;
    source = 'manual';
  } else {
    const characterId = chat.characterIds?.[0];
    const labels = characterId ? listSprites(db, characterId).map((sprite) => sprite.label) : [];
    const text = expressionSourceText(node.parts);
    const picked =
      labels.length > 0 && text !== '' && settings.mode !== 'off'
        ? await classify(db, dataDir, providers, {
            chatId: chat.id,
            overrides: chat.overrides ?? null,
            settings,
            labels,
            text,
            signal: input.signal,
          })
        : null;
    label = picked ?? settings.fallback;
    source = picked ? 'classify' : 'fallback';
  }

  db.update(schema.messageNodes)
    .set({ extra: { ...(node.extra ?? {}), expression: label } })
    .where(eq(schema.messageNodes.id, node.id))
    .run();
  return { label, source };
}

async function classify(
  db: Db,
  dataDir: string,
  providers: ProviderService,
  input: {
    chatId: string;
    overrides: { connectionId?: string | null; model?: string | null } | null;
    settings: SpriteSettings;
    labels: string[];
    text: string;
    signal: AbortSignal | undefined;
  },
): Promise<string | null> {
  const fallback = readGenerationDefault(db);
  // 设置里配了专用连接就用它；没配用会话当前连接（会话覆盖 → 全局默认）
  const connectionId =
    input.settings.connectionId ?? input.overrides?.connectionId ?? fallback.connectionId;
  const model = input.settings.model ?? input.overrides?.model ?? fallback.model;
  if (!connectionId || !model) return null;

  const ir = classifierIr(input.chatId, model, input.labels, input.text);
  const signal = input.signal ?? AbortSignal.timeout(30_000);
  try {
    const callLlm = await loadCallLlm();
    const result = callLlm
      ? await callLlm(db, dataDir, { connectionId, model, ir, thinking: { enabled: false }, signal })
      : await directCall(providers, { connectionId, model, ir, signal });
    const fromTool = result.toolCalls?.[0];
    if (fromTool) {
      const parsed = fromTool.parsed as { label?: unknown } | undefined;
      const viaTool =
        typeof parsed?.label === 'string'
          ? parseExpressionReply(JSON.stringify({ label: parsed.label }), input.labels)
          : fromTool.args
            ? parseExpressionReply(fromTool.args, input.labels)
            : null;
      if (viaTool) return viaTool;
    }
    return parseExpressionReply(result.text, input.labels);
  } catch {
    return null;
  }
}
