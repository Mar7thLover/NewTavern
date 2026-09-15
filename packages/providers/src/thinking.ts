import type { PromptIR } from '@newtavern/core';

import type { BuildOptions, ModelCapabilities, ThinkingOptions } from './types.js';

/**
 * 推理控制（thinking / effort）的统一入口。
 *
 * 来源优先级：
 * 1. `BuildOptions.thinking`——会话覆盖 `chat.overrides.thinking`；
 * 2. `ir.sampling.thinking`——旧的可选扩展（契约 §5 [P→C]），形状同上；
 * 3. `ir.sampling.reasoningEffort`——ST 预设的 `reasoning_effort`（auto/min/low/medium/high/max），
 *    ST 对不同来源有不同映射，由各适配器调用下面的 `stEffortTo*` 转换。
 *
 * 统一表示：`{ enabled: false }` = 关闭推理（忽略 effort / budgetTokens）；
 * 其余字段见 `ThinkingOptions`。不支持关闭的模型由适配器给 warning 并按默认处理。
 */

/** ST 1.18 `reasoning_effort_types`（public/scripts/openai.js 约 237 行） */
export const ST_REASONING_EFFORTS = ['auto', 'min', 'low', 'medium', 'high', 'max'] as const;
export type StReasoningEffort = (typeof ST_REASONING_EFFORTS)[number];

export interface ResolvedThinking {
  /** 会话覆盖 / IR 扩展里的统一参数；没有则为空对象 */
  thinking: ThinkingOptions;
  /** 只有前两者都缺省、且预设给了非 auto 的 ST 值时才有 */
  stEffort?: Exclude<StReasoningEffort, 'auto'>;
}

function readOptions(value: unknown): ThinkingOptions | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const out: ThinkingOptions = {};
  if (typeof obj.enabled === 'boolean') out.enabled = obj.enabled;
  if (typeof obj.effort === 'string' && obj.effort !== '') out.effort = obj.effort;
  if (typeof obj.budgetTokens === 'number' && Number.isFinite(obj.budgetTokens)) {
    out.budgetTokens = obj.budgetTokens;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function isStEffort(value: unknown): value is StReasoningEffort {
  return typeof value === 'string' && (ST_REASONING_EFFORTS as readonly string[]).includes(value);
}

export function resolveThinking(ir: PromptIR, opts?: BuildOptions): ResolvedThinking {
  const override = readOptions(opts?.thinking);
  if (override) return { thinking: override };
  const sampling = ir.sampling as Record<string, unknown>;
  const fromIr = readOptions(sampling.thinking);
  if (fromIr) return { thinking: fromIr };
  const st = sampling.reasoningEffort;
  // ST：auto = 不发送（getReasoningEffort / calculate*BudgetTokens 里 auto 都返回 undefined/null）
  if (isStEffort(st) && st !== 'auto') return { thinking: {}, stEffort: st };
  return { thinking: {} };
}

/** 是否真的能关闭：模型要有推理能力，且目录标了 canDisableThinking */
export function canDisableThinking(caps: ModelCapabilities): boolean {
  return caps.thinking !== 'none' && caps.canDisableThinking === true;
}

/**
 * OpenAI / Custom（OpenAI 兼容）/ Responses：ST `getReasoningEffort()`
 * （public/scripts/openai.js 约 2524–2618 行）+ 服务端 `OPENAI_REASONING_EFFORT_MAP { min: 'minimal' }`
 * （src/constants.js 约 492 行，src/endpoints/backends/chat-completions.js 约 1688、2501 行）。
 *
 * - min：gpt-5.4 / 5.5 → none；其他 gpt-5 → minimal；其余模型 → low
 * - max：→ high
 * - 其余原样
 *
 * 偏离：ST 只对 `OPENAI_REASONING_EFFORT_MODELS` 名单里的模型发送；我们用能力目录
 * （`thinking === 'effort'`）代替名单，于是 GLM 等第三方推理模型也会带上。
 */
export function stEffortToOpenAI(st: Exclude<StReasoningEffort, 'auto'>, model: string): string {
  switch (st) {
    case 'min':
      if (/^gpt-5\.(4|5)/.test(model)) return 'none';
      if (/^gpt-5/.test(model)) return 'minimal';
      return 'low';
    case 'max':
      return 'high';
    default:
      return st;
  }
}

/**
 * Claude：ST `calculateClaudeBudgetTokens()`（src/prompt-converters.js 约 1120–1167 行）。
 * - adaptive 模型：min/low → low，medium → medium，high → high，max → max（写入 output_config.effort）
 * - budget 模型：min → 1024，low/medium/high/max → max_tokens × 0.1 / 0.25 / 0.5 / 0.95，下限 1024
 *   （ST 非流式再夹到 21333；我们总是流式，不夹）
 *
 * 偏离：ST 只对名字匹配 `claude-(3-7|opus-4|sonnet-4|haiku-4-5|…)` 的模型发 thinking
 * （chat-completions.js 约 234 行）；我们按能力目录判断。
 */
export function stEffortToClaude(
  st: Exclude<StReasoningEffort, 'auto'>,
  caps: ModelCapabilities,
  maxTokens: number,
): ThinkingOptions {
  if (caps.thinking === 'adaptive') {
    return { effort: st === 'min' ? 'low' : st };
  }
  if (caps.thinking === 'budget') {
    const ratio = { min: 0, low: 0.1, medium: 0.25, high: 0.5, max: 0.95 }[st];
    const budget = st === 'min' ? 1024 : Math.floor(maxTokens * ratio);
    return { budgetTokens: Math.max(budget, 1024) };
  }
  return {};
}

/**
 * Gemini：ST `calculateGoogleBudgetTokens()`（src/prompt-converters.js 约 1178–1320 行），
 * 按模型名依次匹配：
 * - gemini-3*-pro：min/low/medium → low，high/max → high
 * - gemini-3*-flash：min → minimal，low/medium/high 原样，max → high
 * - *flash-lite*：min → 0，low/medium/high → maxTokens × 0.1/0.25/0.5，max → maxTokens；夹到 [512, 24576]
 * - *flash*：同上，夹到 [0, 24576]（min → 0 即关闭）
 * - *pro*：min → 128，其余同上，夹到 [128, 32768]
 * - 其他：不设置
 */
export function stEffortToGoogle(
  st: Exclude<StReasoningEffort, 'auto'>,
  model: string,
  maxTokens: number,
): ThinkingOptions {
  if (/gemini-3[.\d]*-pro/.test(model)) {
    return { effort: st === 'high' || st === 'max' ? 'high' : 'low' };
  }
  if (/gemini-3[.\d]*-flash/.test(model)) {
    return { effort: st === 'min' ? 'minimal' : st === 'max' ? 'high' : st };
  }
  const scaled = (): number => {
    switch (st) {
      case 'low':
        return Math.floor(maxTokens * 0.1);
      case 'medium':
        return Math.floor(maxTokens * 0.25);
      case 'high':
        return Math.floor(maxTokens * 0.5);
      case 'max':
        return maxTokens;
      default:
        return 0;
    }
  };
  if (/flash-lite/.test(model)) {
    if (st === 'min') return { budgetTokens: 0 };
    return { budgetTokens: Math.max(Math.min(scaled(), 24576), 512) };
  }
  if (/flash/.test(model)) {
    if (st === 'min') return { budgetTokens: 0 };
    return { budgetTokens: Math.min(scaled(), 24576) };
  }
  if (/pro/.test(model)) {
    const budget = st === 'min' ? 128 : scaled();
    return { budgetTokens: Math.max(Math.min(budget, 32768), 128) };
  }
  return {};
}
