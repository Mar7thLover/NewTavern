import { PanelRightClose, PanelRightOpen, Menu } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { ModelBadge } from './SessionPanel';
import { deepestLeaf } from './shared';
import { useGeneration } from './useGeneration';
import { IconButton } from '../../components/ui/icon-button';
import { usePatchChat, type ChatDetail, type MessageNode } from '../../lib/api';

export interface ChatViewProps {
  chat: ChatDetail;
  /** root→head 路径 */
  path: MessageNode[];
  /** 窄屏：打开会话列表抽屉 */
  onOpenList: () => void;
  /** 会话面板开关（窄屏开抽屉，宽屏折叠右栏） */
  onTogglePanel: () => void;
  panelOpen: boolean;
}

export function ChatView({ chat, path, onOpenList, onTogglePanel, panelOpen }: ChatViewProps) {
  const { t } = useTranslation();
  const patchChat = usePatchChat();
  const generation = useGeneration(chat.id);

  /** 切换兄弟：沿 siblingSeq 最大的子节点下钻到叶子后移动 head */
  const switchSibling = (siblingId: string) => {
    patchChat.mutate({ id: chat.id, headNodeId: deepestLeaf(chat.nodes, siblingId) });
  };

  /** 重生成 / 新 swipe：在目标助手节点的父节点下再生成一条 */
  const regenerate = (node: MessageNode) => {
    generation.generate({ parentId: node.parentId });
  };

  const title = chat.title?.trim() || chat.character?.name || t('chat.list.untitled');

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <IconButton label={t('chat.list.title')} onClick={onOpenList}>
          <Menu aria-hidden />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{title}</div>
        </div>
        <ModelBadge chat={chat} />
        <IconButton label={t('chat.panel.title')} onClick={onTogglePanel}>
          {panelOpen ? <PanelRightClose aria-hidden /> : <PanelRightOpen aria-hidden />}
        </IconButton>
      </header>

      <MessageList
        chat={chat}
        path={path}
        generation={generation}
        onSwitchSibling={switchSibling}
        onRegenerate={regenerate}
      />

      <Composer
        resetKey={chat.id}
        isGenerating={generation.isGenerating}
        onStop={generation.stop}
        onSend={(text) => generation.generate({ userMessage: { text } })}
      />
    </div>
  );
}
