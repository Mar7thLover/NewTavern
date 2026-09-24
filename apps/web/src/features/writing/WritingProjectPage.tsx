import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Download, PanelLeft, PanelRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';

import { ChapterTree, OUTLINE_DOC } from './ChapterTree';
import { useWritingCommands } from './commands';
import { CompareDialog } from './CompareDialog';
import { DocumentPane } from './DocumentPane';
import { cursorContext, docText } from './editor/pending';
import { OutlinePane } from './OutlinePane';
import { AiPanel } from './panels/AiPanel';
import { BiblePanel } from './panels/BiblePanel';
import { ContextPanel } from './panels/ContextPanel';
import { StylePanel } from './panels/StylePanel';
import { VersionsPanel } from './panels/VersionsPanel';
import { useWritingAi, type AiNotice, type DocSession } from './useWritingAi';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui/button';
import { Drawer } from '../../components/ui/drawer';
import { IconButton } from '../../components/ui/icon-button';
import { Segmented } from '../../components/ui/segmented';
import { toast } from '../../components/ui/toast';
import { useConnections, useGenerationDefault } from '../../lib/api';
import {
  createWritingVersion,
  exportUrl,
  saveWritingDocument,
  useCreateWritingDocument,
  useDeleteWritingDocument,
  useReorderWritingDocuments,
  useUpdateWritingDocument,
  useUpdateWritingProject,
  useWritingDocument,
  useWritingProject,
  type WritingAiRequest,
  type WritingDocumentSummary,
  type WritingProjectDetail,
  type WritingVersionDetail,
} from '../../lib/api-writing';
import { useMediaQuery } from '../../lib/hooks';
import { cn } from '../../lib/utils';
import { EmptyState, QueryStatus } from '../library/shared';

/** 三栏同时显示的断点（M7 §5.2：窄于 1024 左右栏变抽屉） */
const WIDE_QUERY = '(min-width: 1024px)';

type PanelTab = 'ai' | 'bible' | 'style' | 'context' | 'versions';
const PANEL_TABS: readonly PanelTab[] = ['ai', 'bible', 'style', 'context', 'versions'];

/** 窄屏底部工具条上的动作 */
const TOOLBAR_ACTIONS = ['continue', 'rewrite', 'expand', 'condense'] as const;

export function WritingProjectPage() {
  const { t } = useTranslation();
  const { projectId = '' } = useParams();
  const project = useWritingProject(projectId);

  if (!project.data) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-10">
        <QueryStatus
          isPending={project.isPending}
          error={project.error}
          onRetry={() => void project.refetch()}
        />
        {project.error && (
          <Link
            to="/writing"
            className="mt-4 inline-block text-sm text-accent underline underline-offset-2"
          >
            {t('writing.project.back')}
          </Link>
        )}
      </div>
    );
  }
  return <ProjectWorkspace project={project.data} />;
}

function ProjectWorkspace({ project }: { project: WritingProjectDetail }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const wide = useMediaQuery(WIDE_QUERY);

  const [treeDrawer, setTreeDrawer] = useState(false);
  const [panelDrawer, setPanelDrawer] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [tab, setTab] = useState<PanelTab>('ai');
  const [session, setSessionState] = useState<DocSession | null>(null);
  const sessionRef = useRef<DocSession | null>(null);
  const [dirty, setDirty] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [pendingDelete, setPendingDelete] = useState<WritingDocumentSummary | null>(null);

  const setSession = useCallback((next: DocSession | null) => {
    sessionRef.current = next;
    setSessionState(next);
  }, []);

  /* ---------------- 当前文档 ---------------- */

  const documents = project.documents;
  const chapters = useMemo(() => documents.filter((doc) => doc.kind === 'chapter'), [documents]);
  const docParam = searchParams.get('doc');
  const currentId =
    docParam === OUTLINE_DOC
      ? OUTLINE_DOC
      : (documents.find((doc) => doc.id === docParam)?.id ??
        chapters[0]?.id ??
        documents[0]?.id ??
        null);
  const current = documents.find((doc) => doc.id === currentId) ?? null;
  const detail = useWritingDocument(current?.id ?? null);
  const chapterNumber = current?.kind === 'chapter' ? chapters.indexOf(current) + 1 : null;
  const lang = project.settings.language === 'en' ? 'en' : 'zh-CN';

  /* ---------------- 连接是否可用（与服务端同一回落顺序） ---------------- */

  const connections = useConnections();
  const generationDefault = useGenerationDefault();
  const effectiveConnection =
    project.settings.connectionId ?? generationDefault.data?.connectionId ?? null;
  const effectiveModel = project.settings.model ?? generationDefault.data?.model ?? null;
  const ready =
    !!effectiveConnection &&
    !!effectiveModel &&
    (connections.data?.some((connection) => connection.id === effectiveConnection) ?? false);

  const onNotice = useCallback(
    (notice: AiNotice) => {
      switch (notice.kind) {
        case 'needConnection':
          toast({
            title: t('writing.ai.noConnectionTitle'),
            description: t('writing.ai.noConnectionHint'),
            tone: 'warning',
            action: {
              label: t('writing.ai.goConnect'),
              onClick: () => void navigate('/connections'),
            },
          });
          break;
        case 'needSelection':
          toast({ title: t('writing.ai.needSelection'), tone: 'info' });
          break;
        case 'needInstruction':
          toast({ title: t('writing.ai.needInstruction'), tone: 'info' });
          break;
        case 'failed':
          toast({ title: t('writing.ai.failed', { message: notice.message }), tone: 'danger' });
          break;
        case 'summaryDone':
          toast({ title: t('writing.ai.summaryDone'), tone: 'success' });
          break;
        default:
          break;
      }
    },
    [navigate, t],
  );

  const targetLength =
    typeof project.settings.targetLength === 'number' ? project.settings.targetLength : undefined;
  const ai = useWritingAi({ sessionRef, ready, targetLength, onNotice });

  /* ---------------- 变更 ---------------- */

  const updateProject = useUpdateWritingProject(project.id);
  const createDoc = useCreateWritingDocument(project.id);
  const deleteDoc = useDeleteWritingDocument(project.id);
  const reorder = useReorderWritingDocuments(project.id);
  const updateDoc = useUpdateWritingDocument();

  const selectDoc = useCallback(
    (id: string) => {
      if (ai.phase !== 'idle') {
        toast({ title: t('writing.ai.resolveFirst'), tone: 'info' });
        return;
      }
      setSearchParams({ doc: id });
      setTreeDrawer(false);
    },
    [ai.phase, setSearchParams, t],
  );

  const createDocument = useCallback(
    (kind: 'chapter' | 'note') => {
      if (ai.phase !== 'idle') {
        toast({ title: t('writing.ai.resolveFirst'), tone: 'info' });
        return;
      }
      createDoc.mutate(
        { kind },
        {
          onSuccess: (doc) => {
            setSearchParams({ doc: doc.id });
            setTreeDrawer(false);
          },
          onError: (error) =>
            toast({
              title: t('writing.project.failed', { message: error.message }),
              tone: 'danger',
            }),
        },
      );
    },
    [ai.phase, createDoc, setSearchParams, t],
  );

  const toggleDone = async (doc: WritingDocumentSummary) => {
    // 标记完成时服务端按库里的正文写摘要：先把编辑器里的改动存掉
    if (sessionRef.current?.docId === doc.id)
      await sessionRef.current.flush().catch(() => undefined);
    updateDoc.mutate({ id: doc.id, done: !doc.done });
  };

  // 当前打开的章节按编辑器里的稿子生成，其余按库里的正文
  const summarizeDoc = (doc: WritingDocumentSummary) => void ai.summarize(doc.id);

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    deleteDoc.mutate(target.id, {
      onSuccess: () => {
        setPendingDelete(null);
        if (target.id === current?.id) {
          const rest = documents.filter((doc) => doc.id !== target.id);
          const next = rest.find((doc) => doc.kind === target.kind) ?? rest[0];
          setSearchParams(next ? { doc: next.id } : {});
        }
      },
    });
  };

  const saveSettings = (patch: Record<string, unknown>) =>
    updateProject.mutateAsync({ settings: patch });

  const saveVersion = useCallback(
    async (label?: string) => {
      const active = sessionRef.current;
      if (!active) return;
      try {
        await active.flush();
        const version = await createWritingVersion(queryClient, active.docId, {
          author: 'user',
          ...(label ? { label } : {}),
        });
        active.noteVersioned();
        toast({
          title:
            version === null
              ? t('writing.versions.unchanged')
              : t('writing.versions.saved', { version }),
          tone: version === null ? 'info' : 'success',
        });
      } catch (error) {
        toast({
          title: t('writing.project.failed', {
            message: error instanceof Error ? error.message : String(error),
          }),
          tone: 'danger',
        });
      }
    },
    [queryClient, t],
  );

  const newChapterFrom = async (version: WritingVersionDetail) => {
    const base = current;
    const doc = await createDoc.mutateAsync({
      kind: 'chapter',
      ...(base?.kind === 'chapter' ? { afterId: base.id } : {}),
    });
    const title = base?.title.trim()
      ? t('writing.versions.copyTitle', { title: base.title.trim(), version: version.version })
      : '';
    await saveWritingDocument(queryClient, doc.id, {
      content: version.content,
      text: version.text,
      ...(title ? { title } : {}),
    });
    await queryClient.invalidateQueries({ queryKey: ['writing', 'project', project.id] });
    setSearchParams({ doc: doc.id });
  };

  const buildRequest = (): WritingAiRequest | null => {
    const active = sessionRef.current;
    if (!active || active.editor.isDestroyed) return null;
    const ctx = cursorContext(active.editor.state);
    return {
      action: 'continue',
      cursor: ctx.textBefore.length,
      textBefore: ctx.textBefore,
      textAfter: ctx.textAfter,
      ...(ctx.selectionText
        ? {
            selectionText: ctx.selectionText,
            selection: {
              from: ctx.textBefore.length,
              to: ctx.textBefore.length + ctx.selectionText.length,
            },
          }
        : {}),
      ...(targetLength ? { targetLength } : {}),
    };
  };

  /* ---------------- 命令面板 ---------------- */

  const request = useWritingCommands((state) => state.request);
  useEffect(() => {
    if (!request) return;
    useWritingCommands.getState().clear(request.nonce);
    switch (request.command) {
      case 'newChapter':
        createDocument('chapter');
        break;
      case 'aiContinue':
        if (!sessionRef.current) toast({ title: t('writing.ai.noDocument'), tone: 'info' });
        else void ai.run('continue');
        break;
      case 'saveVersion':
        if (!sessionRef.current) toast({ title: t('writing.ai.noDocument'), tone: 'info' });
        else void saveVersion();
        break;
      default:
        break;
    }
  }, [request, createDocument, ai, saveVersion, t]);

  /* ---------------- 离开拦截 ---------------- */

  const busy = dirty || ai.phase === 'streaming';
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      busy && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (!busy) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy]);
  const [leaving, setLeaving] = useState(false);
  const saveAndLeave = async () => {
    setLeaving(true);
    ai.stop();
    try {
      await sessionRef.current?.flush();
    } catch {
      // 存不上也按用户的意思离开：卸载时还会再试一次
    }
    setLeaving(false);
    blocker.proceed?.();
  };

  /* ---------------- 布局 ---------------- */

  const panelOpen = wide ? !panelCollapsed : panelDrawer;
  const togglePanel = () =>
    wide ? setPanelCollapsed((value) => !value) : setPanelDrawer((value) => !value);

  const treeButton = !wide ? (
    <IconButton label={t('writing.project.openTree')} size="md" onClick={() => setTreeDrawer(true)}>
      <PanelLeft aria-hidden />
    </IconButton>
  ) : null;
  const panelButton = (
    <IconButton
      label={t('writing.project.openPanel')}
      size="md"
      aria-pressed={panelOpen}
      onClick={togglePanel}
    >
      <PanelRight aria-hidden />
    </IconButton>
  );

  const tree = (
    <div className="flex h-full min-h-0 flex-col">
      <ProjectHead project={project} onRename={(title) => updateProject.mutate({ title })} />
      <div className="min-h-0 flex-1">
        <ChapterTree
          project={project}
          current={currentId}
          summarizing={ai.summarizing}
          busy={createDoc.isPending}
          onSelect={selectDoc}
          onCreate={createDocument}
          onReorder={(ids) => reorder.mutate(ids)}
          onToggleDone={(doc) => void toggleDone(doc)}
          onSummarize={summarizeDoc}
          onDelete={setPendingDelete}
        />
      </div>
    </div>
  );

  const panel = (
    <div data-part="writing-panel" className="flex h-full min-h-0 flex-col">
      <Segmented
        className="shrink-0 px-3 pt-2"
        stretch
        size="sm"
        value={tab}
        onChange={setTab}
        label={t('writing.project.openPanel')}
        items={PANEL_TABS.map((value) => ({ value, label: t(`writing.tabs.${value}`) }))}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'ai' && (
          <AiPanel
            project={project}
            ai={ai}
            ready={ready}
            hasDocument={session !== null}
            isChapter={current?.kind === 'chapter'}
            hasSelection={hasSelection}
            instruction={instruction}
            onInstructionChange={setInstruction}
            onSettings={(patch) => void saveSettings(patch)}
          />
        )}
        {tab === 'bible' && (
          <BiblePanel
            project={project}
            saving={updateProject.isPending}
            onChange={(lorebookIds) => updateProject.mutate({ lorebookIds })}
          />
        )}
        {tab === 'style' && (
          <StylePanel project={project} saving={updateProject.isPending} onSave={saveSettings} />
        )}
        {tab === 'context' && (
          <ContextPanel projectId={project.id} doc={current} ai={ai} buildRequest={buildRequest} />
        )}
        {tab === 'versions' && (
          <VersionsPanel
            key={current?.id ?? 'none'}
            doc={current}
            session={session}
            currentText={() =>
              session && !session.editor.isDestroyed ? docText(session.editor.state.doc) : ''
            }
            onSaveVersion={saveVersion}
            onNewChapterFrom={newChapterFrom}
          />
        )}
      </div>
    </div>
  );

  let center: ReactNode;
  if (currentId === OUTLINE_DOC) {
    center = (
      <OutlinePane
        outline={project.outline}
        leading={treeButton}
        trailing={panelButton}
        onSave={(outline) => updateProject.mutateAsync({ outline })}
        onDirtyChange={setDirty}
      />
    );
  } else if (!current) {
    center = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="edge-rule flex items-center gap-2 border-b px-3 py-2">
          {treeButton}
          <span className="flex-1" />
          {panelButton}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <EmptyState
            kind="chats"
            title={t('writing.project.emptyTitle')}
            hint={t('writing.project.emptyHint')}
            action={
              <Button disabled={createDoc.isPending} onClick={() => createDocument('chapter')}>
                {t('writing.tree.newChapter')}
              </Button>
            }
          />
        </div>
      </div>
    );
  } else if (!detail.data) {
    center = (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="edge-rule flex items-center gap-2 border-b px-3 py-2">
          {treeButton}
          <span className="flex-1" />
          {panelButton}
        </div>
        <div className="mx-auto w-full max-w-lg px-4 py-10">
          <QueryStatus
            isPending={detail.isPending}
            error={detail.error}
            onRetry={() => void detail.refetch()}
          />
        </div>
      </div>
    );
  } else {
    center = (
      <DocumentPane
        key={detail.data.id}
        doc={detail.data}
        chapterNumber={chapterNumber}
        lang={lang}
        ai={ai}
        leading={treeButton}
        trailing={panelButton}
        onSession={setSession}
        onDirtyChange={setDirty}
        onSelectionChange={setHasSelection}
      />
    );
  }

  const showToolbar = !wide && session !== null && ai.phase === 'idle' && currentId !== OUTLINE_DOC;

  return (
    <div data-part="writing-shell" className="flex h-full min-h-0 overflow-hidden">
      {wide && (
        <aside
          data-part="writing-aside"
          data-side="start"
          className="surface-panel edge-rule w-64 shrink-0 border-e"
        >
          {tree}
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {center}
        {showToolbar && (
          <div
            data-part="writing-toolbar"
            role="toolbar"
            aria-label={t('writing.toolbar.label')}
            className="surface-raised edge-rule flex shrink-0 items-center gap-1.5 overflow-x-auto border-t px-3 py-2"
          >
            {TOOLBAR_ACTIONS.map((action) => (
              <Button
                key={action}
                size="sm"
                variant={action === 'continue' ? 'default' : 'ghost'}
                onClick={() => void ai.run(action)}
                className="shrink-0"
              >
                {t(`writing.ai.actions.${action}`)}
              </Button>
            ))}
            <span className="flex-1" />
            <Button
              size="sm"
              variant="outline"
              className="shrink-0"
              onClick={() => {
                setTab('ai');
                setPanelDrawer(true);
              }}
            >
              {t('writing.toolbar.more')}
            </Button>
          </div>
        )}
      </div>

      {wide && !panelCollapsed && (
        <aside
          data-part="writing-aside"
          data-side="end"
          className="surface-panel edge-rule w-80 shrink-0 border-s xl:w-96"
        >
          {panel}
        </aside>
      )}

      {!wide && (
        <Drawer open={treeDrawer} side="left" onClose={() => setTreeDrawer(false)}>
          {tree}
        </Drawer>
      )}
      {!wide && (
        <Drawer
          open={panelDrawer}
          side="right"
          title={t('writing.project.openPanel')}
          onClose={() => setPanelDrawer(false)}
        >
          {panel}
        </Drawer>
      )}

      <CompareDialog ai={ai} />

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title={t('writing.tree.deleteConfirm', {
          title:
            pendingDelete?.title.trim() ||
            (pendingDelete?.kind === 'note'
              ? t('writing.tree.untitledNote')
              : t('writing.tree.untitledChapter')),
        })}
        description={t('writing.tree.deleteHint')}
        confirmLabel={t('common.delete')}
        pending={deleteDoc.isPending}
        error={deleteDoc.error?.message ?? null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />

      <Modal
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        size="sm"
        dismissible={!leaving}
        title={t('writing.leave.title')}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={leaving}
              onClick={() => blocker.reset?.()}
            >
              {t('writing.leave.stay')}
            </Button>
            <Button size="sm" disabled={leaving} onClick={() => void saveAndLeave()} autoFocus>
              {leaving ? t('common.processing') : t('writing.leave.saveAndLeave')}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-2">
          {ai.phase === 'streaming' ? t('writing.leave.streaming') : t('writing.leave.hint')}
        </p>
      </Modal>
    </div>
  );
}

/** 左栏顶部：回到作品列表、书名（可改）、导出 */
function ProjectHead({
  project,
  onRename,
}: {
  project: WritingProjectDetail;
  onRename: (title: string) => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(project.title);
  useEffect(() => setTitle(project.title), [project.title]);
  const commit = () => {
    const next = title.trim();
    if (next && next !== project.title) onRename(next);
    else setTitle(project.title);
  };
  return (
    <div data-part="writing-project-head" className="edge-rule shrink-0 border-b px-4 pt-3 pb-3">
      <Link
        to="/writing"
        className="focus-ring rounded-control inline-flex items-center gap-1 text-[11px] text-ink-3 hover:text-ink"
      >
        <ArrowLeft aria-hidden className="size-3" />
        {t('writing.project.back')}
      </Link>
      <input
        value={title}
        aria-label={t('writing.project.titleLabel')}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className="font-display focus-ring mt-1.5 w-full min-w-0 truncate bg-transparent text-base leading-snug text-ink outline-none"
      />
      <div className="mt-2 flex items-center gap-3 text-[11px] text-ink-3">
        <Download aria-hidden className="size-3" />
        {(['md', 'txt'] as const).map((format) => (
          <a
            key={format}
            href={exportUrl(project.id, format)}
            download
            className={cn('focus-ring rounded-control hover:text-ink')}
          >
            {t(`writing.project.export.${format}`)}
          </a>
        ))}
      </div>
    </div>
  );
}
