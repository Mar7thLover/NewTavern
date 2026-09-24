import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useIsGenerating } from '../../../app/store/chat';
import { Badge } from '../../../components/ui/badge';
import { Drawer } from '../../../components/ui/drawer';
import { IconButton } from '../../../components/ui/icon-button';
import { mutate, queryKeys, useChat, type ChatDetail } from '../../../lib/api';
import {
  fetchTestChat,
  registerChatDraft,
  studioKeys,
  type StudioDraftBody,
  type StudioKind,
} from '../../../lib/api-studio';
import { ChatView } from '../../chat/ChatView';
import { SessionPanel } from '../../chat/SessionPanel';
import { pathToHead } from '../../chat/shared';
import { QueryStatus } from '../../library/shared';

/**
 * 该实体的测试会话（§2.4：最近一条，没有就新建）。会话详情仍走 `useChat` 的缓存，
 * 生成流式写入与普通对话页一致。`reset` 删掉这条再建一条（开场白等随最新保存的卡）。
 */
export function useTestChat(kind: StudioKind, id: string) {
  const queryClient = useQueryClient();
  const entry = useQuery({
    queryKey: studioKeys.testChat(kind, id),
    queryFn: async () => {
      const chat = await fetchTestChat(kind, id);
      queryClient.setQueryData(queryKeys.chat(chat.id), chat);
      return chat.id;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const chatId = entry.data ?? null;
  const chat = useChat(chatId);
  const [resetting, setResetting] = useState(false);

  const reset = useCallback(async () => {
    if (!chatId) return;
    setResetting(true);
    try {
      await mutate(`/api/chats/${encodeURIComponent(chatId)}`, 'DELETE');
      queryClient.removeQueries({ queryKey: queryKeys.chat(chatId) });
      await queryClient.refetchQueries({ queryKey: studioKeys.testChat(kind, id), exact: true });
    } finally {
      setResetting(false);
    }
  }, [chatId, queryClient, kind, id]);

  return {
    chatId,
    chat: chat.data ?? null,
    isPending: entry.isPending || (chatId !== null && chat.isPending),
    error: entry.error ?? chat.error,
    refetch: () => void entry.refetch(),
    reset,
    resetting,
  };
}

export type TestChatState = ReturnType<typeof useTestChat>;

/**
 * 测试对话栏：嵌入对话页的 `ChatView`；生成请求自动带上当前草稿（登记到 `registerChatDraft`）。
 */
export function TestChatPane({
  testChat,
  dirty,
  getDraft,
  onOpenInspector,
}: {
  testChat: TestChatState;
  dirty: boolean;
  getDraft: () => StudioDraftBody | undefined;
  onOpenInspector: () => void;
}) {
  const { t } = useTranslation();
  const { chat, chatId } = testChat;
  const [sessionOpen, setSessionOpen] = useState(false);
  const isGenerating = useIsGenerating(chatId);

  useEffect(() => {
    if (!chatId) return;
    return registerChatDraft(chatId, getDraft);
  }, [chatId, getDraft]);

  const path = useMemo(() => (chat ? pathToHead(chat.nodes, chat.headNodeId) : []), [chat]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="edge-rule flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <span className="text-xs font-medium">{t('studio.test.title')}</span>
        {dirty && <Badge variant="default">{t('studio.test.draftActive')}</Badge>}
        <span className="ms-auto" />
        <IconButton
          label={t('studio.test.reset')}
          disabled={!chatId || testChat.resetting || isGenerating}
          onClick={() => void testChat.reset()}
        >
          <RotateCcw aria-hidden />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">
        {chat ? (
          <TestChatView
            chat={chat}
            path={path}
            sessionOpen={sessionOpen}
            onToggleSession={() => setSessionOpen((value) => !value)}
            onOpenInspector={onOpenInspector}
          />
        ) : (
          <div className="p-4">
            <QueryStatus
              isPending={testChat.isPending}
              error={testChat.error}
              onRetry={testChat.refetch}
            />
          </div>
        )}
      </div>
      {chat && (
        <Drawer
          open={sessionOpen}
          side="right"
          title={t('chat.panel.title')}
          onClose={() => setSessionOpen(false)}
        >
          <SessionPanel chat={chat} path={path} />
        </Drawer>
      )}
    </div>
  );
}

function TestChatView({
  chat,
  path,
  sessionOpen,
  onToggleSession,
  onOpenInspector,
}: {
  chat: ChatDetail;
  path: ReturnType<typeof pathToHead>;
  sessionOpen: boolean;
  onToggleSession: () => void;
  onOpenInspector: () => void;
}) {
  return (
    <ChatView
      chat={chat}
      path={path}
      onTogglePanel={onToggleSession}
      onOpenInspector={onOpenInspector}
      panelOpen={sessionOpen}
    />
  );
}
