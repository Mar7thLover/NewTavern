import { DEFAULT_LANGUAGE, resources } from '@newtavern/i18n';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { useUiStore } from './store/ui';

void i18n.use(initReactI18next).init({
  resources,
  lng: useUiStore.getState().language,
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
});

document.documentElement.lang = i18n.language;

// store 是语言的唯一真源；i18next 跟随
useUiStore.subscribe((state) => {
  if (i18n.language !== state.language) {
    void i18n.changeLanguage(state.language);
    document.documentElement.lang = state.language;
  }
});

export { i18n };
