import type { ScriptButton } from '../../scripts/api';
import type { ScriptDraft } from '../../scripts/ScriptEditor';
import { formatPointer, getAt, setAtImmutable } from '../draft/patch';
import type { CharacterDraft } from '../types';

/*
 * 角色卡自带的酒馆助手脚本（`extensions.tavern_helper.scripts`，旧卡 `extensions.TavernHelper_scripts`）。
 * 直接在卡的 data 上读写、保持酒馆助手的原格式：新格式 Script（`button: { enabled, buttons }`）、
 * 旧格式 ScriptItem（`{ type:'script', value: ScriptData }`，按钮是 `buttons` 数组）、文件夹（`scripts` / `value`）。
 * 只改动用户碰过的那个脚本对象里的字段，其余（id、data、export_with、未知字段）原样保留。
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface CardScript {
  /** 脚本对象（旧格式为 `value`）在 data 里的路径段 */
  tokens: string[];
  /** JSON Pointer（React key 用） */
  pointer: string;
  name: string;
  content: string;
  info: string;
  enabled: boolean;
  buttons: ScriptButton[];
  buttonsEnabled: boolean;
  /** 所在文件夹名 */
  folder: string | null;
  /** 旧格式（按钮是 `buttons` 数组，没有 `button.enabled`） */
  legacy: boolean;
}

/** 脚本树数组的位置：优先新格式；都没有时为 null */
export function scriptTreeTokens(data: CharacterDraft): string[] | null {
  const extensions = isRecord(data.extensions) ? data.extensions : null;
  if (!extensions) return null;
  const helper = isRecord(extensions.tavern_helper) ? extensions.tavern_helper : null;
  if (helper && Array.isArray(helper.scripts)) return ['extensions', 'tavern_helper', 'scripts'];
  if (Array.isArray(extensions.TavernHelper_scripts)) return ['extensions', 'TavernHelper_scripts'];
  return null;
}

function normalizeButtons(value: unknown): ScriptButton[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((button) => ({
    name: typeof button.name === 'string' ? button.name : '',
    visible: button.visible !== false,
  }));
}

function toCardScript(inner: Json, tokens: string[], folder: string | null): CardScript {
  const button = isRecord(inner.button) ? inner.button : null;
  return {
    tokens,
    pointer: formatPointer(tokens),
    name: typeof inner.name === 'string' ? inner.name : '',
    content: typeof inner.content === 'string' ? inner.content : '',
    info: typeof inner.info === 'string' ? inner.info : '',
    enabled: inner.enabled === true,
    buttons: button ? normalizeButtons(button.buttons) : normalizeButtons(inner.buttons),
    buttonsEnabled: button ? button.enabled !== false : true,
    folder,
    legacy: !button && Array.isArray(inner.buttons),
  };
}

/** 平铺出全部脚本（文件夹展开，记下文件夹名） */
export function readCardScripts(data: CharacterDraft): CardScript[] {
  const root = scriptTreeTokens(data);
  if (!root) return [];
  const out: CardScript[] = [];
  const visit = (value: unknown, tokens: string[], folder: string | null) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...tokens, String(index)], folder));
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === 'folder') {
      const name = typeof value.name === 'string' && value.name ? value.name : folder;
      if (Array.isArray(value.scripts)) visit(value.scripts, [...tokens, 'scripts'], name);
      else if (Array.isArray(value.value)) visit(value.value, [...tokens, 'value'], name);
      return;
    }
    if (value.type === 'script' && isRecord(value.value)) {
      out.push(toCardScript(value.value, [...tokens, 'value'], folder));
      return;
    }
    if (typeof value.content === 'string' || typeof value.name === 'string') {
      out.push(toCardScript(value, tokens, folder));
    }
  };
  visit(getAt(data, root).value, root, null);
  return out;
}

export function scriptToDraft(script: CardScript): ScriptDraft {
  return {
    name: script.name,
    content: script.content,
    info: script.info,
    buttons: script.buttons,
    buttonsEnabled: script.buttonsEnabled,
  };
}

/** 改一个脚本的若干字段（在原对象上叠加，保持格式） */
export function patchCardScript(
  data: CharacterDraft,
  script: CardScript,
  patch: Partial<ScriptDraft> & { enabled?: boolean },
): CharacterDraft {
  const current = getAt(data, script.tokens).value;
  if (!isRecord(current)) return data;
  const next: Json = { ...current };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.content !== undefined) next.content = patch.content;
  if (patch.info !== undefined) next.info = patch.info;
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.buttons !== undefined || patch.buttonsEnabled !== undefined) {
    if (script.legacy) {
      if (patch.buttons !== undefined) next.buttons = patch.buttons;
    } else {
      const button = isRecord(current.button) ? current.button : {};
      next.button = {
        ...button,
        ...(patch.buttonsEnabled !== undefined ? { enabled: patch.buttonsEnabled } : {}),
        ...(patch.buttons !== undefined ? { buttons: patch.buttons } : {}),
      };
    }
  }
  return setAtImmutable(data, script.tokens, next);
}

/** 删一个脚本（从所在数组里去掉；旧格式删外层 ScriptItem） */
export function deleteCardScript(data: CharacterDraft, script: CardScript): CharacterDraft {
  const tokens =
    script.tokens[script.tokens.length - 1] === 'value'
      ? script.tokens.slice(0, -1)
      : script.tokens;
  const parentTokens = tokens.slice(0, -1);
  const index = Number(tokens[tokens.length - 1]);
  const parent = getAt(data, parentTokens).value;
  if (!Array.isArray(parent) || !Number.isInteger(index)) return data;
  return setAtImmutable(
    data,
    parentTokens,
    parent.filter((_, i) => i !== index),
  );
}

/** 新增脚本：追加到现有脚本树的末尾（没有树就建 `extensions.tavern_helper.scripts`），新格式 */
export function addCardScript(data: CharacterDraft, draft: ScriptDraft): CharacterDraft {
  const script: Json = {
    type: 'script',
    enabled: false,
    name: draft.name,
    id: crypto.randomUUID(),
    content: draft.content,
    info: draft.info,
    button: { enabled: draft.buttonsEnabled, buttons: draft.buttons },
    data: {},
  };
  const root = scriptTreeTokens(data);
  if (root) {
    const list = getAt(data, root).value as unknown[];
    return setAtImmutable(data, root, [...list, script]);
  }
  const extensions = isRecord(data.extensions) ? data.extensions : {};
  const helper = isRecord(extensions.tavern_helper) ? extensions.tavern_helper : {};
  return {
    ...data,
    extensions: { ...extensions, tavern_helper: { ...helper, scripts: [script] } },
  };
}
