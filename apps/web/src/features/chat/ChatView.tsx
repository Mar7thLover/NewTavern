import { AnimatePresence, motion } from 'framer-motion';
import { Menu, PanelRightClose, PanelRightOpen, SearchCode } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { ModelBadge } from './SessionPanel';
import { deepestLeaf } from './shared';
import { useAttachmentTray } from './useAttachmentTray';
import { useGeneration } from './useGeneration';
import { LightboxHost } from '../../components/Lightbox';
import { ScriptRunner } from '../cards/ScriptRunner';
import { IconButton } from '../../components/ui/icon-button';
import {
  useGenerationDefault,
  useModelCapabilities,
  usePatchChat,
  type ChatDetail,
  type MessageNode,
} from '../../lib/api';
import { slotSeconds } from '../../themes/apply';

export interface ChatViewProps {
  chat: ChatDetail;
  /** root→head 路径 */
  path: MessageNode[];
  /** 窄屏：打开会话列表抽屉 */
  onOpenList: () => void;
  /** 会话面板开关（窄屏开抽屉，宽屏折叠右栏） */
  onTogglePanel: () => void;
  /** 打开右栏的检查器页签 */
  onOpenInspector: () => void;
  panelOpen: boolean;
}

/** 拖进来的是不是文件（拖一段文字、一张网页里的图片链接都不算） */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

export function ChatView({
  chat,
  path,
  onOpenList,
  onTogglePanel,
  onOpenInspector,
  panelOpen,
}: ChatViewProps) {
  const { t } = useTranslation();
  const patchChat = usePatchChat();
  const generation = useGeneration(chat.id);
  const tray = useAttachmentTray(chat.id);

  // 模型能力：与会话面板同一个来源（会话覆盖 → 全局默认）
  const generationDefault = useGenerationDefault();
  const connectionId = chat.overrides?.connectionId ?? generationDefault.data?.connectionId ?? null;
  const model = chat.overrides?.model ?? generationDefault.data?.model ?? null;
  const capabilities = useModelCapabilities(connectionId, model);

  /* ---------------- 拖放：拖入时整块出现一层提示 ---------------- */
  const [dragging, setDragging] = useState(false);
  // 子元素之间移动会成对触发 enter / leave，用计数判断是否真的离开
  const dragDepth = useRef(0);

  const onDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) tray.add(files);
  };

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
    <div
      data-part="chat-view"
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-x-hidden"
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header
        data-part="chat-header"
        className="flex shrink-0 items-center gap-2 border-b edge-rule px-3 py-2"
      >
        <IconButton label={t('chat.list.title')} onClick={onOpenList}>
          <Menu aria-hidden />
        </IconButton>
        <div className="min-w-0 flex-1">
          <div data-part="chat-title" className="truncate text-sm font-semibold">
            {title}
          </div>
        </div>
        <ModelBadge chat={chat} />
        <IconButton label={t('inspector.title')} onClick={onOpenInspector}>
          <SearchCode aria-hidden />
        </IconButton>
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

      {/* 脚本库：隐藏的脚本帧 + 脚本按钮条（M5 §4.7），紧贴输入框上方 */}
      <ScriptRunner chatId={chat.id} />

      <Composer
        resetKey={chat.id}
        isGenerating={generation.isGenerating}
        onStop={generation.stop}
        tray={tray}
        capabilities={capabilities.data}
        onSend={(text, attachments) =>
          generation.generate({
            userMessage: attachments.length > 0 ? { text, attachments } : { text },
          })
        }
      />

      <AnimatePresence>
        {dragging && (
          <motion.div
            key="drop"
            data-part="attachment-drop"
            aria-hidden
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: slotSeconds('--dur-hover') }}
            className="pointer-events-none absolute inset-0 z-30 flex p-3 sm:p-5"
          >
            <div className="surface-overlay absolute inset-0" />
            <div
              data-part="attachment-drop-frame"
              className="edge-rule-strong rounded-panel relative flex flex-1 items-center justify-center border-2 border-dashed p-4"
            >
              <div className="surface-raised edge-rule rounded-card flex max-w-sm flex-col items-center gap-1.5 border px-6 py-5 text-center">
                <p className="font-display text-xl">{t('chat.attach.dropTitle')}</p>
                <p className="text-sm text-ink-2">{t('chat.attach.dropHint')}</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <LightboxHost />
    </div>
  );
}
