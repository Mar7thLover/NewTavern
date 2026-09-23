import { stripInternal, extractCommands, toMvuData } from '@newtavern/compat/mvu';
import type { PromptIR, Segment } from '@newtavern/core';
import type { GenEvent } from '@newtavern/providers';
import { inArray } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { ChatRow } from './chat-tree.js';
import { buildProviderRequest, type ThinkingOptions } from './provider-request.js';
import type { ProviderService } from './providers.js';

/**
 * MVU 的「额外模型解析」（M5（三）契约 §3.5）：主模型这一轮没写 `<UpdateVariable>`
 * （或设置成总是用额外模型）时，另起一次短调用，让一个便宜的模型按卡里的变量更新规则
 * 写一段 `<UpdateVariable>`，再交给原引擎应用。对应原版 MVU 的「更新方式：额外模型解析」。
 *
 * 调用走 M6 §1.5 的 `callLlm`（写 generation_log、不支持的能力自动降级）；
 * F1 的 `services/llm.ts` 还没落地时退回直接走适配器（与立绘分类同一个接缝写法）。
 */

export interface MvuExtraModelSettings {
  connectionId: string;
  model: string;
  /** `missing`：本轮正文里没有更新命令时才调；`always`：每轮都调，只用额外模型的结果 */
  when: 'missing' | 'always';
}

interface LlmResultLike {
  text: string;
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

/** 由 app 启动时注入（createApp 里调 `configureMvuExtra`）：chats 路由里拿不到 dataDir */
let context: { dataDir: string; providers: ProviderService } | null = null;

export function configureMvuExtra(value: { dataDir: string; providers: ProviderService }): void {
  context = value;
}

let callLlmPromise: Promise<CallLlm | null> | null = null;

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

/** 测试用：换掉 callLlm（null = 走适配器直连） */
export function setMvuCallLlmForTest(fn: CallLlm | null): void {
  callLlmPromise = Promise.resolve(fn);
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
  let error: { message: string } | undefined;
  for await (const event of resolved.adapter.stream(
    resolved.conn,
    request,
    input.signal,
  ) as AsyncIterable<GenEvent>) {
    if (event.type === 'text.delta') text += event.text;
    else if (event.type === 'error') error = { message: event.error.message };
  }
  return { text, ...(error ? { error } : {}) };
}

/** 这段正文里有没有 MVU 能认的更新命令（`_.set(...)` 或 `<JSONPatch>`） */
export function hasMvuCommands(text: string): boolean {
  return extractCommands(text).length > 0;
}

/**
 * 卡里的变量更新规则：会话能看到的世界书里，备注含 `[mvu_update]` 或「变量更新规则」的条目
 * （社区卡的两种写法；这类条目常常是禁用的——只给额外模型看，不进主提示词）。
 */
export function loadUpdateRules(db: Db, bookIds: readonly string[]): string[] {
  if (bookIds.length === 0) return [];
  const entries = db
    .select({ comment: schema.lorebookEntries.comment, content: schema.lorebookEntries.content })
    .from(schema.lorebookEntries)
    .where(inArray(schema.lorebookEntries.bookId, [...bookIds]))
    .all();
  return entries
    .filter((entry) => {
      const comment = entry.comment ?? '';
      return /\[mvu_update\]/i.test(comment) || comment.includes('变量更新规则');
    })
    .map((entry) => entry.content.trim())
    .filter((content) => content !== '');
}

const SYSTEM_PROMPT = [
  '你是变量更新器。读「当前变量」与「本轮正文」，按「更新规则」判断哪些变量需要变化，',
  '只输出一个 <UpdateVariable> 块，块里每行一条命令，形如：',
  "_.set('路径', 旧值, 新值);//理由",
  "_.add('路径', 增量);//理由",
  "_.insert('路径', 值);  _.remove('路径');",
  '路径从 stat_data 下一级写起（例如 角色.好感度），必须是「当前变量」里已有的路径；',
  '没有需要变化的变量时输出空的 <UpdateVariable></UpdateVariable>。不要输出别的内容。',
].join('\n');

export function buildExtraModelIr(input: {
  chatId: string;
  model: string;
  statData: unknown;
  text: string;
  rules: readonly string[];
}): PromptIR {
  const segment = (id: string, role: 'system' | 'user', text: string, order: number): Segment => ({
    id,
    role,
    parts: [{ type: 'text', text }],
    origin: { kind: 'injection', ref: 'mvu_extra' },
    anchor: { slot: role === 'system' ? 'system' : 'history', order },
    stability: role === 'system' ? 'static' : 'turn',
  });
  const rules =
    input.rules.length > 0 ? `\n\n# 更新规则\n${input.rules.join('\n\n')}` : '';
  return {
    model: input.model,
    sampling: { temperature: 0.3, maxTokens: 2048 },
    segments: [
      segment('mvu_extra_system', 'system', `${SYSTEM_PROMPT}${rules}`, 0),
      segment(
        'mvu_extra_input',
        'user',
        `# 当前变量\n\`\`\`json\n${JSON.stringify(input.statData ?? {}, null, 2)}\n\`\`\`\n\n# 本轮正文\n${input.text}`,
        1,
      ),
    ],
    cachePlan: { breakpoints: [] },
    meta: {
      chatId: input.chatId,
      presetId: '',
      layoutMode: 'strict',
      activations: [],
      warnings: [],
      tokenEstimate: 0,
    },
  };
}

/**
 * 请求额外模型，返回它写的更新文本（`<UpdateVariable>…</UpdateVariable>` 或裸命令）。
 * 任何失败都返回 `{ error }`，不抛异常：变量没更新不该让这一轮生成报错。
 */
export async function requestExtraModelUpdate(
  db: Db,
  chat: ChatRow,
  settings: MvuExtraModelSettings,
  input: { variables: Record<string, unknown>; text: string; bookIds: readonly string[] },
): Promise<{ text: string } | { error: string }> {
  const ctx = context;
  if (!ctx) return { error: '额外模型解析没有初始化（configureMvuExtra 未调用）' };
  const statData = stripInternal(toMvuData(input.variables).stat_data ?? {});
  const ir = buildExtraModelIr({
    chatId: chat.id,
    model: settings.model,
    statData,
    text: input.text,
    rules: loadUpdateRules(db, input.bookIds),
  });
  const signal = AbortSignal.timeout(60_000);
  try {
    const callLlm = await loadCallLlm();
    const result = callLlm
      ? await callLlm(db, ctx.dataDir, {
          connectionId: settings.connectionId,
          model: settings.model,
          ir,
          thinking: { enabled: false },
          signal,
        })
      : await directCall(ctx.providers, {
          connectionId: settings.connectionId,
          model: settings.model,
          ir,
          signal,
        });
    if (result.error && result.text === '') return { error: result.error.message };
    return { text: result.text };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
