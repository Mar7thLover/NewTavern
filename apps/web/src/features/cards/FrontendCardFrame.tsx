import {
  buildSrcdoc,
  createFrameChannel,
  createNonce,
  guestBootstrapSource,
  sandboxAttribute,
  type FrameChannel,
  type FrontendCardTrustLevel,
  type SandboxFrameInfo,
} from '@newtavern/sandbox-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { emitCompat, subscribeBus } from './bus';
import { createCardHandlers, buildChatMirror, type CardHostContext } from './host-bridge';
import { EXTERNAL_SCRIPTS, EXTERNAL_STYLES, selectSandboxLibs } from './libs';
import { useCardSettings, useChatVariables, trustFor } from '../../lib/api-cards';
import { queryKeys, useChat, useCharacter } from '../../lib/api';
import { cn } from '../../lib/utils';

/**
 * 一张前端卡 = 一个沙箱 iframe。见 docs/M5-CONTRACT.md §4.
 *
 * 这里只管**帧的生命周期**：srcdoc、通道、镜像、高度、错误提示。
 * 卡能做什么由 `host-bridge.ts` 的 handlers 决定。
 *
 * 高度：iframe 的内容高度由 guest 用 `ResizeObserver` 报上来。
 * 含 iframe 的消息不进虚拟滚动的高度缓存（`MessageList` 那边已经按 `data-nt-card` 排除），
 * 否则高度回报与虚拟化互相追着跑。
 */

const MIN_HEIGHT = 40;
const MAX_HEIGHT = 4000;

export interface FrontendCardFrameProps {
  chatId: string;
  /** 所在消息节点；脚本帧用 `ScriptRunner` 而不是这个组件 */
  nodeId: string;
  /** 楼层号（当前分支 root→head 的下标） */
  messageId: number;
  /** 同一条消息里的第几张卡 */
  index: number;
  html: string;
  /** 主题槽位变量（`--accent` 等）：卡可以贴合当前世界 */
  themeCss?: string;
  className?: string;
}

export function FrontendCardFrame({
  chatId,
  nodeId,
  messageId,
  index,
  html,
  themeCss,
  className,
}: FrontendCardFrameProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const channelRef = useRef<FrameChannel | null>(null);
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [errors, setErrors] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [generation, setGeneration] = useState(0);

  const chat = useChat(chatId);
  const characterId = chat.data?.characterIds[0] ?? null;
  const character = useCharacter(characterId);
  const variables = useChatVariables(chatId, nodeId);
  const settings = useCardSettings();

  const trust: FrontendCardTrustLevel = trustFor(settings.data, characterId);
  const frameId = `${nodeId}:${index}`;
  // 取回来了（或确定取不到）才建帧，见下面的占位分支
  const variablesReady = variables.isSuccess || variables.isError;

  /** 帧身份：srcdoc 里注入，guest 的 `getCurrentMessageId` / `getIframeName` 用它 */
  const frameInfo: SandboxFrameInfo = useMemo(
    () => ({
      frameId,
      kind: 'message',
      nodeId,
      messageId,
      scriptId: null,
      scriptName: null,
      trust,
      index,
    }),
    [frameId, nodeId, messageId, trust, index],
  );

  /** 镜像：同步 getter 的数据源。数据变了推新快照，不重建 iframe（卡的状态不能丢） */
  const context = useMemo<CardHostContext>(() => {
    const table = variables.data;
    return {
      chatId,
      nodeId,
      detail: chat.data,
      charData: character.data?.data ?? null,
      variables: {
        message: table?.message ?? {},
        chat: table?.chat ?? {},
        character: table?.character ?? {},
        global: table?.global ?? {},
        script: {},
      },
      macros: {
        char: chat.data?.character?.name ?? '',
        user: '',
        description: '',
        personality: '',
        scenario: '',
        lastMessageId: messageId,
        variables: table?.message ?? {},
      },
    };
  }, [chatId, nodeId, chat.data, character.data, variables.data, messageId]);

  const contextRef = useRef(context);
  contextRef.current = context;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    void queryClient.invalidateQueries({ queryKey: ['chats', chatId, 'variables'] });
  }, [queryClient, chatId]);

  const notify = useCallback(
    (level: string, message: string) => {
      // 卡的提示直接进控制台 + 错误面板：应用自己的提示条在 M5（三）统一做
      if (level === 'error' || level === 'warning') {
        setErrors((current) => [...current.slice(-9), `${level}: ${message}`]);
      }
      console.info(`[前端卡 ${frameId}] ${level}: ${message}`);
    },
    [frameId],
  );

  const handlers = useMemo(
    () =>
      createCardHandlers(() => contextRef.current, {
        notify,
        emit: (event, args) => emitCompat(event, ...args),
        invalidate,
        onGenerationEvent: (event, args) => channelRef.current?.emitEvent(event, args),
      }),
    [notify, invalidate],
  );

  /**
   * srcdoc 只依赖卡的 HTML 与信任级别：**不能**把镜像放进依赖，
   * 否则每次变量变化都会重建 iframe，卡的内部状态（展开状态、动画）全丢。
   * 首屏镜像用 ref 里的当前值，之后靠 `pushMirror` 更新。
   */
  const srcdoc = useMemo(() => {
    const nonce = createNonce();
    const current = contextRef.current;
    const externals = settings.data?.externalLibs !== false;
    return {
      nonce,
      doc: buildSrcdoc({
        html,
        nonce,
        frame: frameInfo,
        trust,
        appOrigin: window.location.origin,
        libs: selectSandboxLibs(html),
        ...(externals ? { externalScripts: EXTERNAL_SCRIPTS, externalStyles: EXTERNAL_STYLES } : {}),
        ...(themeCss ? { themeCss } : {}),
        bootstrap: guestBootstrapSource(),
        mirrors: {
          chatMessages: buildChatMirror(current),
          variables: current.variables,
          charData: current.charData,
          macroContext: current.macros,
        },
      }),
    };
    // `generation` 变化 = 用户点了「重新加载」；镜像**故意**不在依赖里（见上）。
    // `variablesReady` 必须在依赖里：hooks 在占位分支之前就跑了，不带它的话
    // 首屏那次（变量还没到）算出来的空镜像会被缓存住，卡拿到的就是一屏「未知」。
  }, [html, frameInfo, trust, themeCss, settings.data?.externalLibs, generation, variablesReady]);

  /** 帧通道：iframe 元素在，就建通道；卸载或重载时销毁 */
  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    setErrors([]);
    const channel = createFrameChannel({
      frame: element,
      nonce: srcdoc.nonce,
      frameId,
      handlers,
      onHeight: (value) => setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(value)))),
      onError: (error) => {
        // 也写一条控制台：卡作者按 F12 能直接看到栈，比只在小面板里显示一行有用
        console.warn(`[前端卡 ${frameId}]`, error.message, error.stack ?? '');
        setErrors((current) => [...current.slice(-9), error.message]);
      },
      onLog: (level, args) => {
        if (level === 'error' || level === 'warn') {
          setErrors((current) => [...current.slice(-9), args.map((arg) => String(arg)).join(' ')]);
        }
      },
    });
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.dispose();
    };
  }, [srcdoc, frameId, handlers]);

  /** 数据变化 → 推镜像 */
  useEffect(() => {
    const channel = channelRef.current;
    if (!channel) return;
    channel.pushMirror('variables', context.variables);
    channel.pushMirror('chatMessages', buildChatMirror(context));
    channel.pushMirror('charData', context.charData);
    channel.pushMirror('macroContext', context.macros);
  }, [context]);

  /** 应用事件 → 帧内事件（卡的 `eventOn` 收得到） */
  useEffect(() =>
    subscribeBus((event, args) => {
      channelRef.current?.emitEvent(event, args);
    }),
  );

  const dangerous = trust === 'legacy-unsafe';

  // 变量还没取回来就先别建帧：社区卡普遍在 `$(init)` 里**同步**读一次变量把界面画出来，
  // 之后只在 MVU 事件时刷新。用空镜像把它跑起来，画出来的就是一屏「未知」。
  if (!variablesReady) {
    return (
      <div
        data-part="frontend-card-placeholder"
        className={cn(
          'rounded-card edge-rule my-3 flex h-16 items-center justify-center border border-dashed text-[12px] text-ink-3 first:mt-0',
          className,
        )}
      >
        {t('cards.loading')}
      </div>
    );
  }

  return (
    <div
      data-part="frontend-card"
      data-nt-card=""
      data-trust={trust}
      className={cn('relative my-3 first:mt-0', className)}
    >
      <iframe
        ref={frameRef}
        title={t('cards.frameTitle')}
        srcDoc={srcdoc.doc}
        sandbox={sandboxAttribute(trust)}
        referrerPolicy="no-referrer"
        loading="lazy"
        className="rounded-card edge-rule block w-full border bg-transparent"
        style={{ height }}
      />

      {/* 操作条：hover 才显出来，不抢卡本身的注意力 */}
      <div className="pointer-events-none absolute end-1 top-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
        {dangerous && (
          <span
            title={t('cards.legacyWarning')}
            className="pointer-events-auto rounded-full bg-danger/10 p-1 text-danger"
          >
            <ShieldAlert className="size-3.5" aria-hidden />
          </span>
        )}
        {errors.length > 0 && (
          <button
            type="button"
            onClick={() => setShowErrors((value) => !value)}
            title={t('cards.errors', { count: errors.length })}
            className="pointer-events-auto cursor-pointer rounded-full bg-surface-2 p-1 text-warning"
          >
            <AlertTriangle className="size-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          onClick={() => setGeneration((value) => value + 1)}
          title={t('cards.reload')}
          className="pointer-events-auto cursor-pointer rounded-full bg-surface-2 p-1 text-ink-3 hover:text-ink"
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
      </div>

      {showErrors && errors.length > 0 && (
        <ul className="rounded-card edge-rule mt-1 space-y-1 border bg-surface-2 p-2 text-[12px] text-ink-2">
          {errors.map((error, errorIndex) => (
            <li key={`${errorIndex}-${error.slice(0, 16)}`} className="font-mono break-all">
              {error}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
