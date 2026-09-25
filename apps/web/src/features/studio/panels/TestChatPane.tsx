import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useIsGenerating } from '../../../app/store/chat';
import { Badge } from '../../../components/ui/badge';
import { FieldLabel, Select } from '../../../components/ui/field';
import { IconButton } from '../../../components/ui/icon-button';
import { queryKeys, useChat, useCharacters, type ChatDetail } from '../../../lib/api';
import {
  fetchTestChat,
  recreateTestChat,
  registerChatDraft,
  studioKeys,
  type StudioDraftBody,
  type StudioKind,
} from '../../../lib/api-studio';
import { ChatView } from '../../chat/ChatView';
import { SessionPanel } from '../../chat/SessionPanel';
import { pathToHead } from '../../chat/shared';
import { QueryStatus, errorMessage } from '../../library/shared';

/**
 * 该实体的测试会话（§2.4：最近一条，没有就新建）。会话详情仍走 `useChat` 的缓存，
 * 生成流式写入与普通对话页一致。
 * `reset` / `setCharacter` 走 `POST /api/studio/test-chat/:kind/:id`：新建一条替换当前那条
 * （开场白随最新保存的卡；档案、预设、连接等覆盖、聊天书沿用旧会话）。
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
  const [recreateError, setRecreateError] = useState<unknown>(null);

  const recreate = useCallback(
    async (body: { characterId?: string | null }) => {
      setResetting(true);
      setRecreateError(null);
      try {
        const next = await recreateTestChat(kind, id, body);
        // 先写新会话，再把实体指向它，最后移除旧会话的缓存（含它的 inspect 子键）
        queryClient.setQueryData(queryKeys.chat(next.id), next);
        queryClient.setQueryData(studioKeys.testChat(kind, id), next.id);
        if (chatId && chatId !== next.id) {
          queryClient.removeQueries({ queryKey: queryKeys.chat(chatId) });
        }
      } catch (e) {
        setRecreateError(e);
      } finally {
        setResetting(false);
      }
    },
    [chatId, queryClient, kind, id],
  );

  /** 重开：沿用当前角色与各项设置 */
  const reset = useCallback(() => recreate({}), [recreate]);
  /** 换测试角色（null = 无角色），同样是重开一条 */
  const setCharacter = useCallback(
    (characterId: string | null) => recreate({ characterId }),
    [recreate],
  );

  return {
    kind,
    entityId: id,
    chatId,
    chat: chat.data ?? null,
    isPending: entry.isPending || (chatId !== null && chat.isPending),
    error: entry.error ?? chat.error,
    refetch: () => void entry.refetch(),
    reset,
    setCharacter,
    resetting,
    recreateError,
  };
}

export type TestChatState = ReturnType<typeof useTestChat>;

/**
 * 测试对话栏：嵌入对话页的 `ChatView`；生成请求自动带上当前草稿（登记到 `registerChatDraft`）。
 * 头部「会话面板」按钮不再开抽屉，而是切到工作台右栏的「会话」页签（`onToggleSession`）。
 */
export function TestChatPane({
  testChat,
  dirty,
  getDraft,
  onOpenInspector,
  sessionOpen,
  onToggleSession,
}: {
  testChat: TestChatState;
  dirty: boolean;
  getDraft: () => StudioDraftBody | undefined;
  onOpenInspector: () => void;
  /** 右栏「会话」页签是否正在显示 */
  sessionOpen: boolean;
  onToggleSession: () => void;
}) {
  const { t } = useTranslation();
  const { chat, chatId } = testChat;
  const isGenerating = useIsGenerating(chatId);
  const failed = errorMessage(testChat.recreateError);

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
        {failed && (
          <span role="alert" className="min-w-0 truncate text-[11px] text-danger" title={failed}>
            {t('studio.test.recreateFailed', { message: failed })}
          </span>
        )}
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
            onToggleSession={onToggleSession}
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

/**
 * 右栏「会话」页签：测试会话的会话面板（与对话页右栏一致）。
 * preset / lorebook 的测试会话在卡面下方多一个「测试角色」选择；lorebook 类型正在编辑的那本书
 * 在对话世界书里锁定（移除后草稿就不参与组装了）。
 */
export function TestSessionTab({ testChat }: { testChat: TestChatState }) {
  const { chat } = testChat;
  const path = useMemo(() => (chat ? pathToHead(chat.nodes, chat.headNodeId) : []), [chat]);
  const lockedLorebookIds = useMemo(
    () => (testChat.kind === 'lorebook' ? [testChat.entityId] : undefined),
    [testChat.kind, testChat.entityId],
  );

  if (!chat) {
    return (
      <div className="p-3">
        <QueryStatus
          isPending={testChat.isPending}
          error={testChat.error}
          onRetry={testChat.refetch}
        />
      </div>
    );
  }
  return (
    <div data-part="studio-session" className="h-full min-h-0 overflow-y-auto">
      <SessionPanel
        chat={chat}
        path={path}
        characterSlot={
          testChat.kind === 'character' ? undefined : (
            <TestCharacterSelect testChat={testChat} chat={chat} />
          )
        }
        lockedLorebookIds={lockedLorebookIds}
      />
    </div>
  );
}

/** 「测试角色」：无角色 + 全部角色卡；切换 = 重开测试会话。生成进行中禁用 */
function TestCharacterSelect({ testChat, chat }: { testChat: TestChatState; chat: ChatDetail }) {
  const { t } = useTranslation();
  const selectId = useId();
  const characters = useCharacters();
  const isGenerating = useIsGenerating(chat.id);
  const current = chat.character?.id ?? '';
  const list = characters.data ?? [];
  // 当前角色不在列表里（列表还没到 / 已删除）时也要能显示出来
  const missing = current !== '' && !list.some((item) => item.id === current);
  const failed = errorMessage(testChat.recreateError);

  return (
    <section data-part="studio-test-char">
      <FieldLabel htmlFor={selectId}>{t('studio.test.character')}</FieldLabel>
      <Select
        id={selectId}
        size="sm"
        value={current}
        disabled={testChat.resetting || isGenerating || characters.isPending}
        onChange={(event) => void testChat.setCharacter(event.target.value || null)}
      >
        <option value="">{t('studio.test.noCharacter')}</option>
        {missing && <option value={current}>{chat.character?.name ?? current}</option>}
        {list.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </Select>
      <p className="mt-1.5 text-[11px] leading-relaxed text-ink-2">
        {t(isGenerating ? 'studio.test.characterBusy' : 'studio.test.characterHint')}
      </p>
      {failed && (
        <p role="alert" className="mt-1 text-[11px] text-danger">
          {t('studio.test.recreateFailed', { message: failed })}
        </p>
      )}
    </section>
  );
}
