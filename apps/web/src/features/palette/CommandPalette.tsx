import { Search } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

import { queryTokens, rankItems } from './match';
import { useUiStore, type ModeSetting } from '../../app/store/ui';
import { useCharacters, useChats, useCreateChat } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useBackdropStore } from '../backgrounds/api';
import { useWritingCommands, writingProjectIdOf } from '../writing/commands';
import { THEMES } from '../../themes/registry';

/* ------------------------------------------------------------------ */
/* 命令模型                                                             */
/* ------------------------------------------------------------------ */

type GroupId = 'actions' | 'writing' | 'chats' | 'pages' | 'characters' | 'themes';

/** 分组的显示顺序 */
const GROUP_ORDER: readonly GroupId[] = [
  'actions',
  'writing',
  'chats',
  'pages',
  'characters',
  'themes',
];

/** 分组标题；写作项目页的动作组文案在 `writing.*` 命名空间里 */
const groupLabelKey = (group: GroupId) =>
  group === 'writing' ? 'writing.palette.group' : `palette.groups.${group}`;

/** 空查询时每组最多列几项（查询时放宽） */
const IDLE_LIMIT: Partial<Record<GroupId, number>> = { chats: 6, characters: 6 };
const SEARCH_LIMIT: Partial<Record<GroupId, number>> = { chats: 12, characters: 12 };

interface PaletteCommand {
  id: string;
  group: GroupId;
  label: string;
  /** 名字右侧的次要信息（角色名、世界的一句话） */
  hint?: string;
  /** 搜得到但不显示的别名 */
  keywords?: readonly string[];
  /** 当前项（当前世界、当前模式、当前页面）：右侧标一枚「当前」 */
  current?: boolean;
  /** 只在有查询时出现（设置的各分区之类的二级入口） */
  searchOnly?: boolean;
  /** 返回 Promise 的命令执行期间面板保持打开，失败时原地提示 */
  run: () => void | Promise<unknown>;
}

export interface PaletteNavItem {
  to: string;
  /** `nav.<key>` */
  key: string;
}

const SETTINGS_SECTIONS = ['appearance', 'worldInfo', 'globalSystemPrompt', 'regex'] as const;
const MODES: readonly ModeSetting[] = ['light', 'dark', 'system'];

/* ------------------------------------------------------------------ */
/* 入口：全局快捷键 + 浮层                                               */
/* ------------------------------------------------------------------ */

/** 快捷键的显示文案：苹果系统 ⌘K，其余 Ctrl K */
export function paletteShortcutLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K';
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘K' : 'Ctrl K';
}

/**
 * 命令面板（`Ctrl/⌘ + K`）。挂在应用外壳里一次；打开状态在 `useUiStore.paletteOpen`，
 * 顶栏的搜索入口（触屏）也是改这个状态。
 */
export function CommandPalette({ navItems }: { navItems: readonly PaletteNavItem[] }) {
  const open = useUiStore((state) => state.paletteOpen);
  const setOpen = useUiStore((state) => state.setPaletteOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.altKey || event.shiftKey) return;
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 'k' && event.code !== 'KeyK') return;
      event.preventDefault();
      const state = useUiStore.getState();
      state.setPaletteOpen(!state.paletteOpen);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  if (!open) return null;
  return createPortal(
    <PaletteDialog navItems={navItems} onClose={() => setOpen(false)} />,
    document.body,
  );
}

/* ------------------------------------------------------------------ */
/* 浮层本体                                                             */
/* ------------------------------------------------------------------ */

function PaletteDialog({
  navItems,
  onClose,
}: {
  navItems: readonly PaletteNavItem[];
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const chats = useChats();
  const characters = useCharacters();
  const createChat = useCreateChat();
  const themeId = useUiStore((state) => state.themeId);
  const mode = useUiStore((state) => state.mode);

  const baseId = useId();
  const titleId = `${baseId}-title`;
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const inputRef = useRef<HTMLInputElement>(null);
  /** 输入框里的原文（输入法组合中也实时更新） */
  const [input, setInput] = useState('');
  /** 真正拿去过滤的查询：输入法组合期间不跟着拼音字母变 */
  const [query, setQuery] = useState('');
  const composingRef = useRef(false);
  const [activeIndex, setActiveIndex] = useState(0);
  /** 键盘移动选中项时才把它滚进视口；鼠标悬停不滚，免得列表在指针下乱跑 */
  const keyboardMoveRef = useRef(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const zh = i18n.language.startsWith('zh');
  const onChatPage = location.pathname === '/';
  const openChatId = onChatPage ? searchParams.get('c') : null;

  // 打开：锁住背后的滚动、聚焦输入框；关闭：焦点还给打开前的元素
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inputRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus?.();
    };
  }, []);

  /* ---------------- 命令源 ---------------- */

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = [];

    // 对话页里的操作：通过 store 的请求通道交给 ChatPage 响应
    if (openChatId) {
      list.push(
        {
          id: 'action:inspector',
          group: 'actions',
          label: t('palette.actions.inspector'),
          keywords: ['inspector', 'prompt', t('inspector.title')],
          run: () => useUiStore.getState().requestChatPanel('inspector'),
        },
        {
          id: 'action:session',
          group: 'actions',
          label: t('palette.actions.session'),
          keywords: ['session', 'panel', t('chat.panel.title')],
          run: () => useUiStore.getState().requestChatPanel('session'),
        },
        {
          // 切换背景（M4（二）§A.4）：打开会话面板并展开背景小节
          id: 'action:background',
          group: 'actions',
          label: t('backgrounds.paletteAction'),
          keywords: ['background', 'wallpaper', t('backgrounds.title')],
          run: () => {
            useUiStore.getState().requestChatPanel('session');
            useBackdropStore.getState().requestFocus();
          },
        },
      );
    }

    // 写作项目页里的操作（M7 §5.1）：交给 WritingProjectPage 响应
    if (writingProjectIdOf(location.pathname)) {
      const send = useWritingCommands.getState().send;
      list.push(
        {
          id: 'writing:newChapter',
          group: 'writing',
          label: t('writing.palette.newChapter'),
          keywords: ['chapter', 'new', t('writing.tree.chapters')],
          run: () => send('newChapter'),
        },
        {
          id: 'writing:aiContinue',
          group: 'writing',
          label: t('writing.palette.aiContinue'),
          keywords: ['ai', 'continue', t('writing.ai.actions.continue')],
          run: () => send('aiContinue'),
        },
        {
          id: 'writing:saveVersion',
          group: 'writing',
          label: t('writing.palette.saveVersion'),
          keywords: ['version', 'save', t('writing.tabs.versions')],
          run: () => send('saveVersion'),
        },
      );
    }

    // 最近对话：按最后一条消息的时间，新的在前；按标题 / 角色名匹配
    const recent = [...(chats.data ?? [])].sort((a, b) =>
      (b.lastMessageAt ?? b.updatedAt).localeCompare(a.lastMessageAt ?? a.updatedAt),
    );
    for (const chat of recent) {
      const characterName = chat.character?.name ?? '';
      const title = chat.title?.trim() || characterName || t('chat.list.untitled');
      list.push({
        id: `chat:${chat.id}`,
        group: 'chats',
        label: title,
        ...(characterName && characterName !== title ? { hint: characterName } : {}),
        keywords: characterName ? [characterName] : [],
        current: chat.id === openChatId,
        run: () => void navigate(`/?c=${encodeURIComponent(chat.id)}`),
      });
    }

    // 页面
    for (const item of navItems) {
      const active = item.to === '/' ? onChatPage : location.pathname.startsWith(item.to);
      list.push({
        id: `page:${item.to}`,
        group: 'pages',
        label: t(`nav.${item.key}`),
        keywords: [item.key, item.to],
        current: active && !(item.to === '/' && openChatId),
        run: () => void navigate(item.to),
      });
    }
    for (const section of SETTINGS_SECTIONS) {
      list.push({
        id: `page:settings:${section}`,
        group: 'pages',
        label: t('palette.settingsSection', { name: t(`settings.sections.${section}`) }),
        keywords: ['settings', section],
        searchOnly: true,
        run: () => void navigate(`/settings?section=${section}`),
      });
    }

    // 角色：选中 = 用这个角色新建一段对话（默认档案由服务端套用）
    const people = [...(characters.data ?? [])].sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    for (const character of people) {
      list.push({
        id: `character:${character.id}`,
        group: 'characters',
        label: character.name,
        hint: t('palette.newChat'),
        keywords: character.tags,
        run: () =>
          createChat
            .mutateAsync({ characterIds: [character.id] })
            .then((chat) => navigate(`/?c=${encodeURIComponent(chat.id)}`)),
      });
    }

    // 世界：六个主题；当前世界两种模式都有时再列出模式
    for (const theme of THEMES) {
      list.push({
        id: `theme:${theme.id}`,
        group: 'themes',
        label: zh ? theme.name.zh : theme.name.en,
        hint: zh ? theme.tagline.zh : theme.tagline.en,
        keywords: [theme.id, theme.name.zh, theme.name.en, 'theme', t('appearance.world')],
        current: theme.id === themeId,
        run: () => useUiStore.getState().setThemeId(theme.id),
      });
    }
    const currentTheme = THEMES.find((theme) => theme.id === themeId);
    if (currentTheme && currentTheme.modes.length > 1) {
      for (const value of MODES) {
        list.push({
          id: `mode:${value}`,
          group: 'themes',
          label: t('palette.mode', { name: t(`appearance.modes.${value}`) }),
          keywords: ['mode', value, t('appearance.mode')],
          current: mode === value,
          run: () => useUiStore.getState().setMode(value),
        });
      }
    }

    return list;
  }, [
    t,
    zh,
    navigate,
    navItems,
    location.pathname,
    onChatPage,
    openChatId,
    chats.data,
    characters.data,
    createChat,
    themeId,
    mode,
  ]);

  /* ---------------- 过滤与分组 ---------------- */

  const groups = useMemo(() => {
    const tokens = queryTokens(query);
    const searching = tokens.length > 0;
    const limits = searching ? SEARCH_LIMIT : IDLE_LIMIT;
    let offset = 0;
    const result: { id: GroupId; items: PaletteCommand[]; offset: number }[] = [];
    for (const group of GROUP_ORDER) {
      const candidates = commands.filter(
        (command) => command.group === group && (searching || !command.searchOnly),
      );
      const items = rankItems(candidates, tokens, limits[group]);
      if (items.length === 0) continue;
      result.push({ id: group, items, offset });
      offset += items.length;
    }
    return result;
  }, [commands, query]);

  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const active = flat.length === 0 ? -1 : Math.min(activeIndex, flat.length - 1);

  /** 查询变了从第一项开始 */
  const applyQuery = (value: string) => {
    setQuery(value);
    setActiveIndex(0);
  };

  useEffect(() => {
    if (!keyboardMoveRef.current || active < 0) return;
    keyboardMoveRef.current = false;
    document.getElementById(`${baseId}-option-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, baseId]);

  /* ---------------- 执行 ---------------- */

  const execute = useCallback(
    (command: PaletteCommand | undefined) => {
      if (!command || busyId) return;
      setError(null);
      const result = command.run();
      if (!(result instanceof Promise)) {
        onClose();
        return;
      }
      setBusyId(command.id);
      result.then(
        () => onClose(),
        (reason: unknown) => {
          setBusyId(null);
          setError(reason instanceof Error ? reason.message : String(reason));
        },
      );
    },
    [busyId, onClose],
  );

  const move = (delta: number) => {
    if (flat.length === 0) return;
    keyboardMoveRef.current = true;
    setActiveIndex((current) => {
      const base = Math.min(current, flat.length - 1);
      return (base + delta + flat.length) % flat.length;
    });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // 输入法组合中：回车是上屏、方向键是选词，一律不当作面板操作
    if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'Home':
        if (flat.length > 0 && input === '') {
          event.preventDefault();
          keyboardMoveRef.current = true;
          setActiveIndex(0);
        }
        break;
      case 'End':
        if (flat.length > 0 && input === '') {
          event.preventDefault();
          keyboardMoveRef.current = true;
          setActiveIndex(flat.length - 1);
        }
        break;
      case 'Enter':
        event.preventDefault();
        execute(flat[active]);
        break;
      case 'Escape':
        event.preventDefault();
        // 别让外面的模态 / 抽屉也跟着关
        event.stopPropagation();
        onClose();
        break;
      case 'Tab':
        // 焦点圈在面板里：唯一可聚焦的就是输入框
        event.preventDefault();
        break;
      default:
        break;
    }
  };

  const loading = chats.isPending || characters.isPending;
  const shortcut = paletteShortcutLabel();

  return (
    <div
      data-part="command-palette-overlay"
      className="surface-overlay fixed inset-0 z-50 flex items-start justify-center px-3 pt-[8dvh] transition-opacity duration-(--dur-panel) ease-(--ease) starting:opacity-0 motion-reduce:transition-none sm:px-4 sm:pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-part="command-palette"
        className="surface-raised edge-rule rounded-panel flex max-h-[min(34rem,80dvh)] w-full max-w-xl min-w-0 flex-col overflow-hidden border"
      >
        <h2 id={titleId} className="sr-only">
          {t('palette.title')}
        </h2>

        <div data-part="command-palette-header" className="edge-rule shrink-0 border-b p-3">
          <label
            data-part="command-palette-field"
            className="field flex h-10 min-w-0 cursor-text items-center gap-2.5 px-3"
          >
            <Search aria-hidden className="size-4 shrink-0 text-ink-3" />
            <input
              ref={inputRef}
              data-part="command-palette-input"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
              aria-label={t('palette.placeholder')}
              placeholder={t('palette.placeholder')}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
                if (!composingRef.current) applyQuery(event.target.value);
              }}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={(event) => {
                composingRef.current = false;
                applyQuery(event.currentTarget.value);
              }}
              onKeyDown={onKeyDown}
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
            />
            <kbd className="chip-outline hidden shrink-0 px-1.5 py-0.5 font-sans text-[10px] leading-none sm:inline-flex">
              Esc
            </kbd>
          </label>
        </div>

        <div
          id={listId}
          role="listbox"
          aria-label={t('palette.title')}
          data-part="command-palette-list"
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1.5"
        >
          {groups.map((group) => (
            <div
              key={group.id}
              role="group"
              aria-labelledby={`${baseId}-group-${group.id}`}
              data-part="command-palette-group"
              data-group={group.id}
              className="py-1"
            >
              <div
                id={`${baseId}-group-${group.id}`}
                role="presentation"
                data-part="command-palette-group-label"
                className="px-4 pt-1.5 pb-1 text-[11px] tracking-wide text-ink-3"
              >
                {t(groupLabelKey(group.id))}
              </div>
              {group.items.map((command, index) => {
                const flatIndex = group.offset + index;
                const isActive = flatIndex === active;
                const busy = busyId === command.id;
                return (
                  <div
                    key={command.id}
                    id={optionId(flatIndex)}
                    role="option"
                    aria-selected={isActive}
                    aria-busy={busy || undefined}
                    data-part="command-palette-item"
                    data-active={isActive}
                    data-group={group.id}
                    data-current={command.current ?? false}
                    className={cn(
                      'relative flex min-w-0 cursor-pointer items-baseline gap-3 px-4 py-2 text-sm',
                      isActive ? 'bg-accent-soft text-ink' : 'text-ink-story',
                    )}
                    // 保持输入框的焦点：点选不应让组合框失焦
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (!isActive) setActiveIndex(flatIndex);
                    }}
                    onClick={() => execute(command)}
                  >
                    {isActive && (
                      <span
                        aria-hidden
                        data-part="command-palette-marker"
                        className="absolute start-0 top-1/2 h-5 w-0.5 -translate-y-1/2 bg-accent"
                      />
                    )}
                    <span className="min-w-0 shrink truncate">{command.label}</span>
                    {command.hint && (
                      <span className="min-w-0 flex-1 truncate text-xs text-ink-3">
                        {command.hint}
                      </span>
                    )}
                    {!command.hint && <span className="flex-1" />}
                    {busy ? (
                      <span className="pulse-live shrink-0 text-[11px] text-ink-3">
                        {t('common.processing')}
                      </span>
                    ) : (
                      command.current && (
                        <span className="chip-accent shrink-0 self-center px-1.5 py-0.5 text-[10px] leading-none">
                          {t('palette.current')}
                        </span>
                      )
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {flat.length === 0 && (
            <p
              data-part="command-palette-empty"
              role="status"
              className="px-4 py-10 text-center text-sm text-ink-2"
            >
              {loading ? t('common.loading') : t('palette.empty', { query: query.trim() })}
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="edge-rule shrink-0 border-t px-4 py-2 text-xs text-danger">
            {t('palette.failed', { message: error })}
          </p>
        )}

        <div
          data-part="command-palette-footer"
          className="edge-rule hidden shrink-0 items-center gap-4 border-t px-4 py-2 text-[11px] text-ink-3 sm:flex"
        >
          <span className="inline-flex items-center gap-1.5">
            <kbd className="chip-outline px-1.5 py-0.5 font-sans text-[10px] leading-none">↑↓</kbd>
            {t('palette.hints.move')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <kbd className="chip-outline px-1.5 py-0.5 font-sans text-[10px] leading-none">↵</kbd>
            {t('palette.hints.run')}
          </span>
          <span className="ms-auto tabular-nums">{shortcut}</span>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 顶栏入口（触屏没有快捷键）                                            */
/* ------------------------------------------------------------------ */

export function CommandPaletteTrigger({ className }: { className?: string }) {
  const { t } = useTranslation();
  const setOpen = useUiStore((state) => state.setPaletteOpen);
  const shortcut = paletteShortcutLabel();
  return (
    <button
      type="button"
      data-part="command-palette-trigger"
      aria-label={t('palette.open')}
      aria-keyshortcuts="Control+K Meta+K"
      title={`${t('palette.open')} · ${shortcut}`}
      onClick={() => setOpen(true)}
      className={cn(
        'action-quiet focus-ring inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 px-2 text-xs text-ink-2 md:px-2.5',
        className,
      )}
    >
      <Search aria-hidden className="size-4" />
      <span className="hidden md:inline">{t('palette.open')}</span>
      <span className="hidden text-[11px] text-ink-3 tabular-nums md:inline">{shortcut}</span>
    </button>
  );
}
