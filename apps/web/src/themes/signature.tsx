import { createContext, useContext, type ComponentType, type ReactNode } from 'react';

import { getTheme } from './registry';
import * as su from './su/signature';
import { useUiStore } from '../app/store/ui';
import { cn } from '../lib/utils';

/* ------------------------------------------------------------------ */
/* 契约：记忆物件的 props（DESIGN §2.2 末；作者文档见 themes/README.md） */
/* ------------------------------------------------------------------ */

export type MessageRole = 'user' | 'assistant' | 'system';

/** 发送键。`ready` = 有内容可发；`idle` = 空输入；`generating` = 变成停止键 */
export type SendButtonState = 'idle' | 'ready' | 'generating';

export interface SendButtonProps {
  state: SendButtonState;
  disabled: boolean;
  /** 无障碍名称（已本地化），同时作为原生 tooltip */
  label: string;
  onClick: () => void;
}

export interface SwipeIndicatorProps {
  /** 当前兄弟下标，从 0 起 */
  index: number;
  total: number;
  /** 生成中：两个方向都不可点 */
  busy: boolean;
  labels: { prev: string; next: string; new: string };
  onPrev: () => void;
  /** 已经在最后一项时由调用方接成「再生成一条」 */
  onNext: () => void;
}

export type AvatarRole = 'user' | 'character' | 'system';

export interface AvatarFrameProps {
  role: AvatarRole;
  /** 只用来传尺寸（`size-9` 之类），形状与描边由主题决定 */
  className?: string;
  children: ReactNode;
}

export interface MessageDividerProps {
  /** 分隔线下方那条消息的角色 */
  role: MessageRole;
  /** 下方那条消息在路径中的下标（从 0 起；0 不会被渲染） */
  index: number;
}

export type EmptyIllustrationKind =
  'chat' | 'chats' | 'characters' | 'presets' | 'lorebooks' | 'personas' | 'connections' | 'regex';

export interface EmptyIllustrationProps {
  kind: EmptyIllustrationKind;
  className?: string;
}

export interface StreamingCursorProps {
  /** 正文光标与推理区光标可以不同 */
  kind: 'text' | 'reasoning';
}

export interface MessageOrnamentProps {
  role: MessageRole;
  /** 消息节点 id：需要「随机但对这条消息固定」的装饰用 `stablePick(id, …)` */
  id: string;
  /** 在当前路径里的下标（从 0 起） */
  index: number;
}

/** `app` = 应用外壳里（fixed 铺满视口）；`preview` = 外观页预览卡里（absolute 裁在卡内） */
export type BackdropScope = 'app' | 'preview';

export interface BackdropProps {
  scope: BackdropScope;
}

export interface ThemeSignature {
  SendButton: ComponentType<SendButtonProps>;
  SwipeIndicator: ComponentType<SwipeIndicatorProps>;
  AvatarFrame: ComponentType<AvatarFrameProps>;
  MessageDivider: ComponentType<MessageDividerProps>;
  EmptyIllustration: ComponentType<EmptyIllustrationProps>;
  StreamingCursor: ComponentType<StreamingCursorProps>;
  /**
   * 消息装饰层：渲染在 `[data-part='message-ornament']` 里——
   * 那是 `[data-part='message']` 内部一个 `absolute inset-0`、`pointer-events: none`、`aria-hidden` 的层。
   * 酒馆的铆钉、暖房的贴纸。默认什么也不画。
   */
  MessageOrnament: ComponentType<MessageOrnamentProps>;
  /**
   * 背景层：渲染在 `[data-part='backdrop']` 里——
   * app 外壳最底层一次（`fixed inset-0`），预览卡里一次（`absolute inset-0`），都在内容之下、不接事件。
   * 雨夜的雨与颗粒、琉璃的折射光。默认什么也不画。
   */
  Backdrop: ComponentType<BackdropProps>;
}

/* ------------------------------------------------------------------ */
/* 默认实现 = 「素」的实现                                              */
/* ------------------------------------------------------------------ */

function Nothing(): null {
  return null;
}

/**
 * 引擎的最小形态就是「素」，所以 `_default` 直接引用 `themes/su/signature.tsx`，
 * 不再另写一份。主题只提供自己想换掉的那几件。
 */
export const _default: ThemeSignature = {
  SendButton: su.SendButton,
  SwipeIndicator: su.SwipeIndicator,
  AvatarFrame: su.AvatarFrame,
  MessageDivider: su.MessageDivider,
  EmptyIllustration: su.EmptyIllustration,
  StreamingCursor: su.StreamingCursor,
  MessageOrnament: Nothing,
  Backdrop: Nothing,
};

const cache = new Map<string, ThemeSignature>();

/** 某个主题的完整记忆物件表（缺的补 `_default`） */
export function signatureOf(themeId: string): ThemeSignature {
  const cached = cache.get(themeId);
  if (cached) return cached;
  const resolved = { ..._default, ...(getTheme(themeId).signature ?? {}) };
  cache.set(themeId, resolved);
  return resolved;
}

/* ------------------------------------------------------------------ */
/* 注入                                                                */
/* ------------------------------------------------------------------ */

const ScopeContext = createContext<string | null>(null);

/**
 * 把一棵子树按指定主题渲染（设置页的活预览卡用）。
 * 注意：还要在同一个 DOM 节点上写 `data-theme` / `data-mode` / `data-opt-*`，CSS 才会跟着换。
 */
export function SignatureScope({ themeId, children }: { themeId: string; children: ReactNode }) {
  return <ScopeContext.Provider value={themeId}>{children}</ScopeContext.Provider>;
}

/** 当前（或被 SignatureScope 指定的）主题的记忆物件 */
export function useSignature(): ThemeSignature {
  const scoped = useContext(ScopeContext);
  const active = useUiStore((state) => state.themeId);
  return signatureOf(scoped ?? active);
}

/* ------------------------------------------------------------------ */
/* 引擎负责定位的两层（主题组件只管画）                                  */
/* ------------------------------------------------------------------ */

/** 背景层：`[data-part='backdrop'][data-scope]`，定位与层级由引擎保证 */
export function BackdropLayer({ scope }: BackdropProps) {
  const { Backdrop } = useSignature();
  return (
    <div
      data-part="backdrop"
      data-scope={scope}
      aria-hidden
      className={cn(
        'pointer-events-none inset-0 -z-10 overflow-hidden',
        scope === 'app' ? 'fixed' : 'absolute',
      )}
    >
      <Backdrop scope={scope} />
    </div>
  );
}

/** 消息装饰层：`[data-part='message-ornament']`，铺满所在的 `[data-part='message']` */
export function MessageOrnamentLayer(props: MessageOrnamentProps) {
  const { MessageOrnament } = useSignature();
  return (
    <div data-part="message-ornament" aria-hidden className="pointer-events-none absolute inset-0">
      <MessageOrnament {...props} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 给主题用的小工具                                                     */
/* ------------------------------------------------------------------ */

/** 字符串 → 稳定的 32 位无符号整数（FNV-1a）；同一个 id 永远得到同一个数 */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 按 id 从候选里稳定地挑一个（「随机但对该消息固定」的贴纸） */
export function stablePick<T>(id: string, items: readonly T[]): T {
  if (items.length === 0) throw new Error('stablePick: items 不能为空');
  return items[stableHash(id) % items.length] as T;
}
