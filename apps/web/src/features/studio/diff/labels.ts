import type { TFunction } from 'i18next';

import type { StudioKind } from '../../../lib/api-studio';
import type { AnyStudioDraft } from '../types';
import { parsePointer } from '../draft/patch';

/*
 * 改动行的路径 → 人话标签（「描述」「备用开场白 #2」「提示词条目「Main」· 内容」）。
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 角色卡编辑器里有独立标签的字段（顺序即编辑器顺序） */
export const CHARACTER_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'alternate_greetings',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator',
  'character_version',
  'tags',
  'creator_notes',
  'creator_notes_multilingual',
  'character_book',
] as const;

const CHARACTER_FIELD_SET = new Set<string>(CHARACTER_FIELDS);
const DEPTH_PARTS = new Set(['prompt', 'depth', 'role']);

function characterLabel(t: TFunction, tokens: string[]): string {
  const [head, second, third] = tokens;
  if (head === undefined) return '/';
  if (head === 'extensions') {
    if (second === 'depth_prompt') {
      const base = t('studio.character.fields.depth_prompt');
      return third && DEPTH_PARTS.has(third)
        ? `${base} · ${t(`studio.character.depth.${third}`)}`
        : base;
    }
    if (second === 'tavern_helper' || second === 'TavernHelper_scripts') {
      return t('studio.character.fields.scripts');
    }
    return `extensions/${tokens.slice(1).join('/')}`;
  }
  if (!CHARACTER_FIELD_SET.has(head)) return `/${tokens.join('/')}`;
  const base = t(`studio.character.fields.${head}`);
  if (second === undefined) return base;
  if (head === 'alternate_greetings' && /^\d+$/.test(second))
    return `${base} #${Number(second) + 1}`;
  if (head === 'creator_notes_multilingual') return `${base}（${second}）`;
  if (head === 'tags' && /^\d+$/.test(second)) return `${base} #${Number(second) + 1}`;
  return `${base} · ${tokens.slice(1).join('/')}`;
}

function presetLabel(t: TFunction, tokens: string[], draft: AnyStudioDraft | undefined): string {
  const [head, second, ...rest] = tokens;
  if (head === 'name' && second === undefined) return t('studio.preset.name');
  if (head === '__layoutPolicy') return t('studio.preset.layoutPolicy');
  if (head === 'prompt_order') return t('studio.preset.promptOrder');
  if (head === 'prompts' && second !== undefined && /^\d+$/.test(second)) {
    const data =
      isRecord(draft) && isRecord((draft as Json).data) ? ((draft as Json).data as Json) : {};
    const prompts = Array.isArray(data.prompts) ? data.prompts : [];
    const prompt = prompts[Number(second)];
    const name = isRecord(prompt) ? String(prompt.name ?? prompt.identifier ?? '').trim() : '';
    const base = t('studio.preset.prompt', { name: name || `#${Number(second) + 1}` });
    return rest.length > 0 ? `${base} · ${rest.join('/')}` : base;
  }
  return tokens.join('/');
}

export function pathLabel(
  t: TFunction,
  kind: StudioKind,
  path: string,
  draft?: AnyStudioDraft,
): string {
  const tokens = parsePointer(path);
  if (kind === 'character') return characterLabel(t, tokens);
  if (kind === 'preset') return presetLabel(t, tokens, draft);
  if (tokens.length === 1 && tokens[0] === 'name') return t('studio.lorebook.name');
  return tokens.join('/');
}

/** 世界书条目字段的标签 */
export function entryFieldLabel(t: TFunction, field: string): string {
  return t(`studio.entryFields.${field}`, { defaultValue: field });
}
