/**
 * ST Chat Completion（OpenAI 类）预设解析与导出。
 * 全部字段可选、未知字段原样保留，import→export deep-equal。
 */

import { z } from 'zod';

import { isRecord, parseOrThrow } from './util.js';

const presetPromptSchema = z.looseObject({
  identifier: z.string(),
  name: z.string().optional(),
  system_prompt: z.boolean().optional(),
  marker: z.boolean().optional(),
  role: z.string().optional(),
  content: z.string().optional(),
  enabled: z.boolean().optional(),
  injection_position: z.number().optional(),
  injection_depth: z.number().optional(),
  injection_order: z.number().optional(),
  injection_trigger: z.array(z.string()).optional(),
  forbid_overrides: z.boolean().optional(),
});

const promptOrderSchema = z.looseObject({
  character_id: z.union([z.number(), z.string()]),
  order: z.array(z.looseObject({ identifier: z.string(), enabled: z.boolean() })),
});

/** ST 预设里的采样参数键；导入时抽到 presets.sampling 便于查询 */
export const ST_SAMPLING_KEYS = [
  'temperature',
  'top_p',
  'top_k',
  'top_a',
  'min_p',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'openai_max_tokens',
  'openai_max_context',
  'seed',
  'n',
  'reasoning_effort',
] as const;

export const stPresetSchema = z.looseObject({
  prompts: z.array(presetPromptSchema).optional(),
  prompt_order: z.array(promptOrderSchema).optional(),
  chat_completion_source: z.string().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  top_a: z.number().optional(),
  min_p: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  repetition_penalty: z.number().optional(),
  openai_max_tokens: z.number().optional(),
  openai_max_context: z.number().optional(),
  seed: z.number().optional(),
  n: z.number().optional(),
  squash_system_messages: z.boolean().optional(),
  wi_format: z.string().optional(),
  scenario_format: z.string().optional(),
  personality_format: z.string().optional(),
  continue_prefill: z.boolean().optional(),
  reasoning_effort: z.string().optional(),
  show_thoughts: z.boolean().optional(),
});

export type StPresetPrompt = z.infer<typeof presetPromptSchema>;
export type StPromptOrder = z.infer<typeof promptOrderSchema>;
export type StPreset = z.infer<typeof stPresetSchema>;

const PRESET_MARKER_KEYS = ['prompts', 'prompt_order', 'chat_completion_source', 'temperature'];

/** 粗判一个 JSON 是否像 ST 预设（用于导入时的格式识别） */
export function looksLikeStPreset(json: unknown): boolean {
  return isRecord(json) && PRESET_MARKER_KEYS.some((key) => key in json);
}

export function parsePreset(json: unknown): StPreset {
  if (!isRecord(json)) {
    throw new Error('预设 JSON 必须是对象');
  }
  return parseOrThrow(stPresetSchema, json, 'ST 预设解析失败');
}

export function serializePreset(preset: StPreset): string {
  return JSON.stringify(preset, null, 4);
}

export function extractPresetSampling(preset: StPreset): Record<string, unknown> {
  const sampling: Record<string, unknown> = {};
  for (const key of ST_SAMPLING_KEYS) {
    if (preset[key] !== undefined) sampling[key] = preset[key];
  }
  return sampling;
}

export type PresetApiFamily = 'openai-chat' | 'openai-responses' | 'anthropic' | 'google';

const SOURCE_TO_FAMILY: Record<string, PresetApiFamily> = {
  claude: 'anthropic',
  makersuite: 'google',
  vertexai: 'google',
};

/** ST chat_completion_source → 适配器族；未声明来源返回 null，其余 OpenAI 兼容源归为 openai-chat */
export function presetApiFamily(preset: StPreset): PresetApiFamily | null {
  const source = preset.chat_completion_source;
  if (source === undefined) return null;
  return SOURCE_TO_FAMILY[source] ?? 'openai-chat';
}
