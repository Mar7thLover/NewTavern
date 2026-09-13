/**
 * 角色卡版本升级链：V1（平铺 JSON）→ V2 → V3，以及写 chara chunk 用的 V3→V2 降级。
 * normalizeCard 把任意来源（原始 JSON / ParsedCard / 卡对象）统一为 V3。
 * 升级时保留未知字段（顶层未知键原样带上），V3 新字段补默认值。
 */

import {
  parseCardJson,
  v2CardSchema,
  v3CardSchema,
  type ParsedCard,
  type V2Card,
  type V3Card,
} from './card.js';
import { isRecord, parseOrThrow } from './util.js';

function pickString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === 'string' ? value : '';
}

function pickStringArray(obj: Record<string, unknown>, key: string): string[] {
  const value = obj[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/** V1 顶层已知键（升级到 V2 时移入 data 或丢弃，其余未知键保留在顶层） */
const V1_KNOWN_KEYS = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'character_book',
  'tags',
  'creator',
  'character_version',
  'extensions',
]);

export function upgradeV1toV2(v1: Record<string, unknown>): V2Card {
  if (typeof v1['name'] !== 'string') {
    throw new Error('V1 角色卡缺少 name 字段');
  }
  const data: Record<string, unknown> = {
    name: v1['name'],
    description: pickString(v1, 'description'),
    personality: pickString(v1, 'personality'),
    scenario: pickString(v1, 'scenario'),
    first_mes: pickString(v1, 'first_mes'),
    mes_example: pickString(v1, 'mes_example'),
    creator_notes: pickString(v1, 'creator_notes'),
    system_prompt: pickString(v1, 'system_prompt'),
    post_history_instructions: pickString(v1, 'post_history_instructions'),
    alternate_greetings: pickStringArray(v1, 'alternate_greetings'),
    tags: pickStringArray(v1, 'tags'),
    creator: pickString(v1, 'creator'),
    character_version: pickString(v1, 'character_version'),
    extensions: isRecord(v1['extensions']) ? v1['extensions'] : {},
  };
  if (isRecord(v1['character_book'])) {
    data['character_book'] = v1['character_book'];
  }
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(v1)) {
    if (!V1_KNOWN_KEYS.has(key)) rest[key] = value;
  }
  const candidate = { ...rest, spec: 'chara_card_v2', spec_version: '2.0', data };
  return parseOrThrow(v2CardSchema, candidate, 'V1 角色卡升级失败');
}

export function upgradeV2toV3(v2: V2Card): V3Card {
  const { data } = v2;
  const rest: Record<string, unknown> = { ...v2 };
  delete rest['spec'];
  delete rest['spec_version'];
  delete rest['data'];
  const extra = data as Record<string, unknown>;
  const candidate = {
    ...rest,
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      ...data,
      // CCv3 新增字段补默认值
      assets: Array.isArray(extra['assets']) ? extra['assets'] : [],
      group_only_greetings: Array.isArray(extra['group_only_greetings'])
        ? extra['group_only_greetings']
        : [],
    },
  };
  return parseOrThrow(v3CardSchema, candidate, 'V2 角色卡升级失败');
}

/** V2 data 的可选字段（除 extensions 单独处理外） */
const V2_OPTIONAL_DATA_KEYS = [
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'character_book',
  'tags',
  'creator',
  'character_version',
] as const;

/** 写 chara chunk 用：data 只保留 V2 字段集，extensions 原样带上；V3 专有字段丢弃 */
export function downgradeV3toV2(v3: V3Card): V2Card {
  const { data } = v3;
  const rest: Record<string, unknown> = { ...v3 };
  delete rest['spec'];
  delete rest['spec_version'];
  delete rest['data'];
  const downgraded: Record<string, unknown> = {
    name: data.name,
    description: data.description,
    personality: data.personality,
    scenario: data.scenario,
    first_mes: data.first_mes,
    mes_example: data.mes_example,
  };
  for (const key of V2_OPTIONAL_DATA_KEYS) {
    if (data[key] !== undefined) downgraded[key] = data[key];
  }
  downgraded['extensions'] = data.extensions ?? {};
  const candidate = { ...rest, spec: 'chara_card_v2', spec_version: '2.0', data: downgraded };
  return parseOrThrow(v2CardSchema, candidate, 'V3 角色卡降级失败');
}

/** 任意来源 → V3：原始 JSON（V1/V2/V3）、完整卡对象或 ParsedCard */
export function normalizeCard(input: unknown): V3Card {
  if (isRecord(input) && (input['spec'] === 'v2' || input['spec'] === 'v3')) {
    const card = (input as unknown as ParsedCard).card;
    return card.spec === 'chara_card_v3' ? card : upgradeV2toV3(card);
  }
  const parsed = parseCardJson(input);
  return parsed.spec === 'v3' ? parsed.card : upgradeV2toV3(parsed.card);
}
