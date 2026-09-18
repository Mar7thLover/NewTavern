import type { PromptIR, Segment } from '@newtavern/core';
import type { ProviderError } from '@newtavern/providers';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { Db } from '../db/client.js';
import { assemblePrompt } from '../services/assemble.js';
import { buildAssembleInput } from '../services/assemble-input.js';
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
 * 前端卡 / 脚本的 `generate()` 与 `generateRaw()`。见 docs/M5-CONTRACT.md §4.6。
 *
 * 和正式生成的区别：**不写消息树、不推进世界书时间态、不产生变量副作用**
 * （组装走 `dryRun`）。卡拿它做「让模型总结一下」「生成一段描写填进面板」这类事。
 *
 * 支持的 `config` 子集（酒馆助手 `GenerateConfig`）：
 * `user_input` / `should_stream` / `max_chat_history` / `ordered_prompts`（仅 `RolePrompt`
 * 与 `chat_history` / `user_input` 两个占位符）/ `connectionId` / `model`。
 * `injects` / `overrides` / `tools` / `json_schema` / `preset_name` 暂不支持：
 * 请求里带了就原样回一条 warning，其余照常生成（不静默丢弃，也不报错中断）。
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

    const { overrides, model, resolved, parentId, layoutMode, chat, nodes } = context;
    const warnings: string[] = [];
    for (const field of body.unsupported ?? []) {
      warnings.push(`generate 的 ${field} 暂不支持，已忽略`);
    }

    let ir: PromptIR;
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

      let text = '';
      let error: ProviderError | null = null;
      try {
        if (warnings.length > 0) await send('warning', { warnings });
        for await (const ev of resolved.adapter.stream(resolved.conn, request, ac.signal)) {
          switch (ev.type) {
            case 'text.delta':
              text += ev.text;
              // should_stream=false 的卡不看增量，但推给它也无害（它只等 done）
              if (body.shouldStream !== false) await send('text.delta', { text: ev.text });
              break;
            case 'error':
              error = ev.error;
              break;
            default:
              break;
          }
        }
        if (error && text === '') {
          await send('error', { error: { kind: error.kind, message: error.message } });
        } else {
          await send('done', { text });
        }
      } catch (e) {
        await send('error', { error: { kind: 'invalid', message: (e as Error).message } });
      } finally {
        c.req.raw.signal.removeEventListener('abort', onGone);
      }
    });
  });
}
