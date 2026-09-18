import { splitCardSegments } from '@newtavern/core';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MessageItem } from './MessageItem';
import { useDisplayRegex } from './useDisplayRegex';
import type { GenerationController } from './useGeneration';
import { useChatStore } from '../../app/store/chat';
import { Button } from '../../components/ui/button';
import { IconButton } from '../../components/ui/icon-button';
import { nodeText, usePersonas, type ChatDetail, type MessageNode } from '../../lib/api';
import { cn } from '../../lib/utils';
import { slotSeconds } from '../../themes/apply';
import { useSignature } from '../../themes/signature';

/** 用户上滑超过这个距离就停止自动跟随 */
const FOLLOW_THRESHOLD_PX = 96;
/** 列表上下留白（原 `py-8`）：上方算进虚拟列表的 paddingStart，下方放在尾部区块 */
const LIST_PADDING_Y = 32;
/** 视口外各多渲染几条：滚动时提前挂载，出现动画在进入视口前就已放完 */
const OVERSCAN = 4;
/** 「回到底部」超过几屏就直接跳，不做平滑滚动（途中未测量的消息会改变总高度，动画落不到底） */
const SMOOTH_MAX_SCREENS = 2;

/** 消息列（与原先的内层容器同宽同边距）：居中、最宽 3xl、两侧 16px / ≥sm 24px */
const COLUMN = 'mx-auto w-full max-w-3xl min-w-0 px-4 sm:px-6';

export interface MessageListProps {
  chat: ChatDetail;
  /** root→head 的线性路径 */
  path: MessageNode[];
  generation: GenerationController;
  onSwitchSibling: (siblingId: string) => void;
  onRegenerate: (node: MessageNode) => void;
}

/**
 * 消息列表（M4 §4 虚拟化）。
 *
 * 按对话 id 重建：测量缓存、滚动位置、跟随状态都只属于一个对话，
 * 切换对话时整块重建，新对话直接落在底部。
 */
export function MessageList(props: MessageListProps) {
  return <VirtualMessageList key={props.chat.id} {...props} />;
}

/**
 * DOM 结构（主题挂点保持不变）：
 *
 * ```
 * div.relative                       ← 酒馆在这一层画缝线（:has(> message-list)）
 *   [data-part=message-list]         ← 滚动容器，position: relative
 *     div[aria-hidden]               ← 撑出虚拟总高度
 *     div（每条消息一个，absolute）   ← 与原来的内层列同宽同边距
 *       [data-part=message]          ← 雨夜的 `message-list > div > message` 仍然命中
 *       div.flex-col                 ← 与下一条之间的留白（--gap-message）+ MessageDivider
 *     div                            ← 尾部：「生成中」、错误卡、底部留白
 * ```
 *
 * 分隔物挂在**上一条**的末尾而不是下一条的开头：这样只有路径最后一条消息是
 * 它所在容器的 `:last-child`，与虚拟化之前的语义一致（暖房的出现动画依赖它）。
 */
function VirtualMessageList({
  chat,
  path,
  generation,
  onSwitchSibling,
  onRegenerate,
}: MessageListProps) {
  const { t } = useTranslation();
  const { MessageDivider } = useSignature();
  const personas = usePersonas();
  const streaming = useChatStore((state) => state.streaming);
  const scrollRef = useRef<HTMLDivElement>(null);

  /** 是否贴底跟随；ref 给副作用读（不等重渲染），state 给「回到底部」按钮 */
  const followingRef = useRef(true);
  const [following, setFollowingState] = useState(true);
  const setFollowing = useCallback((value: boolean) => {
    followingRef.current = value;
    setFollowingState(value);
  }, []);
  /** 「回到底部」的平滑滚动进行中：这段时间不强行贴底，否则会打断动画 */
  const smoothRef = useRef(false);
  const lastScrollTopRef = useRef(0);

  const persona = personas.data?.find((item) => item.id === chat.personaId) ?? null;
  // 显示侧正则：宏里的 {{char}} / {{user}} 与消息头显示的名字保持一致
  const applyDisplayRegex = useDisplayRegex({
    characterId: chat.character?.id ?? null,
    presetId: chat.presetId,
    charName: chat.character?.name ?? t('chat.assistant'),
    userName: persona?.name ?? t('chat.you'),
  });

  const count = path.length;
  const getItemKey = useCallback((index: number) => path[index]?.id ?? index, [path]);

  /**
   * 焦点在里面的消息（就地编辑框、操作条按钮）滚出视口也不卸载，
   * 否则编辑到一半滚去看上文，草稿就没了。
   */
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = defaultRangeExtractor(range);
      if (focusedKey === null) return indexes;
      const focused = path.findIndex((node) => node.id === focusedKey);
      if (focused === -1 || indexes.includes(focused)) return indexes;
      return [...indexes, focused].sort((a, b) => a - b);
    },
    [focusedKey, path],
  );
  const estimateSize = useCallback(
    (index: number) =>
      estimateMessageHeight(path[index], index < path.length - 1, scrollRef.current?.clientWidth),
    [path],
  );

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize,
    getItemKey,
    rangeExtractor,
    overscan: OVERSCAN,
    paddingStart: LIST_PADDING_Y,
    // 虚拟项自己的下标属性；`data-index` 留给 [data-part=message]（主题挂点，语义是路径下标）
    indexAttribute: 'data-item-index',
    // 首次渲染还量不到容器：先按窗口估一个视口，直接从底部那一屏开始渲染
    initialRect: { width: 0, height: typeof window === 'undefined' ? 0 : window.innerHeight },
    initialOffset: () => {
      let total = LIST_PADDING_Y;
      for (let index = 0; index < path.length; index++) total += estimateSize(index);
      return Math.max(0, total - (typeof window === 'undefined' ? 0 : window.innerHeight));
    },
  });

  /**
   * 视口上方的消息改变高度时，把滚动位置补回去，眼前的内容不动。
   * 库的默认策略在「往上滚」时不补已测量过消息的变化；但主题字体是按 unicode-range 分片懒加载的，
   * 上滑时新出现的字会晚一拍换字形、改变折行，不补就会跳一下。
   * - 首次测量：顶边在视口上方就补（整块估算高度都在上面）；
   * - 再次测量：整条都在视口上方才补（跨过视口顶边的那条在自己下半截长高，比如流式输出，不能补）。
   */
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    const top = (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
    return instance.itemSizeCache.has(item.key) ? item.end <= top : item.start < top;
  };

  const items = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  const stickToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const max = element.scrollHeight - element.clientHeight;
    if (element.scrollTop < max) element.scrollTop = max;
  }, []);

  // 每次提交后（新消息、流式增量、测量修正、切换兄弟……）：贴底时留在底部。
  // 布局副作用在绘制前执行，内容长高与滚动在同一帧，不会先露出一截再跳。
  useLayoutEffect(() => {
    if (followingRef.current && !smoothRef.current) stickToBottom();
  });

  // 容器自身尺寸变化（输入框长高、窗口缩放）不会触发滚动事件，也要跟着贴底
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (followingRef.current && !smoothRef.current) stickToBottom();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [stickToBottom]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const top = element.scrollTop;
    const distance = element.scrollHeight - top - element.clientHeight;
    const movedUp = top < lastScrollTopRef.current - 1;
    lastScrollTopRef.current = top;
    if (distance <= FOLLOW_THRESHOLD_PX) {
      smoothRef.current = false;
      if (!followingRef.current) setFollowing(true);
    } else if (movedUp && followingRef.current) {
      // 只有「往上走」才解除跟随：内容在下方长高、上方消息首次测量修正位置都不算用户离开
      smoothRef.current = false;
      setFollowing(false);
    }
  };

  const scrollToBottom = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollowing(true);
    if (distance > element.clientHeight * SMOOTH_MAX_SCREENS) {
      smoothRef.current = false;
      element.scrollTop = element.scrollHeight;
      return;
    }
    smoothRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  };

  const streamingNodeId = generation.streamingNodeId;
  const showPending = generation.isGenerating && streamingNodeId === null;
  const tail =
    showPending || generation.error ? (
      <>
        {showPending && (
          <p className="pulse-live text-sm text-ink-2" role="status">
            {t('chat.generating')}
          </p>
        )}
        {generation.error && (
          <GenerationErrorCard
            kind={generation.error.kind}
            message={generation.error.message}
            retryable={generation.error.retryable}
            onRetry={generation.retry}
            onDismiss={generation.dismissError}
          />
        )}
      </>
    ) : null;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        data-part="message-list"
        // overflow-anchor: none —— 位置修正由虚拟列表自己做，浏览器的滚动锚定会重复修正
        className="surface-reading relative h-full overflow-x-hidden overflow-y-auto overscroll-contain [overflow-anchor:none]"
      >
        {count === 0 ? (
          <div className={cn(COLUMN, 'gap-message flex flex-col py-8')}>
            <EmptyChatGuide hasCharacter={Boolean(chat.character)} />
            {tail}
          </div>
        ) : (
          <>
            <div aria-hidden style={{ height: totalSize }} />
            {items.map((item) => {
              const node = path[item.index];
              if (!node) return null;
              const next = path[item.index + 1];
              const isUser = node.role === 'user';
              const displayName = isUser
                ? (node.name ?? persona?.name ?? t('chat.you'))
                : node.role === 'system'
                  ? (node.name ?? t('chat.system'))
                  : (node.name ?? chat.character?.name ?? t('chat.assistant'));
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-item-index={item.index}
                  className={cn(COLUMN, 'absolute inset-x-0 flex flex-col')}
                  style={{ top: item.start }}
                  onFocus={() => setFocusedKey(node.id)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setFocusedKey((current) => (current === node.id ? null : current));
                    }
                  }}
                >
                  <MessageItem
                    chatId={chat.id}
                    node={node}
                    index={item.index}
                    nodes={chat.nodes}
                    displayName={displayName}
                    avatarAssetId={
                      isUser
                        ? (persona?.avatarAssetId ?? null)
                        : (chat.character?.avatarAssetId ?? null)
                    }
                    busy={generation.isGenerating}
                    stream={streaming[node.id]}
                    // 0 = head，向上递增
                    depth={count - 1 - item.index}
                    applyDisplayRegex={applyDisplayRegex}
                    onSwitchSibling={onSwitchSibling}
                    onRegenerate={onRegenerate}
                  />
                  {next && (
                    // 与下一条之间：留白 + 记忆物件的分隔（素 = 没有分隔物，只有留白）。
                    // 末尾的空 span 让「有分隔物」时分隔物下方同样隔一个 --gap-message。
                    <div className="gap-message pt-message flex flex-col">
                      <MessageDivider role={next.role} index={item.index + 1} />
                      <span aria-hidden />
                    </div>
                  )}
                </div>
              );
            })}
            <div className={cn(COLUMN, 'gap-message flex flex-col pb-8', tail && 'pt-message')}>
              {tail}
            </div>
          </>
        )}
      </div>

      <AnimatePresence>
        {!following && count > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: slotSeconds('--dur-panel') }}
            className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center"
          >
            <IconButton
              label={t('chat.scrollToBottom')}
              size="md"
              variant="outline"
              className="surface-raised pointer-events-auto rounded-pill"
              onClick={scrollToBottom}
            >
              <ArrowDown aria-hidden />
            </IconButton>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 高度估算                                                             */
/* ------------------------------------------------------------------ */

/** 同一个节点对象只估一次（查询缓存里节点更新时是新对象，自然失效） */
const bodyEstimateCache = new WeakMap<MessageNode, number>();

/**
 * 未测量消息的高度估算（按「素」的尺度：名字行 + 正文行数 × 行高 + 操作条 + 留白）。
 * 只影响滚动条比例与首次测量前的位置；越接近真实值，上滑时的位置修正越小。
 */
function estimateMessageHeight(
  node: MessageNode | undefined,
  hasGapBelow: boolean,
  containerWidth: number | undefined,
): number {
  const gap = hasGapBelow ? 32 : 0;
  if (!node) return 120 + gap;
  let body = bodyEstimateCache.get(node);
  if (body === undefined) {
    // 正文列宽：容器减去两侧内边距与头像列，且不超过 36em
    const width = Math.max(160, Math.min((containerWidth ?? 768) - 48 - 48, 576));
    // 前端卡是个 iframe：不能把它那一大段 HTML 当文字算行数，按一张 280px 估
    // （真实高度由 guest 报上来，measureElement 随后会修正）
    const parts = splitCardSegments(nodeText(node));
    const cards = parts.filter((part) => part.kind === 'card').length;
    const text = parts.map((part) => (part.kind === 'card' ? '' : part.text)).join('\n');
    let lines = 0;
    let paragraphs = 0;
    for (const paragraph of text.split(/\n+/)) {
      if (paragraph.trim() === '') continue;
      paragraphs++;
      let units = 0;
      for (const char of paragraph) units += char.charCodeAt(0) > 0x2e80 ? 1 : 0.55;
      lines += Math.max(1, Math.ceil((units * 16) / width));
    }
    body = Math.max(1, lines) * 29 + Math.max(0, paragraphs - 1) * 12 + cards * 280;
    if (node.reasoning?.text) body += 40;
    bodyEstimateCache.set(node, body);
  }
  // 名字行 20 + 间距 6 + 正文 + 操作条 30
  return 56 + body + gap;
}

/* ------------------------------------------------------------------ */

/** 空对话引导语：插画由主题决定（素没有插画，只有一行大字） */
function EmptyChatGuide({ hasCharacter }: { hasCharacter: boolean }) {
  const { t } = useTranslation();
  const { EmptyIllustration } = useSignature();
  return (
    <div
      data-part="empty-state"
      className="flex flex-col items-center gap-4 px-6 py-24 text-center"
    >
      <EmptyIllustration kind="chat" />
      <p className="font-display text-[28px] leading-snug font-light tracking-tight">
        {t('chat.emptyTitle')}
      </p>
      <p className="max-w-sm text-sm leading-relaxed text-ink-2">
        {hasCharacter ? t('chat.emptyWithCharacterHint') : t('chat.emptyBlankHint')}
      </p>
    </div>
  );
}

/** 生成失败：显示在消息流末尾，可原地重试 */
function GenerationErrorCard({
  kind,
  message,
  retryable,
  onRetry,
  onDismiss,
}: {
  kind: string;
  message: string;
  retryable: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const label = t([`errors.${kind}`, 'errors.unknown']);
  return (
    <div
      role="alert"
      data-part="generation-error"
      className="rounded-card border-danger bg-danger-soft border px-4 py-3 text-sm text-danger"
    >
      <div className="font-medium">{label}</div>
      {message && <p className="mt-1 break-words">{message}</p>}
      <div className="mt-2 flex gap-2">
        {retryable && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          {t('common.dismiss')}
        </Button>
      </div>
    </div>
  );
}
