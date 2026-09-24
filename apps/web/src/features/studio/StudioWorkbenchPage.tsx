import { ArrowLeft } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Link,
  useBeforeUnload,
  useBlocker,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router';

import { useIsGenerating } from '../../app/store/chat';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Segmented } from '../../components/ui/segmented';
import {
  isStudioKind,
  type PromptLibraryItem,
  type StudioCharacterDetail,
  type StudioKind,
} from '../../lib/api-studio';
import { useMediaQuery } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { LorebookEditor, type LorebookDraft } from '../library/lorebook-editor';
import { PresetEditor, type PresetDraft } from '../library/preset-editor';
import { addPrompt, newIdentifier, patchPrompt, readPrompts } from '../library/preset-editor/model';
import { QueryStatus, errorMessage } from '../library/shared';
import { AssistPanel } from './assist/AssistPanel';
import { useAssist, useAssistConnection } from './assist/useAssist';
import { CharacterEditor } from './character/CharacterEditor';
import { pairName } from './draft/adapters';
import { useStudioDraft, type StudioDraftApi } from './draft/useStudioDraft';
import { trackInsertTarget } from './insert-target';
import { InspectorTab } from './panels/InspectorTab';
import { PromptLibraryTab } from './panels/PromptLibraryTab';
import { TestChatPane, useTestChat, type TestChatState } from './panels/TestChatPane';
import { VersionsTab } from './panels/VersionsTab';
import type { CharacterDraft } from './types';

/*
 * 创作工作台（M6 §4.1）：`/studio/:kind/:id`。
 * 宽屏三栏：左 编辑器；中 测试对话；右 页签「AI 协作 / 检查器 / 版本 / 提示库」。
 * 1024–1279 两栏（编辑器 + 右栏，测试对话并进右栏页签）；窄屏（<1024）顶部分段切换「编辑 / 测试 / 协作」。
 * 各栏始终挂载（只切显示），切换时流式输出与滚动位置都不丢。
 */

const WIDE_QUERY = '(min-width: 1280px)';
const MEDIUM_QUERY = '(min-width: 1024px)';

type RightTab = 'assist' | 'inspector' | 'versions' | 'library' | 'test';
type NarrowPane = 'edit' | 'test' | 'assist';

/** 入口页「一句话生成」经路由 state 带过来 */
export interface StudioLocationState {
  generate?: string;
}

export function StudioWorkbenchPage() {
  const { t } = useTranslation();
  const { kind = '', id = '' } = useParams();
  if (!isStudioKind(kind) || !id) {
    return (
      <div className="p-8 text-sm text-ink-2">
        <p>{t('studio.notFound')}</p>
        <Link to="/studio" className="mt-2 inline-block text-accent underline underline-offset-2">
          {t('studio.back')}
        </Link>
      </div>
    );
  }
  // key：换实体就整体重建（草稿、协作对话、测试会话都按实体来）
  return <Workbench key={`${kind}:${id}`} kind={kind} id={id} />;
}

function Workbench({ kind, id }: { kind: StudioKind; id: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const draftApi = useStudioDraft(kind, id);
  const testChat = useTestChat(kind, id);
  const connection = useAssistConnection();
  const assist = useAssist({
    kind,
    id,
    getDraft: draftApi.assistDraft,
    applyOps: draftApi.applyOps,
    testChatId: testChat.chatId,
    connectionId: connection.connectionId,
    model: connection.model,
  });
  const isGenerating = useIsGenerating(testChat.chatId);

  const wide = useMediaQuery(WIDE_QUERY);
  const medium = useMediaQuery(MEDIUM_QUERY);
  const layout: 'wide' | 'medium' | 'narrow' = wide ? 'wide' : medium ? 'medium' : 'narrow';
  const [rightTab, setRightTab] = useState<RightTab>('assist');
  const [narrowPane, setNarrowPane] = useState<NarrowPane>('edit');
  // 宽屏没有「测试」页签：从中等宽度拉宽时退回协作
  const effectiveTab: RightTab = layout === 'wide' && rightTab === 'test' ? 'assist' : rightTab;

  const { state, dirty } = draftApi;

  /* ---------- 离开拦截 ---------- */
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (dirty) event.preventDefault();
      },
      [dirty],
    ),
  );

  /* ---------- 提示库插入落点：编辑器栏 ---------- */
  const editorRef = useRef<HTMLDivElement>(null);
  const loaded = state !== null;
  useEffect(() => {
    const root = editorRef.current;
    if (!root) return;
    return trackInsertTarget(root);
  }, [loaded]);

  /* ---------- 一句话生成：进来就以 generate 模式调一轮 ---------- */
  const generateText = (location.state as StudioLocationState | null)?.generate;
  const startedRef = useRef(false);
  useEffect(() => {
    if (!generateText || !loaded || startedRef.current) return;
    startedRef.current = true;
    // 清掉路由 state：刷新页面不会再生成一次
    void navigate(location.pathname, { replace: true, state: null });
    setRightTab('assist');
    setNarrowPane('assist');
    void assist.send(generateText, 'generate');
  }, [generateText, loaded, assist, navigate, location.pathname]);

  /* ---------- 保存：卡的开场白变了且测试会话还没聊过，就重开测试会话 ---------- */
  const save = useCallback(async () => {
    const greetingsChanged =
      state?.pair.kind === 'character' &&
      greetingsOf(state.pair.baseline) !== greetingsOf(state.pair.draft);
    const ok = await draftApi.save();
    if (!ok || !greetingsChanged) return;
    const chat = testChat.chat;
    if (!chat || chat.nodes.some((node) => node.role === 'user')) return;
    void testChat.reset();
  }, [state, draftApi, testChat]);

  const openInspector = useCallback(() => {
    setRightTab('inspector');
    setNarrowPane('assist');
  }, []);

  const unsavedEntries =
    state?.pair.kind === 'lorebook' && state.pair.draft.entries.some((entry) => entry.uid === null);

  const insertAsEntry =
    kind === 'preset' && state?.pair.kind === 'preset'
      ? (item: PromptLibraryItem) => {
          const current = draftApi.state;
          if (current?.pair.kind !== 'preset') return;
          const draft = current.pair.draft;
          const existing = new Set(
            readPrompts(draft.data).map((prompt) => String(prompt.identifier ?? '')),
          );
          const identifier = newIdentifier(existing);
          let data = addPrompt(draft.data, identifier, item.name);
          data = patchPrompt(data, identifier, {
            content: item.content,
            ...(item.role ? { role: item.role } : {}),
          });
          draftApi.setDraft({ ...draft, data });
        }
      : undefined;

  /* ---------- 各栏 ---------- */

  const title = state ? pairName(state.pair) : '';

  const editorPane = (
    <div
      ref={editorRef}
      data-part="studio-editor"
      className="h-full min-h-0 overflow-y-auto px-4 pt-4 pb-2"
    >
      <QueryStatus
        isPending={draftApi.isPending}
        error={draftApi.error}
        onRetry={draftApi.refetch}
      />
      {state && <EditorSwitch draftApi={draftApi} onSave={() => void save()} />}
    </div>
  );

  const testPane = (
    <TestChatPane
      testChat={testChat}
      dirty={dirty}
      getDraft={draftApi.assembleDraft}
      onOpenInspector={openInspector}
    />
  );

  const tabs: { value: RightTab; label: string }[] = [
    ...(layout === 'medium' ? [{ value: 'test' as const, label: t('studio.tabs.test') }] : []),
    { value: 'assist', label: t('studio.tabs.assist') },
    { value: 'inspector', label: t('studio.tabs.inspector') },
    { value: 'versions', label: t('studio.tabs.versions') },
    { value: 'library', label: t('studio.tabs.library') },
  ];
  // 窄屏的「协作」分段里不再重复「测试」
  const visibleTabs = layout === 'narrow' ? tabs.filter((tab) => tab.value !== 'test') : tabs;
  const activeTab: RightTab =
    layout === 'narrow' && effectiveTab === 'test' ? 'assist' : effectiveTab;

  const rightPane = (
    <div className="flex h-full min-h-0 flex-col">
      <Segmented
        className="shrink-0 px-3 pt-2"
        stretch
        label={t('studio.tabs.label')}
        value={activeTab}
        onChange={setRightTab}
        items={visibleTabs}
      />
      <div className="min-h-0 flex-1">
        {layout === 'medium' && (
          <div className={cn('h-full', activeTab !== 'test' && 'hidden')}>{testPane}</div>
        )}
        <div className={cn('h-full', activeTab !== 'assist' && 'hidden')}>
          <AssistPanel
            kind={kind}
            assist={assist}
            connection={connection}
            draft={state?.pair.draft}
            unsavedEntries={unsavedEntries}
            canSend={draftApi.valid}
          />
        </div>
        {activeTab === 'inspector' && (
          <RightInspector testChat={testChat} draftApi={draftApi} isGenerating={isGenerating} />
        )}
        {activeTab === 'versions' && <VersionsTab draftApi={draftApi} />}
        {activeTab === 'library' && <PromptLibraryTab onInsertAsEntry={insertAsEntry} />}
      </div>
    </div>
  );

  return (
    <div data-part="studio-shell" className="flex h-full min-h-0 flex-col">
      <header className="edge-rule flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-4 py-2">
        <Link
          to="/studio"
          className="focus-ring rounded-control inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink"
        >
          <ArrowLeft aria-hidden className="size-3.5" />
          {t('studio.back')}
        </Link>
        <h1 className="font-display min-w-0 truncate text-base">
          {title || t(`studio.kinds.${kind}`)}
        </h1>
        <Badge variant="outline">{t(`studio.kinds.${kind}`)}</Badge>
        <SaveStatus draftApi={draftApi} kind={kind} />
        <span className="ms-auto flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!dirty || draftApi.saving}
            onClick={draftApi.revert}
          >
            {t('studio.revert')}
          </Button>
          <Button
            size="sm"
            disabled={!dirty || !draftApi.valid || draftApi.saving}
            onClick={() => void save()}
          >
            {draftApi.saving ? t('studio.saving') : t('common.save')}
          </Button>
        </span>
      </header>

      {layout === 'narrow' && (
        <Segmented
          className="shrink-0 px-4 pt-2"
          stretch
          label={t('studio.panes.label')}
          value={narrowPane}
          onChange={setNarrowPane}
          items={[
            { value: 'edit', label: t('studio.panes.edit') },
            { value: 'test', label: t('studio.panes.test') },
            { value: 'assist', label: t('studio.panes.assist') },
          ]}
        />
      )}

      <div className="flex min-h-0 flex-1">
        <section
          aria-label={t('studio.panes.edit')}
          className={cn(
            'min-h-0 min-w-0',
            layout === 'narrow'
              ? cn('flex-1', narrowPane !== 'edit' && 'hidden')
              : cn(
                  'edge-rule shrink-0 border-e',
                  layout === 'wide' ? 'w-[36%] max-w-[36rem]' : 'flex-1',
                ),
          )}
        >
          {editorPane}
        </section>

        {(layout === 'wide' || layout === 'narrow') && (
          <section
            aria-label={t('studio.panes.test')}
            className={cn(
              'min-h-0 min-w-0 flex-1',
              layout === 'narrow' && narrowPane !== 'test' && 'hidden',
            )}
          >
            {testPane}
          </section>
        )}

        <aside
          data-part="studio-aside"
          aria-label={t('studio.panes.assist')}
          className={cn(
            'min-h-0 min-w-0 bg-panel',
            layout === 'narrow'
              ? cn('flex-1', narrowPane !== 'assist' && 'hidden')
              : cn('edge-rule shrink-0 border-s', layout === 'wide' ? 'w-96' : 'w-[26rem]'),
          )}
        >
          {rightPane}
        </aside>
      </div>

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        destructive
        title={t('studio.leaveTitle')}
        description={t('studio.leaveMessage')}
        confirmLabel={t('studio.leave')}
        onCancel={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
      />
    </div>
  );
}

/** 页头的保存状态：出错 / 名称为空 / 保存中 / 未保存（含 AI 改动）/ 已保存 */
function SaveStatus({ draftApi, kind }: { draftApi: StudioDraftApi; kind: StudioKind }) {
  const { t } = useTranslation();
  const { state, dirty, valid, saving, saveError, saved } = draftApi;
  if (!state) return null;
  let text: string | null = null;
  let error = false;
  if (saveError) {
    text = t('studio.saveFailed', { message: errorMessage(saveError) });
    error = true;
  } else if (dirty && !valid) {
    text = t(kind === 'character' ? 'studio.character.nameRequired' : 'studio.nameRequired');
    error = true;
  } else if (saving) text = t('studio.saving');
  else if (dirty) text = state.aiTouched ? t('studio.unsavedAi') : t('common.unsaved');
  else if (saved) text = t('studio.saved');
  if (!text) return null;
  return (
    <span
      role={error ? 'alert' : 'status'}
      data-part="studio-save-status"
      className={cn('min-w-0 truncate text-[11px]', error ? 'text-danger' : 'text-ink-2')}
    >
      {text}
    </span>
  );
}

function greetingsOf(data: CharacterDraft): string {
  return JSON.stringify([data.first_mes ?? '', data.alternate_greetings ?? []]);
}

function RightInspector({
  testChat,
  draftApi,
  isGenerating,
}: {
  testChat: TestChatState;
  draftApi: StudioDraftApi;
  isGenerating: boolean;
}) {
  if (!testChat.chat) {
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
    <InspectorTab
      chat={testChat.chat}
      revision={draftApi.state?.revision ?? 0}
      dirty={draftApi.dirty}
      getDraft={draftApi.assembleDraft}
      isGenerating={isGenerating}
      active
    />
  );
}

/** 按 kind 渲染对应的受控编辑器 */
function EditorSwitch({ draftApi, onSave }: { draftApi: StudioDraftApi; onSave: () => void }) {
  const navigate = useNavigate();
  const { state } = draftApi;
  // 保存条由工作台页头统一提供，嵌入的编辑器不再各带一套
  const common = {
    onSave,
    saving: draftApi.saving,
    saveError: draftApi.saveError,
    saved: draftApi.saved,
    hideSaveBar: true,
  };
  const onChange = draftApi.setDraft;
  if (!state) return null;
  switch (state.pair.kind) {
    case 'character':
      return (
        <CharacterEditor
          characterId={draftApi.id}
          detail={draftApi.detail as StudioCharacterDetail | undefined}
          value={state.pair.draft}
          baseline={state.pair.baseline}
          onChange={onChange}
          onDetail={draftApi.updateDetail}
          onOpenBook={(bookId) => void navigate(`/studio/lorebook/${encodeURIComponent(bookId)}`)}
        />
      );
    case 'preset':
      return (
        <PresetEditor
          embedded
          value={state.pair.draft}
          baseline={state.pair.baseline}
          onChange={onChange as (next: PresetDraft) => void}
          {...common}
        />
      );
    case 'lorebook':
      return (
        <LorebookEditor
          embedded
          bookId={draftApi.id}
          value={state.pair.draft}
          baseline={state.pair.baseline}
          onChange={onChange as (next: LorebookDraft) => void}
          {...common}
        />
      );
  }
}
