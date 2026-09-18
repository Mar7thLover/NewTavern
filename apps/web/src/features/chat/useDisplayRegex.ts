import { applyRegexScripts, REGEX_PLACEMENT, substituteMacros } from '@newtavern/core';
import { useCallback, useMemo } from 'react';

import {
  useCharacterRegex,
  usePresetRegex,
  useRegexScripts,
  type MessageRole,
} from '../../lib/api';

/** 对一条消息文本做显示侧正则替换 */
export type DisplayRegexFn = (text: string, role: MessageRole, depth: number) => string;

export interface DisplayRegexOptions {
  characterId: string | null;
  /** 会话绑定的预设：它自带的正则也要参与显示侧替换（M3 契约 §3.2 修正） */
  presetId: string | null;
  /** `{{char}}` 的取值 */
  charName: string;
  /** `{{user}}` 的取值 */
  userName: string;
}

/**
 * 显示侧正则（契约 §7.2）：渲染 Markdown 前对消息文本应用 `direction:'display'` 的脚本。
 * 脚本 = 全局表 + 当前预设自带 + 当前角色卡自带（后两类导入时已抽进正则库），
 * 三个查询都缓存 5 分钟。
 * 存档与编辑框里始终是原文，这里只改渲染结果；无效正则由引擎静默跳过。
 */
export function useDisplayRegex({
  characterId,
  presetId,
  charName,
  userName,
}: DisplayRegexOptions): DisplayRegexFn {
  const global = useRegexScripts();
  const character = useCharacterRegex(characterId);
  const preset = usePresetRegex(presetId);

  // 合并顺序与 ST 的 `getRegexScripts` 一致：全局 → 预设自带 → 角色卡自带
  // （契约 §9 RX-9 与 §3.2 修正）。disabled / 方向过滤由引擎负责。
  const scripts = useMemo(
    () => [...(global.data ?? []), ...(preset.data ?? []), ...(character.data ?? [])],
    [global.data, preset.data, character.data],
  );

  return useCallback(
    (text, role, depth) => {
      if (!text || scripts.length === 0) return text;
      return applyRegexScripts(scripts, text, {
        placement: role === 'user' ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT,
        direction: 'display',
        depth,
        substitute: (value, postProcess) =>
          substituteMacros(value, {
            char: charName,
            user: userName,
            ...(postProcess ? { postProcess } : {}),
          }),
      });
    },
    [scripts, charName, userName],
  );
}
