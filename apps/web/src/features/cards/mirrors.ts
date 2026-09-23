import type { SandboxPresetsMirror, SandboxRegexMirror } from '@newtavern/sandbox-sdk';
import { useMemo } from 'react';

import { toHelperPreset } from './preset-mirror';
import { useThemeCss } from './theme-mirror';
import {
  useCharacterRegex,
  usePreset,
  usePresetRegex,
  usePresets,
  useRegexScripts,
  type ChatDetail,
} from '../../lib/api';

/**
 * 前端卡帧与脚本帧共用的「同步接口镜像」（M5（三）§3.2 / §3.4）：
 *
 * - `presets`：`getPreset('in_use')` / `getPresetNames` / `getLoadedPresetName`；
 * - `regex`：`formatAsTavernRegexedString` 用的脚本（与显示侧同一套选择：全局 → 当前预设 → 当前角色卡）；
 * - `theme`：当前世界的槽位声明串。
 *
 * 数据变了只推镜像、不重建 iframe（卡的内部状态不能丢）。
 */
export interface CardMirrors {
  presets: SandboxPresetsMirror;
  regex: SandboxRegexMirror;
  theme: string;
}

export function useCardMirrors(detail: ChatDetail | undefined): CardMirrors {
  const presetId = detail?.presetId ?? null;
  const characterId = detail?.characterIds[0] ?? null;
  const presetList = usePresets();
  const preset = usePreset(presetId);
  const globalRegex = useRegexScripts();
  const presetRegex = usePresetRegex(presetId);
  const characterRegex = useCharacterRegex(characterId);
  const theme = useThemeCss();

  const presets = useMemo<SandboxPresetsMirror>(
    () => ({
      names: (presetList.data ?? []).map((item) => item.name),
      loaded: preset.data?.name ?? '',
      current: preset.data ? toHelperPreset(preset.data.data) : null,
    }),
    [presetList.data, preset.data],
  );

  const regex = useMemo<SandboxRegexMirror>(
    () => ({
      scripts: [
        ...(globalRegex.data ?? []),
        ...(presetRegex.data ?? []),
        ...(characterRegex.data ?? []),
      ],
      charName: detail?.character?.name ?? '',
      userName: '',
    }),
    [globalRegex.data, presetRegex.data, characterRegex.data, detail?.character?.name],
  );

  return useMemo(() => ({ presets, regex, theme }), [presets, regex, theme]);
}
