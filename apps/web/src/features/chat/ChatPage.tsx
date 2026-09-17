import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { ChatListPane } from './ChatListPane';
import { ChatView } from './ChatView';
import { SessionPanel } from './SessionPanel';
import { StartScreen } from './StartScreen';
import { pathToHead } from './shared';
import { useIsGenerating } from '../../app/store/chat';
import { useUiStore, type ChatPanelTab } from '../../app/store/ui';
import { Button } from '../../components/ui/button';
import { Drawer } from '../../components/ui/drawer';
import { Segmented } from '../../components/ui/segmented';
import { useChat } from '../../lib/api';
import { useMediaQuery } from '../../lib/hooks';
import { InspectorPanel } from '../inspector/InspectorPanel';
import { QueryStatus } from '../library/shared';

/** 三栏同时显示的断点：会话列表 ≥lg，会话面板 ≥xl */
const LIST_QUERY = '(min-width: 1024px)';
const PANEL_QUERY = '(min-width: 1280px)';

/** 右栏两个页签：会话设置 / 提示词检查器 */
type RightTab = ChatPanelTab;

export function ChatPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const chatId = searchParams.get('c');

  const showList = useMediaQuery(LIST_QUERY);
  const showPanel = useMediaQuery(PANEL_QUERY);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [listDrawer, setListDrawer] = useState(false);
  const [panelDrawer, setPanelDrawer] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>('session');

  const chat = useChat(chatId);
  const detail = chat.data ?? null;
  const isGenerating = useIsGenerating(chatId);
  const path = useMemo(() => (detail ? pathToHead(detail.nodes, detail.headNodeId) : []), [detail]);

  const selectChat = (id: string) => {
    setSearchParams({ c: id });
    setListDrawer(false);
  };

  const startNew = () => {
    setSearchParams({});
    setListDrawer(false);
  };

  const panelOpen = showPanel ? !panelCollapsed : panelDrawer;

  /** 顶栏按钮：宽屏折叠右栏，窄屏开抽屉；带页签时顺便切过去 */
  const openPanel = (tab: RightTab) => {
    const alreadyOpen = panelOpen && rightTab === tab;
    setRightTab(tab);
    if (showPanel) setPanelCollapsed(alreadyOpen);
    else setPanelDrawer(!alreadyOpen);
  };

  // 命令面板的「打开检查器 / 会话面板」：只打开、不切换（已经开着就停在那一页）
  const panelRequest = useUiStore((state) => state.chatPanelRequest);
  const hasDetail = detail !== null;
  useEffect(() => {
    if (!panelRequest) return;
    if (hasDetail) {
      setRightTab(panelRequest.tab);
      if (showPanel) setPanelCollapsed(false);
      else setPanelDrawer(true);
    }
    useUiStore.getState().clearChatPanelRequest(panelRequest.nonce);
  }, [panelRequest, hasDetail, showPanel]);

  const listPane = (onClose?: () => void) => (
    <ChatListPane
      activeChatId={chatId}
      onSelect={selectChat}
      onNew={startNew}
      {...(onClose ? { onClose } : {})}
    />
  );

  const rightPane = detail ? (
    <div data-part="chat-aside-body" className="flex h-full min-h-0 flex-col">
      <Segmented
        className="shrink-0 px-3 pt-2"
        stretch
        value={rightTab}
        onChange={setRightTab}
        items={[
          { value: 'session', label: t('inspector.sessionTab') },
          { value: 'inspector', label: t('inspector.tab') },
        ]}
      />
      {rightTab === 'session' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SessionPanel chat={detail} path={path} />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <InspectorPanel chat={detail} isGenerating={isGenerating} />
        </div>
      )}
    </div>
  ) : null;

  return (
    <div data-part="chat-page" className="flex h-full min-h-0 overflow-hidden">
      {showList && !listCollapsed && (
        <aside
          data-part="chat-aside"
          data-side="start"
          className="w-72 shrink-0 border-e edge-rule bg-panel"
        >
          {listPane()}
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {chatId === null ? (
          <StartScreen onCreated={selectChat} />
        ) : chat.isPending || chat.error ? (
          <div className="mx-auto w-full max-w-lg px-4 py-10">
            <QueryStatus
              isPending={chat.isPending}
              error={chat.error}
              onRetry={() => void chat.refetch()}
            />
            {chat.error && (
              <Button className="mt-4" variant="outline" onClick={startNew}>
                {t('chat.list.new')}
              </Button>
            )}
          </div>
        ) : (
          detail && (
            <ChatView
              chat={detail}
              path={path}
              onOpenList={() =>
                showList ? setListCollapsed((value) => !value) : setListDrawer(true)
              }
              onTogglePanel={() => openPanel('session')}
              onOpenInspector={() => openPanel('inspector')}
              panelOpen={panelOpen}
            />
          )
        )}
      </div>

      {showPanel && !panelCollapsed && rightPane !== null && (
        <aside
          data-part="chat-aside"
          data-side="end"
          className="w-80 shrink-0 border-s edge-rule bg-panel xl:w-96"
        >
          {rightPane}
        </aside>
      )}

      {!showList && (
        <Drawer open={listDrawer} side="left" onClose={() => setListDrawer(false)}>
          {listPane(() => setListDrawer(false))}
        </Drawer>
      )}

      {!showPanel && (
        <Drawer
          open={panelDrawer}
          side="right"
          title={t(rightTab === 'inspector' ? 'inspector.title' : 'chat.panel.title')}
          onClose={() => setPanelDrawer(false)}
          // 检查器信息密度高，窄屏用全屏抽屉
          className={rightTab === 'inspector' ? 'w-full max-w-none' : undefined}
        >
          {rightPane}
        </Drawer>
      )}
    </div>
  );
}
