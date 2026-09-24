import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { i18nReady } from './app/i18n';
import { AppRouter } from './app/router';
import { useUiStore } from './app/store/ui';
import './index.css';
import { applyTheme, loadThemeAssets } from './themes/apply';

const queryClient = new QueryClient();

// 先把世界搭好再渲染：主题 CSS 是按需 chunk，等它到齐才不会闪一下「素」的回退值
const { themeId, mode, themeOptions } = useUiStore.getState();
applyTheme(themeId, mode, themeOptions);

const root = createRoot(document.getElementById('root')!);

// 主题与非缺省语言的词典都是按需 chunk，并行等齐再渲染
void Promise.allSettled([loadThemeAssets(themeId), i18nReady]).finally(() => {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AppRouter />
      </QueryClientProvider>
    </StrictMode>,
  );
});
