import { applyRegexScripts, REGEX_PLACEMENT, substituteMacros } from '@newtavern/core';
import { useCallback, useMemo } from 'react';

import { useCharacterRegex, useRegexScripts, type MessageRole } from '../../lib/api';

/** 对一条消息文本做显示侧正则替换 */
export type DisplayRegexFn = (text: string, role: MessageRole, depth: number) => string;

export interface DisplayRegexOptions {
  characterId: string | null;
  /** `{{char}}` 的取值 */
  charName: string;
  /** `{{user}}` 的取值 */
  userName: string;
}

/**
 * 显示侧正则（契约 §7.2）：渲染 Markdown 前对消息文本应用 `direction:'display'` 的脚本。
 * 脚本 = 全局表（display_order）+ 当前角色卡内嵌脚本，两个查询都缓存 5 分钟。
 * 存档与编辑框里始终是原文，这里只改渲染结果；无效正则由引擎静默跳过。
 */
export function useDisplayRegex({
  characterId,
  charName,
  userName,
}: DisplayRegexOptions): DisplayRegexFn {
  const global = useRegexScripts();
  const character = useCharacterRegex(characterId);

  // ST 的合并顺序：全局 → 角色（契约 §9 RX-9）。disabled / 方向过滤由引擎负责。
  const scripts = useMemo(
    () => [...(global.data ?? []), ...(character.data ?? [])],
    [global.data, character.data],
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
