import type {
  AssembleExtraInjection,
  AssemblePromptOverrides,
  PromptIR,
  ResponseFormat,
  Segment,
  ToolChoice,
  ToolDef,
} from '@newtavern/core';
import {
  applyTextResponseFormat,
  applyTextToolProtocol,
  collectStream,
  extractFirstJson,
  parseTextToolCalls,
  type CollectedToolCall,
} from '@newtavern/providers';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import { schema, type Db } from '../db/client.js';
import { assemblePrompt } from '../services/assemble.js';
import { buildAssembleInput } from '../services/assemble-input.js';
import { consumeOnceInjects, normalizeInject } from '../services/chat-injects.js';
import type { AssetsService } from '../services/assets.js';
import { createAssetResolver } from '../services/media.js';
import {
  GenerationContextError,
  resolveGenerationContext,
  type GenerationContext,
} from '../services/generation-context.js';
import type { ProviderService } from '../services/providers.js';
import { buildProviderRequest } from '../services/provider-request.js';

/**
 * 前端卡 / 脚本的 `generate()` 与 `generateRaw()`。见 docs/M5-CONTRACT.md §4.6 与第二部分 §3.2。
 *
 * 和正式生成的区别：**不写消息树、不推进世界书时间态、不产生变量副作用**
 * （组装走 `dryRun`）。卡拿它做「让模型总结一下」「生成一段描写填进面板」这类事。
 *
 * 支持的 `config` 子集（酒馆助手 `GenerateConfig`）：
 * `user_input` / `should_stream` / `max_chat_history` / `ordered_prompts`（仅 `RolePrompt`
 * 与 `chat_history` / `user_input` 两个占位符）/ `connectionId` / `model`，以及 M5（三）补上的
 * `injects`（→ `extraInjections`）、`overrides`（→ `promptOverrides`）、`tools` / `tool_choice`
 * （→ IR `tools` / `toolChoice`）、`json_schema`（→ IR `responseFormat`）、`preset_name`（按名字找预设）。
 * 其余字段（`image` / `custom_api` / `should_silence` …）带了就回一条 warning，照常生成。
 *
 * 聚合用 providers 的 `collectStream`（M6 §1.4）：结构化输出在 Anthropic 上是强制单工具模拟，
 * 由它还原成正文；模型不支持工具 / 结构化输出时按 M6 §1.3 降级成文本协议。
 */

interface SandboxGenerateBody {
  /** `generate`（走完整组装）或 `raw`（按 ordered_prompts 直接拼） */
  mode?: 'generate' | 'raw';
  userInput?: string;
  /** 数字 = 只保留最近 N 条历史；'all' / 缺省 = 全部 */
  maxChatHistory?: number | 'all';
  orderedPrompts?: unknown;
  shouldStream?: boolean;
  connectionId?: string;
  model?: string;
  /** 前端卡传了但我们还不支持的字段，原样回 warning */
  unsupported?: string[];
  /** 酒馆助手 `injects`（`Omit<InjectionPrompt,'id'>[]`） */
  injects?: unknown[];
  /** 酒馆助手 `overrides` */
  overrides?: Record<string, unknown>;
  /** 酒馆助手 `tools`（OpenAI 形状） */
  tools?: unknown[];
  toolChoice?: unknown;
  /** 酒馆助手 `json_schema`：`{ name, description?, value, strict? }` */
  jsonSchema?: unknown;
  /** 按名字找预设；`'in_use'` / 缺省 = 会话当前预设 */
  presetName?: string;
}

/** 酒馆助手 `Overrides` 里我们认的字段 */
const OVERRIDE_STRING_KEYS = [
  'world_info_before',
  'persona_description',
  'char_description',
  'char_personality',
  'scenario',
  'world_info_after',
  'dialogue_examples',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `overrides` → `AssemblePromptOverrides`；不认的键记 warning */
export function toPromptOverrides(
  raw: Record<string, unknown>,
  warnings: string[],
): AssemblePromptOverrides {
  const out: AssemblePromptOverrides = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((OVERRIDE_STRING_KEYS as readonly string[]).includes(key)) {
      if (typeof value === 'string') out[key as (typeof OVERRIDE_STRING_KEYS)[number]] = value;
      else warnings.push(`overrides.${key} 必须是字符串，已忽略`);
      continue;
    }
    if (key === 'chat_history' && isRecord(value)) {
      const history: NonNullable<AssemblePromptOverrides['chat_history']> = {};
      for (const [field, item] of Object.entries(value)) {
        if (field === 'with_depth_entries' && typeof item === 'boolean') {
          history.with_depth_entries = item;
        } else if (field === 'author_note' && typeof item === 'string') {
          history.author_note = item;
        } else if (field === 'prompts' && Array.isArray(item)) {
          const prompts = item.flatMap((prompt) =>
            isRecord(prompt) &&
            (prompt.role === 'system' || prompt.role === 'user' || prompt.role === 'assistant') &&
            typeof prompt.content === 'string'
              ? [{ role: prompt.role as 'system' | 'user' | 'assistant', content: prompt.content }]
              : [],
          );
          if (prompts.length !== item.length) {
            warnings.push('overrides.chat_history.prompts 里有无法识别的条目，已跳过');
          }
          history.prompts = prompts;
        } else {
          warnings.push(`overrides.chat_history.${field} 暂不支持，已忽略`);
        }
      }
      out.chat_history = history;
      continue;
    }
    warnings.push(`overrides.${key} 暂不支持，已忽略`);
  }
  return out;
}

/** 酒馆助手 `injects` → `extraInjections`（每次请求临时生效，不落库） */
export function toExtraInjections(raw: readonly unknown[]): AssembleExtraInjection[] {
  const out: AssembleExtraInjection[] = [];
  raw.forEach((item, index) => {
    const inject = normalizeInject(item, `generate-inject-${index}`);
    if (!inject) return;
    const { once: _once, ...rest } = inject;
    out.push(rest);
  });
  return out;
}

/** 酒馆助手 `tools`（OpenAI 形状）→ IR `ToolDef[]` */
export function toToolDefs(raw: readonly unknown[], warnings: string[]): ToolDef[] {
  const out: ToolDef[] = [];
  for (const item of raw) {
    const fn = isRecord(item) && isRecord(item.function) ? item.function : isRecord(item) ? item : null;
    if (!fn || typeof fn.name !== 'string' || fn.name === '') {
      warnings.push('tools 里有无法识别的条目，已跳过');
      continue;
    }
    out.push({
      name: fn.name,
      description: typeof fn.description === 'string' ? fn.description : '',
      parameters: isRecord(fn.parameters) ? fn.parameters : { type: 'object', properties: {} },
      ...(typeof fn.strict === 'boolean' ? { strict: fn.strict } : {}),
    });
  }
  return out;
}

/** 酒馆助手 `tool_choice` → IR `toolChoice`（`'any'` 是 Anthropic 的叫法，等于 required） */
export function toToolChoice(raw: unknown): ToolChoice | undefined {
  if (raw === 'auto' || raw === 'none' || raw === 'required') return raw;
  if (raw === 'any') return 'required';
  if (isRecord(raw) && isRecord(raw.function) && typeof raw.function.name === 'string') {
    return { name: raw.function.name };
  }
  return undefined;
}

/** 酒馆助手 `json_schema` → IR `responseFormat`（strict 缺省 true，与酒馆助手一致） */
export function toResponseFormat(raw: unknown): ResponseFormat | undefined {
  if (!isRecord(raw) || !isRecord(raw.value)) return undefined;
  return {
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : 'output',
    schema: raw.value,
    strict: raw.strict !== false,
  };
}

/** 酒馆助手 `GenerateToolCallResult.tool_calls` 的形状 */
function toHelperToolCalls(calls: readonly CollectedToolCall[]) {
  return calls.map((call) => ({
    id: call.id,
    type: 'function' as const,
    function: { name: call.name, arguments: call.args },
  }));
}

const HISTORY_KIND = 'history';

function historySegments(ir: PromptIR): Segment[] {
  return ir.segments.filter((segment) => segment.origin.kind === HISTORY_KIND);
}

/** 只保留最近 N 条历史段（酒馆助手 `max_chat_history`） */
function truncateHistory(ir: PromptIR, max: number): PromptIR {
  const history = historySegments(ir);
  if (history.length <= max) return ir;
  const keep = new Set(history.slice(history.length - max));
  return {
    ...ir,
    segments: ir.segments.filter((segment) => segment.origin.kind !== HISTORY_KIND || keep.has(segment)),
  };
}

function userSegment(text: string, order: number): Segment {
  return {
    id: `sandbox_user_input`,
    role: 'user',
    parts: [{ type: 'text', text }],
    origin: { kind: 'user_input' },
    anchor: { slot: 'history', order },
    stability: 'turn',
  };
}

function roleSegment(
  role: 'system' | 'user' | 'assistant',
  text: string,
  order: number,
): Segment {
  return {
    id: `sandbox_prompt_${order}`,
    role,
    parts: [{ type: 'text', text }],
    origin: { kind: 'injection', ref: 'sandbox' },
    anchor: { slot: order === 0 ? 'system' : 'history', order },
    stability: 'turn',
  };
}

/** `ordered_prompts` → 段列表；占位符只认 `chat_history` 与 `user_input` */
function buildRawSegments(
  ordered: unknown,
  base: PromptIR,
  userInput: string | undefined,
  warnings: string[],
): Segment[] {
  const out: Segment[] = [];
  const list = Array.isArray(ordered) ? ordered : ['chat_history', 'user_input'];
  let order = 0;
  for (const item of list) {
    if (typeof item === 'string') {
      if (item === 'chat_history') {
        for (const segment of historySegments(base)) out.push({ ...segment, anchor: { ...segment.anchor, order: order++ } });
        continue;
      }
      if (item === 'user_input') {
        if (userInput !== undefined && userInput !== '') out.push(userSegment(userInput, order++));
        continue;
      }
      warnings.push(`ordered_prompts 里的占位符「${item}」暂不支持，已跳过`);
      continue;
    }
    if (typeof item === 'object' && item !== null) {
      const record = item as Record<string, unknown>;
      const role = record.role;
      const content = record.content;
      if (
        (role === 'system' || role === 'user' || role === 'assistant') &&
        typeof content === 'string'
      ) {
        out.push(roleSegment(role, content, order++));
        continue;
      }
    }
    warnings.push('ordered_prompts 里有无法识别的条目，已跳过');
  }
  return out;
}

export function createSandboxRoutes(db: Db, providers: ProviderService, assets: AssetsService) {
  return new Hono().post('/:id/sandbox/generate', async (c) => {
    let body: SandboxGenerateBody = {};
    try {
      body = ((await c.req.json()) ?? {}) as SandboxGenerateBody;
    } catch {
      body = {};
    }

    let context: GenerationContext;
    try {
      context = await resolveGenerationContext(db, providers, {
        chatId: c.req.param('id'),
        connectionId: body.connectionId,
        model: body.model,
      });
    } catch (e) {
      if (e instanceof GenerationContextError) return c.json(e.body, e.status);
      throw e;
    }

    const { overrides, model, resolved, parentId, layoutMode, nodes } = context;
    let chat = context.chat;
    const warnings: string[] = [];
    for (const field of body.unsupported ?? []) {
      warnings.push(`generate 的 ${field} 暂不支持，已忽略`);
    }

    // preset_name：按名字找预设（找不到报错，与酒馆助手 `getPreset` 抛错一致）
    const presetName = typeof body.presetName === 'string' ? body.presetName.trim() : '';
    if (presetName !== '' && presetName !== 'in_use') {
      const preset = db
        .select({ id: schema.presets.id })
        .from(schema.presets)
        .where(eq(schema.presets.name, presetName))
        .get();
      if (!preset) {
        return c.json({ error: 'invalid', message: `找不到预设：${presetName}` }, 400);
      }
      chat = { ...chat, presetId: preset.id };
    }

    const promptOverrides = isRecord(body.overrides)
      ? toPromptOverrides(body.overrides, warnings)
      : undefined;
    const extraInjections = Array.isArray(body.injects) ? toExtraInjections(body.injects) : [];
    const tools = Array.isArray(body.tools) ? toToolDefs(body.tools, warnings) : [];
    const toolChoice = toToolChoice(body.toolChoice);
    const responseFormat = toResponseFormat(body.jsonSchema);
    if (body.jsonSchema !== undefined && !responseFormat) {
      warnings.push('json_schema 缺少 value（JSON Schema 对象），已忽略');
    }
    if (responseFormat && tools.length > 0) {
      warnings.push('json_schema 与 tools 不应同时给（酒馆助手也要求二者互斥），以各家的限制为准');
    }

    let ir: PromptIR;
    /** 模型不支持工具：走文本协议，回复里的 ```tool_call 块要自己解析 */
    let textTools = false;
    /** 模型不支持结构化输出：指令里附 schema，从回复里抽第一个 JSON */
    let textFormat = false;
    try {
      const caps = resolved.adapter.capabilities(model, resolved.conn);
      const assembled = assemblePrompt(
        buildAssembleInput(db, {
          chat,
          overrides,
          nodes,
          parentId,
          provider: resolved.conn.provider,
          model,
          layoutMode,
          caps,
          assets,
          // 前端卡的生成不改任何状态
          dryRun: true,
          ...(extraInjections.length > 0 ? { extraInjections } : {}),
          ...(promptOverrides ? { promptOverrides } : {}),
        }),
      );
      ir = assembled.ir;
      const max = body.maxChatHistory;
      if (typeof max === 'number' && Number.isFinite(max) && max >= 0) ir = truncateHistory(ir, max);
      if (body.mode === 'raw') {
        const segments = buildRawSegments(body.orderedPrompts, ir, body.userInput, warnings);
        ir = { ...ir, segments, cachePlan: { breakpoints: [] } };
      } else if (body.userInput !== undefined && body.userInput !== '') {
        const order = (ir.segments[ir.segments.length - 1]?.anchor.order ?? 0) + 1;
        ir = { ...ir, segments: [...ir.segments, userSegment(body.userInput, order)] };
      }
      if (tools.length > 0) {
        ir = { ...ir, tools, ...(toolChoice ? { toolChoice } : {}) };
        if (!caps.tools) {
          ir = applyTextToolProtocol(ir, 'zh-CN');
          textTools = true;
          warnings.push('这个模型不支持工具调用，已改用文本协议（回复里的 tool_call 代码块会被解析）');
        }
      }
      if (responseFormat) {
        ir = { ...ir, responseFormat };
        if (!caps.structuredOutput) {
          ir = applyTextResponseFormat(ir, 'zh-CN');
          textFormat = true;
        }
      }
    } catch (e) {
      return c.json({ error: 'invalid', message: (e as Error).message }, 400);
    }

    const resolveAsset = createAssetResolver(assets, ir);
    const request = buildProviderRequest(
      resolved.adapter,
      ir,
      resolved.conn,
      model,
      overrides.thinking,
      { resolveAsset },
    );

    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      let aborted = false;
      const onGone = () => {
        if (aborted) return;
        aborted = true;
        ac.abort();
      };
      c.req.raw.signal.addEventListener('abort', onGone);
      stream.onAbort(onGone);

      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data) });
      /** collectStream 的回调是同步的：增量排队写，保证顺序 */
      let queue: Promise<unknown> = Promise.resolve();
      const enqueue = (event: string, data: unknown) => {
        queue = queue.then(() => send(event, data));
      };

      try {
        if (warnings.length > 0) await send('warning', { warnings });
        const streaming = body.shouldStream !== false && !textFormat;
        const result = await collectStream(
          resolved.adapter,
          resolved.conn,
          request,
          ac.signal,
          (ev) => {
            // should_stream=false 的卡不看增量；文本协议的 tool_call 块不该流给卡
            if (ev.type === 'text.delta' && streaming && !textTools) {
              enqueue('text.delta', { text: ev.text });
            }
          },
        );
        await queue;

        let text = result.text;
        let toolCalls = result.toolCalls;
        if (textTools) {
          const parsed = parseTextToolCalls(text);
          text = parsed.rest;
          toolCalls = [...toolCalls, ...parsed.toolCalls];
          if (streaming && text !== '') await send('text.delta', { text });
        }
        if (textFormat) {
          const found = extractFirstJson(text);
          if (found) text = found.json;
          else warnings.push('模型回复里没有找到 JSON，原文返回');
        }
        if (result.warnings.length > 0) await send('warning', { warnings: result.warnings });

        if (result.error && text === '' && toolCalls.length === 0) {
          await send('error', { error: { kind: result.error.kind, message: result.error.message } });
        } else {
          // 与正式生成一样：一次生成成功后，`injectPrompts(…, { once:true })` 的注入失效
          if (!result.error && !aborted) consumeOnceInjects(db, chat.id);
          await send('done', {
            text,
            ...(toolCalls.length > 0 ? { toolCalls: toHelperToolCalls(toolCalls) } : {}),
            stopReason: result.stop.reason,
          });
        }
      } catch (e) {
        await send('error', { error: { kind: 'invalid', message: (e as Error).message } });
      } finally {
        c.req.raw.signal.removeEventListener('abort', onGone);
      }
    });
  });
}
