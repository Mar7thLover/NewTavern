import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { ChatListPane } from './ChatListPane';
import { ChatView } from './ChatView';
import { SessionPanel } from './SessionPanel';
import { StartScreen } from './StartScreen';
import { pathToHead } from './shared';
import { Button } from '../../components/ui/button';
import { Drawer } from '../../components/ui/drawer';
import { useChat } from '../../lib/api';
import { useMediaQuery } from '../../lib/hooks';
import { QueryStatus } from '../library/shared';

/** 三栏同时显示的断点：会话列表 ≥lg，会话面板 ≥xl */
const LIST_QUERY = '(min-width: 1024px)';
const PANEL_QUERY = '(min-width: 1280px)';

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

  const chat = useChat(chatId);
  const detail = chat.data ?? null;
  const path = useMemo(() => (detail ? pathToHead(detail.nodes, detail.headNodeId) : []), [detail]);

  const selectChat = (id: string) => {
    setSearchParams({ c: id });
    setListDrawer(false);
  };

  const startNew = () => {
    setSearchParams({});
    setListDrawer(false);
  };

  const listPane = (onClose?: () => void) => (
    <ChatListPane
      activeChatId={chatId}
      onSelect={selectChat}
      onNew={startNew}
      {...(onClose ? { onClose } : {})}
    />
  );
  const sessionPanel = detail ? (
    <div className="h-full overflow-y-auto">
      <SessionPanel chat={detail} path={path} />
    </div>
  ) : null;

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {showList && !listCollapsed && (
        <aside className="w-72 shrink-0 border-e border-border bg-card/30">{listPane()}</aside>
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
              onTogglePanel={() =>
                showPanel ? setPanelCollapsed((value) => !value) : setPanelDrawer(true)
              }
              panelOpen={showPanel ? !panelCollapsed : panelDrawer}
            />
          )
        )}
      </div>

      {showPanel && !panelCollapsed && sessionPanel !== null && (
        <aside className="w-80 shrink-0 border-s border-border bg-card/30">{sessionPanel}</aside>
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
          title={t('chat.panel.title')}
          onClose={() => setPanelDrawer(false)}
        >
          {sessionPanel}
        </Drawer>
      )}
    </div>
  );
}
