import en from './en.json' with { type: 'json' };
import zhCN from './zh-CN.json' with { type: 'json' };

export const SUPPORTED_LANGUAGES = ['zh-CN', 'en'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'zh-CN';

export const LANGUAGE_LABELS: Record<Language, string> = {
  'zh-CN': '简体中文',
  en: 'English',
};

export const resources: Record<Language, { translation: typeof zhCN }> = {
  'zh-CN': { translation: zhCN },
  en: { translation: en },
};

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}
