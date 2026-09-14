import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { ChatOverrides } from './chat-tree.js';

/**
 * 全局系统提示词：设置 KV + 按会话覆盖。见 docs/M3-CONTRACT.md §3.4。
 * 设置 KV `globalSystemPrompt = { enabled, text, position }`，
 * `chats.overrides.globalSystemPrompt` 可逐字段覆盖。
 */

export type GSPPosition = 'before_main' | 'after_main';

export interface GlobalSystemPromptSetting {
  enabled: boolean;
  text: string;
  position: GSPPosition;
}

/** 组装器要的形态（已按 enabled 过滤） */
export interface GlobalSystemPrompt {
  text: string;
  position: GSPPosition;
}

export const GLOBAL_SYSTEM_PROMPT_KEY = 'globalSystemPrompt';

export const DEFAULT_GLOBAL_SYSTEM_PROMPT: GlobalSystemPromptSetting = {
  enabled: false,
  text: '',
  position: 'before_main',
};

function isPosition(value: unknown): value is GSPPosition {
  return value === 'before_main' || value === 'after_main';
}

/** 校验 overrides.globalSystemPrompt 的形状（PATCH /api/chats/:id 用） */
export function isGlobalSystemPromptOverride(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.enabled !== undefined && typeof v.enabled !== 'boolean') return false;
  if (v.text !== undefined && typeof v.text !== 'string') return false;
  if (v.position !== undefined && !isPosition(v.position)) return false;
  return true;
}

export function mergeGlobalSystemPromptSetting(value: unknown): GlobalSystemPromptSetting {
  const s = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    enabled: typeof s.enabled === 'boolean' ? s.enabled : DEFAULT_GLOBAL_SYSTEM_PROMPT.enabled,
    text: typeof s.text === 'string' ? s.text : DEFAULT_GLOBAL_SYSTEM_PROMPT.text,
    position: isPosition(s.position) ? s.position : DEFAULT_GLOBAL_SYSTEM_PROMPT.position,
  };
}

export function readGlobalSystemPromptSetting(db: Db): GlobalSystemPromptSetting {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, GLOBAL_SYSTEM_PROMPT_KEY))
    .get();
  return mergeGlobalSystemPromptSetting(row?.value ?? null);
}

/**
 * 设置与会话覆盖合并成最终注入内容。
 * `enabled=false`（或文本为空）→ null，即不注入。
 */
export function resolveGlobalSystemPrompt(
  db: Db,
  overrides: ChatOverrides | null | undefined,
): GlobalSystemPrompt | null {
  const base = readGlobalSystemPromptSetting(db);
  const override = overrides?.globalSystemPrompt ?? null;
  const position = override?.position;
  const merged: GlobalSystemPromptSetting = {
    enabled: typeof override?.enabled === 'boolean' ? override.enabled : base.enabled,
    text: typeof override?.text === 'string' ? override.text : base.text,
    position: isPosition(position) ? position : base.position,
  };
  if (!merged.enabled || !merged.text.trim()) return null;
  return { text: merged.text, position: merged.position };
}
