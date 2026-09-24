import { DEFAULT_LANGUAGE, type Language } from '@newtavern/i18n';
import zhCN from '@newtavern/i18n/locales/zh-CN.json';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { useUiStore } from './store/ui';

/**
 * 词典按需加载：缺省语言（也是回退语言）随首屏打包，其余语言切过去时才下载。
 * 两份词典各 80 KB 上下，全进首屏会让 index chunk 白胖一截。
 */
const loaders: Partial<Record<Language, () => Promise<{ default: typeof zhCN }>>> = {
  en: () => import('@newtavern/i18n/locales/en.json'),
};

async function ensureLanguage(lng: Language): Promise<void> {
  if (i18n.hasResourceBundle(lng, 'translation')) return;
  const load = loaders[lng];
  if (!load) return;
  const mod = await load();
  i18n.addResourceBundle(lng, 'translation', mod.default);
}

async function switchTo(lng: Language): Promise<void> {
  try {
    await ensureLanguage(lng);
  } catch {
    // 词典 chunk 下载失败：留在当前语言，回退语言的词条照常可用
    return;
  }
  // 等待期间用户可能又切了别的语言，以 store 为准
  if (useUiStore.getState().language !== lng) return;
  if (i18n.language !== lng) await i18n.changeLanguage(lng);
  document.documentElement.lang = lng;
}

/** main.tsx 渲染前等它：首帧就是用户选的语言，不闪一下中文 */
export const i18nReady: Promise<void> = (async () => {
  await i18n.use(initReactI18next).init({
    resources: { [DEFAULT_LANGUAGE]: { translation: zhCN } },
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    interpolation: { escapeValue: false },
  });
  document.documentElement.lang = DEFAULT_LANGUAGE;
  await switchTo(useUiStore.getState().language);
})();

// store 是语言的唯一真源；i18next 跟随
useUiStore.subscribe((state) => {
  if (i18n.language !== state.language) void switchTo(state.language);
});

export { i18n };
