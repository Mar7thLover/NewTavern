import { DEFAULT_LANGUAGE, type Language } from '@newtavern/i18n';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { DEFAULT_THEME_ID, type ModeSetting, type ThemeOptionValue } from '../../themes/registry';

export type { ModeSetting };

interface UiState {
  language: Language;
  /** 住进哪个世界（themes/<id>） */
  themeId: string;
  /** 白天 / 夜晚 / 跟随系统；主题不支持时由 applyTheme 回落 */
  mode: ModeSetting;
  /** 每个主题各自的选项（布尔开关）；没存过的 key 用 ThemeMeta.options 的 default */
  themeOptions: Record<string, Record<string, ThemeOptionValue>>;
  setLanguage: (language: Language) => void;
  setThemeId: (themeId: string) => void;
  setMode: (mode: ModeSetting) => void;
  setThemeOption: (themeId: string, key: string, value: ThemeOptionValue) => void;
}

/** v1 只有一个 `theme: 'light' | 'dark' | 'system'` 字段 */
interface PersistedV1 {
  language?: Language;
  theme?: ModeSetting;
}

/** v2：language / themeId / mode */
interface PersistedV2 {
  language?: Language;
  themeId?: string;
  mode?: ModeSetting;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      language: DEFAULT_LANGUAGE,
      themeId: DEFAULT_THEME_ID,
      mode: 'light',
      themeOptions: {},
      setLanguage: (language) => set({ language }),
      setThemeId: (themeId) => set({ themeId }),
      setMode: (mode) => set({ mode }),
      setThemeOption: (themeId, key, value) =>
        set((state) => ({
          themeOptions: {
            ...state.themeOptions,
            [themeId]: { ...state.themeOptions[themeId], [key]: value },
          },
        })),
    }),
    {
      name: 'newtavern-ui',
      version: 3,
      partialize: (state) => ({
        language: state.language,
        themeId: state.themeId,
        mode: state.mode,
        themeOptions: state.themeOptions,
      }),
      migrate: (persisted, version) => {
        if (version >= 3) return persisted as unknown as UiState;
        if (version === 2) {
          // v2 → v3：只是多了 themeOptions（若旧数据里已经带着就保留）
          const old = (persisted ?? {}) as PersistedV2 & Partial<Pick<UiState, 'themeOptions'>>;
          return { ...old, themeOptions: old.themeOptions ?? {} } as unknown as UiState;
        }
        // v1 → v3：旧设置里的 theme 就是新的 mode，主题一律从「素」开始
        const old = (persisted ?? {}) as PersistedV1;
        return {
          ...(old.language ? { language: old.language } : {}),
          themeId: DEFAULT_THEME_ID,
          mode: old.theme ?? 'light',
          themeOptions: {},
        } as unknown as UiState;
      },
    },
  ),
);
