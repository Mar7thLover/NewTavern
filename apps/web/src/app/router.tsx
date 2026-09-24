import { lazy, type ComponentType } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router';

import { AppLayout } from './AppLayout';

/* ------------------------------------------------------------------ */
/* 路由级代码分割（M4 §4）                                               */
/* ------------------------------------------------------------------ */

/**
 * 页面模块的加载器。只加载一次（同一个 Promise），
 * `React.lazy` 与预取共用它：预取过的页面，导航时不会再等网络。
 */
function pageLoader<M>(load: () => Promise<M>): () => Promise<M> {
  let pending: Promise<M> | null = null;
  return () => {
    pending ??= load().catch((error: unknown) => {
      // 失败（离线、部署后旧 chunk 不存在）不缓存，下次导航重试
      pending = null;
      throw error;
    });
    return pending;
  };
}

/** 命名导出的页面组件 → `React.lazy` 需要的 `{ default }` 形状 */
function lazyPage<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => ({ default: (await load())[name] as ComponentType }));
}

const loaders = {
  chat: pageLoader(() => import('../features/chat/ChatPage')),
  characters: pageLoader(() => import('../features/library/CharactersPage')),
  presets: pageLoader(() => import('../features/library/PresetsPage')),
  presetEditor: pageLoader(() => import('../features/library/PresetEditorPage')),
  lorebooks: pageLoader(() => import('../features/library/LorebooksPage')),
  lorebookEditor: pageLoader(() => import('../features/library/LorebookEditorPage')),
  personas: pageLoader(() => import('../features/library/PersonasPage')),
  connections: pageLoader(() => import('../features/settings/ConnectionsPage')),
  migration: pageLoader(() => import('../features/migration/MigrationPage')),
  settings: pageLoader(() => import('../features/settings/SettingsPage')),
  writing: pageLoader(() => import('../features/writing/WritingListPage')),
  studio: pageLoader(() => import('../features/studio/StudioHomePage')),
};

/**
 * 写作项目页带 TipTap 编辑器（M7 §5.2）：单独分块，不进首屏，也不参加空闲预取
 * （写作列表页空闲时自己预取它）；直接打开 `/writing/:id` 时照常首先下载。
 */
const writingProjectLoader = pageLoader(() => import('../features/writing/WritingProjectPage'));

/**
 * 创作工作台（M6 §4）：编辑器 + 测试对话 + AI 协作，单独分块、不参加空闲预取
 * （不进首屏、不参加空闲预取；直接打开 `/studio/:kind/:id` 时照常首先下载）。
 */
const studioWorkbenchLoader = pageLoader(() => import('../features/studio/StudioWorkbenchPage'));

const ChatPage = lazyPage(loaders.chat, 'ChatPage');
const CharactersPage = lazyPage(loaders.characters, 'CharactersPage');
const PresetsPage = lazyPage(loaders.presets, 'PresetsPage');
const PresetEditorPage = lazyPage(loaders.presetEditor, 'PresetEditorPage');
const LorebooksPage = lazyPage(loaders.lorebooks, 'LorebooksPage');
const LorebookEditorPage = lazyPage(loaders.lorebookEditor, 'LorebookEditorPage');
const PersonasPage = lazyPage(loaders.personas, 'PersonasPage');
const ConnectionsPage = lazyPage(loaders.connections, 'ConnectionsPage');
const MigrationPage = lazyPage(loaders.migration, 'MigrationPage');
const SettingsPage = lazyPage(loaders.settings, 'SettingsPage');
const WritingListPage = lazyPage(loaders.writing, 'WritingListPage');
const WritingProjectPage = lazyPage(writingProjectLoader, 'WritingProjectPage');
const StudioHomePage = lazyPage(loaders.studio, 'StudioHomePage');
const StudioWorkbenchPage = lazyPage(studioWorkbenchLoader, 'StudioWorkbenchPage');

/** 路径 → 页面加载器（只用于预取首屏页面；路由表本身在下面） */
const LOADER_BY_PATH: [RegExp, () => Promise<unknown>][] = [
  [/^\/$/, loaders.chat],
  [/^\/characters/, loaders.characters],
  [/^\/presets\/[^/]+/, loaders.presetEditor],
  [/^\/presets/, loaders.presets],
  [/^\/lorebooks\/[^/]+/, loaders.lorebookEditor],
  [/^\/lorebooks/, loaders.lorebooks],
  [/^\/personas/, loaders.personas],
  [/^\/connections/, loaders.connections],
  [/^\/migration/, loaders.migration],
  [/^\/settings/, loaders.settings],
  [/^\/studio\/[^/]+\/[^/]+/, studioWorkbenchLoader],
  [/^\/studio/, loaders.studio],
  [/^\/writing\/[^/]+/, writingProjectLoader],
  [/^\/writing/, loaders.writing],
];

/** 首屏要用的页面立刻开始下载（与主包并行），其余等浏览器空闲时预取 */
function preloadPages() {
  if (typeof window === 'undefined') return;
  const path = window.location.pathname;
  const first = LOADER_BY_PATH.find(([pattern]) => pattern.test(path))?.[1];
  void first?.().catch(() => undefined);

  const rest = () => {
    for (const load of Object.values(loaders)) void load().catch(() => undefined);
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(rest, { timeout: 4000 });
  else setTimeout(rest, 1500);
}

preloadPages();

const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <ChatPage /> },
      { path: '/characters', element: <CharactersPage /> },
      { path: '/presets', element: <PresetsPage /> },
      { path: '/presets/:id', element: <PresetEditorPage /> },
      { path: '/lorebooks', element: <LorebooksPage /> },
      { path: '/lorebooks/:id', element: <LorebookEditorPage /> },
      { path: '/personas', element: <PersonasPage /> },
      { path: '/studio', element: <StudioHomePage /> },
      { path: '/studio/:kind/:id', element: <StudioWorkbenchPage /> },
      { path: '/writing', element: <WritingListPage /> },
      { path: '/writing/:projectId', element: <WritingProjectPage /> },
      { path: '/connections', element: <ConnectionsPage /> },
      { path: '/migration', element: <MigrationPage /> },
      { path: '/settings', element: <SettingsPage /> },
    ],
  },
]);

export function AppRouter() {
  return <RouterProvider router={router} />;
}
