/**
 * 粗判一个 ST 文件是哪一类：角色卡 / 世界书 / 预设 / 正则脚本 / 聊天记录。
 *
 * 只用于导入时给「传错页面」的明确提示，不做校验：识别不出返回 null，交给各自的解析器报错。
 * 判定顺序有讲究——越独特的特征越先判：
 *   spec(chara_card_*) → 正则(scriptName+findRegex) → 世界书(顶层 entries) → 预设(prompts 等标记)
 *   → 角色卡的宽松特征(name+first_mes 等、char_name、data.name) → 聊天记录首行 header。
 */

import { looksLikeStPreset } from './preset.js';
import { isRecord } from './util.js';

export type StFileKind = 'character' | 'lorebook' | 'preset' | 'regex' | 'chat';

const CARD_FIELD_HINTS = ['first_mes', 'mes_example', 'personality', 'scenario', 'description'];

function looksLikeRegexScript(value: unknown): boolean {
  return isRecord(value) && typeof value['scriptName'] === 'string' && 'findRegex' in value;
}

/** 已解析的 JSON → 文件类型 */
export function detectStJsonKind(json: unknown): StFileKind | null {
  if (Array.isArray(json)) {
    return json.length > 0 && json.every(looksLikeRegexScript) ? 'regex' : null;
  }
  if (!isRecord(json)) return null;

  if (typeof json['spec'] === 'string' && json['spec'].startsWith('chara_card')) return 'character';
  if (looksLikeRegexScript(json)) return 'regex';
  if (isRecord(json['entries']) || Array.isArray(json['entries'])) return 'lorebook';
  if (looksLikeStPreset(json)) return 'preset';

  if (typeof json['name'] === 'string' && CARD_FIELD_HINTS.some((key) => key in json)) {
    return 'character';
  }
  if (typeof json['char_name'] === 'string') return 'character';
  if (isRecord(json['data']) && typeof json['data']['name'] === 'string') return 'character';

  if ('chat_metadata' in json || ('user_name' in json && 'character_name' in json)) return 'chat';
  return null;
}

/** 文本（JSON 或 JSONL）→ 文件类型；JSONL 只看首个非空行 */
export function detectStTextKind(text: string): StFileKind | null {
  // 去掉开头的 BOM（0xFEFF），用码点判断以免源码里出现不可见字符
  const trimmed = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).trim();
  if (trimmed === '') return null;
  try {
    return detectStJsonKind(JSON.parse(trimmed));
  } catch {
    const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? '';
    try {
      return detectStJsonKind(JSON.parse(firstLine)) === 'chat' ? 'chat' : null;
    } catch {
      return null;
    }
  }
}
