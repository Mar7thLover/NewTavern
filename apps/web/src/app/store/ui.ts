import { DEFAULT_LANGUAGE, type Language } from '@newtavern/i18n';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ThemeSetting = 'light' | 'dark' | 'system';

interface UiState {
  language: Language;
  theme: ThemeSetting;
  setLanguage: (language: Language) => void;
  setTheme: (theme: ThemeSetting) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      language: DEFAULT_LANGUAGE,
      theme: 'dark',
      setLanguage: (language) => set({ language }),
      setTheme: (theme) => set({ theme }),
    }),
    { name: 'newtavern-ui' },
  ),
);
