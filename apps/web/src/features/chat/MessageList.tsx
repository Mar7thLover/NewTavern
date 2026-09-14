import { AnimatePresence, motion } from 'framer-motion';
import { ArrowDown, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { MessageItem } from './MessageItem';
import { useDisplayRegex } from './useDisplayRegex';
import type { GenerationController } from './useGeneration';
import { useChatStore } from '../../app/store/chat';
import { Button } from '../../components/ui/button';
import { IconButton } from '../../components/ui/icon-button';
import { usePersonas, type ChatDetail, type MessageNode } from '../../lib/api';
import { cn } from '../../lib/utils';

/** 用户上滑超过这个距离就停止自动跟随 */
const FOLLOW_THRESHOLD_PX = 96;

export interface MessageListProps {
  chat: ChatDetail;
  /** root→head 的线性路径 */
  path: MessageNode[];
  generation: GenerationController;
  onSwitchSibling: (siblingId: string) => void;
  onRegenerate: (node: MessageNode) => void;
}

export function MessageList({
  chat,
  path,
  generation,
  onSwitchSibling,
  onRegenerate,
}: MessageListProps) {
  const { t } = useTranslation();
  const personas = usePersonas();
  const streaming = useChatStore((state) => state.streaming);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);

  const persona = personas.data?.find((item) => item.id === chat.personaId) ?? null;
  // 显示侧正则：宏里的 {{char}} / {{user}} 与消息头显示的名字保持一致
  const applyDisplayRegex = useDisplayRegex({
    characterId: chat.character?.id ?? null,
    charName: chat.character?.name ?? t('chat.assistant'),
    userName: persona?.name ?? t('chat.you'),
  });
  const streamingNodeId = generation.streamingNodeId;
  const buffer = streamingNodeId ? streaming[streamingNodeId] : undefined;
  const streamLength = buffer ? buffer.text.length + buffer.reasoning.length : 0;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
    setFollowing(true);
  }, []);

  // 切换聊天时直接跳到底部（不要动画）
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setFollowing(true);
  }, [chat.id]);

  // 新消息 / 流式增量时跟随
  useEffect(() => {
    if (!following) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [following, path.length, streamLength, chat.headNodeId]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setFollowing(distance <= FOLLOW_THRESHOLD_PX);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 px-4 py-6 sm:px-6">
          {path.length === 0 ? (
            <EmptyChatGuide hasCharacter={Boolean(chat.character)} />
          ) : (
            path.map((node, index) => {
              const isUser = node.role === 'user';
              const displayName = isUser
                ? (node.name ?? persona?.name ?? t('chat.you'))
                : node.role === 'system'
                  ? (node.name ?? t('chat.system'))
                  : (node.name ?? chat.character?.name ?? t('chat.assistant'));
              return (
                <MessageItem
                  key={node.id}
                  chatId={chat.id}
                  node={node}
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
                  depth={path.length - 1 - index}
                  applyDisplayRegex={applyDisplayRegex}
                  onSwitchSibling={onSwitchSibling}
                  onRegenerate={onRegenerate}
                />
              );
            })
          )}

          {generation.isGenerating && generation.streamingNodeId === null && (
            <p className="text-sm text-muted-foreground" role="status">
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
        </div>
      </div>

      <AnimatePresence>
        {!following && path.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center"
          >
            <IconButton
              label={t('chat.scrollToBottom')}
              size="md"
              variant="outline"
              className="pointer-events-auto rounded-full bg-card shadow-md"
              onClick={() => scrollToBottom()}
            >
              <ArrowDown aria-hidden />
            </IconButton>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** 空对话引导语：没有角色 / 没有开场白时给一句提示 */
function EmptyChatGuide({ hasCharacter }: { hasCharacter: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-20 text-center">
      <Sparkles aria-hidden className="size-7 text-primary/70" />
      <p className="text-base font-medium">{t('chat.emptyTitle')}</p>
      <p className="max-w-sm text-sm text-muted-foreground">
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
      className={cn(
        'rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive',
      )}
    >
      <div className="font-medium">{label}</div>
      {message && <p className="mt-1 break-words text-destructive/90">{message}</p>}
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
