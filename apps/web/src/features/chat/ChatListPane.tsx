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
    <div data-part="chat-list" className="flex h-full min-h-0 flex-col">
      <div
        data-part="chat-list-header"
        className="flex items-center justify-between gap-2 border-b edge-rule px-3 py-2"
      >
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 只在加载/失败时占位：空的内边距会在列表顶上留出一条白 */}
        {(chats.isPending || chats.error) && (
          <div className="p-2">
            <QueryStatus
              isPending={chats.isPending}
              error={chats.error}
              onRetry={() => void chats.refetch()}
            />
          </div>
        )}
        {chats.data && list.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-ink-2">{t('chat.list.empty')}</p>
        )}
        {/* 项之间只有一根发丝线，不填底；当前项靠左侧 2px 橙线标记 */}
        <ul className="divide-y divide-edge">
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
              <li
                key={chat.id}
                data-part="chat-list-item"
                data-active={active}
                className="group/item relative"
              >
                {active && (
                  <span
                    aria-hidden
                    data-part="chat-list-marker"
                    className="absolute start-0 top-1/2 h-9 w-0.5 -translate-y-1/2 bg-accent"
                  />
                )}
                <button
                  type="button"
                  onClick={() => onSelect(chat.id)}
                  aria-current={active ? 'true' : undefined}
                  className="focus-ring-inset flex w-full cursor-pointer items-start gap-3 px-3 py-3 pe-9 text-left"
                >
                  <Avatar
                    name={title}
                    assetId={chat.character?.avatarAssetId ?? null}
                    className="size-9"
                    textClassName="text-sm"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-[13px]',
                          active
                            ? 'font-medium text-ink'
                            : 'text-ink-story group-hover/item:text-ink',
                        )}
                      >
                        {title}
                      </span>
                      <span className="shrink-0 text-end text-[11px] text-ink-3 tabular-nums">
                        {formatRelativeTime(chat.updatedAt, i18n.language)}
                      </span>
                    </span>
                    {/* line-clamp 自带 display:-webkit-box，不能再叠 block，否则不生效 */}
                    <span className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-ink-3">
                      {preview || t('chat.list.noMessages')}
                    </span>
                  </span>
                </button>
                <IconButton
                  label={t('common.delete')}
                  size="xs"
                  variant="destructive"
                  className="absolute end-2 top-3 opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100"
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
