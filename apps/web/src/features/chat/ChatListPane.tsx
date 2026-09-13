import { Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { formatRelativeTime, renderMacros } from './shared';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { IconButton } from '../../components/ui/icon-button';
import { useChats, useDeleteChat, usePersonas, type ChatSummary } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Avatar, QueryStatus, errorMessage } from '../library/shared';

export interface ChatListPaneProps {
  activeChatId: string | null;
  onSelect: (chatId: string) => void;
  /** 新建对话 —— 回到 StartScreen */
  onNew: () => void;
  /** 抽屉模式下的关闭入口 */
  onClose?: () => void;
}

export function ChatListPane({ activeChatId, onSelect, onNew, onClose }: ChatListPaneProps) {
  const { t, i18n } = useTranslation();
  const chats = useChats();
  const personas = usePersonas();
  const deleteChat = useDeleteChat();
  const [pendingDelete, setPendingDelete] = useState<ChatSummary | null>(null);

  const list = [...(chats.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="text-sm font-semibold">{t('chat.list.title')}</span>
        <div className="flex items-center gap-1">
          <IconButton label={t('chat.list.new')} variant="outline" onClick={onNew}>
            <Plus aria-hidden />
          </IconButton>
          {onClose && (
            <IconButton label={t('common.close')} onClick={onClose}>
              <X aria-hidden />
            </IconButton>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <QueryStatus
          isPending={chats.isPending}
          error={chats.error}
          onRetry={() => void chats.refetch()}
        />
        {chats.data && list.length === 0 && (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            {t('chat.list.empty')}
          </p>
        )}
        <ul className="space-y-0.5">
          {list.map((chat) => {
            const title = chat.title?.trim() || chat.character?.name || t('chat.list.untitled');
            // 开场白常含 {{char}} / {{user}}，预览里不该原样露出
            const preview = renderMacros(
              chat.preview?.trim() ?? '',
              chat.character?.name,
              personas.data?.find((item) => item.id === chat.personaId)?.name ??
                t('chat.defaultUserName'),
            );
            const active = chat.id === activeChatId;
            return (
              <li key={chat.id} className="group/item relative">
                <button
                  type="button"
                  onClick={() => onSelect(chat.id)}
                  aria-current={active ? 'true' : undefined}
                  className={cn(
                    'flex w-full cursor-pointer items-start gap-2.5 rounded-lg p-2 pe-8 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                  )}
                >
                  <Avatar
                    name={title}
                    assetId={chat.character?.avatarAssetId ?? null}
                    className="size-9 rounded-lg"
                    textClassName="text-sm"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {formatRelativeTime(chat.updatedAt, i18n.language)}
                      </span>
                    </span>
                    {/* line-clamp 自带 display:-webkit-box，不能再叠 block，否则不生效 */}
                    <span className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
                      {preview || t('chat.list.noMessages')}
                    </span>
                  </span>
                </button>
                <IconButton
                  label={t('common.delete')}
                  size="xs"
                  variant="destructive"
                  className="absolute end-1.5 top-2 opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100"
                  onClick={() => {
                    deleteChat.reset();
                    setPendingDelete(chat);
                  }}
                >
                  <Trash2 aria-hidden />
                </IconButton>
              </li>
            );
          })}
        </ul>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title={t('chat.list.deleteTitle')}
        description={t('chat.list.deleteMessage', {
          name:
            pendingDelete?.title?.trim() ||
            pendingDelete?.character?.name ||
            t('chat.list.untitled'),
        })}
        confirmLabel={t('common.delete')}
        pending={deleteChat.isPending}
        error={errorMessage(deleteChat.error)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          deleteChat.mutate(pendingDelete.id, {
            onSuccess: () => {
              if (pendingDelete.id === activeChatId) onNew();
              setPendingDelete(null);
            },
          });
        }}
      />
    </div>
  );
}
