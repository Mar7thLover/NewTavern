import { Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui/button';
import { FieldLabel, Input } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import {
  useCreateWritingProject,
  useDeleteWritingProject,
  useWritingProjects,
  type WritingProjectSummary,
} from '../../lib/api-writing';
import { EmptyState, formatDate, LibraryHeader, QueryStatus } from '../library/shared';

/** 项目页（带编辑器）的分块：列表页空闲时先取回来，点进作品不用等 */
const preloadProjectPage = () => import('./WritingProjectPage');

/**
 * `/writing`：作品列表（标题、章节数、字数、最近更新）+ 新建（M7 §5.1）。
 */
export function WritingListPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const projects = useWritingProjects();
  const create = useCreateWritingProject();
  const remove = useDeleteWritingProject();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [pendingDelete, setPendingDelete] = useState<WritingProjectSummary | null>(null);

  useEffect(() => {
    const idle = () => void preloadProjectPage().catch(() => undefined);
    if ('requestIdleCallback' in window) {
      const handle = window.requestIdleCallback(idle, { timeout: 3000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = globalThis.setTimeout(idle, 1200);
    return () => globalThis.clearTimeout(timer);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const name = title.trim();
    create.mutate(
      { title: name },
      {
        onSuccess: (project) => {
          setCreating(false);
          setTitle('');
          void navigate(`/writing/${encodeURIComponent(project.id)}`);
        },
      },
    );
  };

  const list = [...(projects.data ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div data-part="writing-list" className="mx-auto w-full max-w-5xl">
      <LibraryHeader
        title={t('writing.title')}
        subtitle={t('writing.subtitle')}
        actions={
          list.length > 0 && (
            <Button
              onClick={() => {
                create.reset();
                setCreating(true);
              }}
            >
              {t('writing.list.new')}
            </Button>
          )
        }
      />

      <QueryStatus
        isPending={projects.isPending}
        error={projects.error}
        onRetry={() => void projects.refetch()}
      />

      {projects.data && list.length === 0 && (
        <EmptyState
          kind="chats"
          title={t('writing.list.empty')}
          hint={t('writing.list.emptyHint')}
          action={
            <Button
              onClick={() => {
                create.reset();
                setCreating(true);
              }}
            >
              {t('writing.list.new')}
            </Button>
          }
        />
      )}

      {list.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((project) => (
            <li
              key={project.id}
              data-part="writing-project-card"
              className="surface-reading edge-rule rounded-card group relative flex min-w-0 flex-col border"
            >
              <Link
                to={`/writing/${encodeURIComponent(project.id)}`}
                onMouseEnter={() => void preloadProjectPage().catch(() => undefined)}
                className="focus-ring rounded-card flex min-w-0 flex-1 flex-col gap-3 p-5"
              >
                <span className="font-display min-w-0 truncate pe-8 text-lg leading-snug text-ink">
                  {project.title.trim() || t('writing.list.untitled')}
                </span>
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-2 tabular-nums">
                  <span>{t('writing.list.chapters', { count: project.chapterCount })}</span>
                  <span>{t('writing.list.words', { count: project.wordCount })}</span>
                  {project.noteCount > 0 && (
                    <span>{t('writing.list.notes', { count: project.noteCount })}</span>
                  )}
                </span>
                <span className="mt-auto text-[11px] text-ink-3">
                  {t('writing.list.updated', { time: formatDate(project.updatedAt) })}
                </span>
              </Link>
              <IconButton
                label={t('writing.list.delete')}
                variant="destructive"
                size="sm"
                onClick={() => setPendingDelete(project)}
                className="absolute end-3 top-3 opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
              >
                <Trash2 aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        size="sm"
        dismissible={!create.isPending}
        title={t('writing.create.title')}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setCreating(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" type="submit" form="writing-create-form" disabled={create.isPending}>
              {create.isPending ? t('common.processing') : t('writing.create.submit')}
            </Button>
          </>
        }
      >
        <form id="writing-create-form" onSubmit={submit}>
          <FieldLabel htmlFor="writing-create-title">{t('writing.create.name')}</FieldLabel>
          <Input
            id="writing-create-title"
            autoFocus
            value={title}
            placeholder={t('writing.create.placeholder')}
            onChange={(event) => setTitle(event.target.value)}
          />
          {create.error && (
            <p role="alert" className="mt-2 text-xs text-danger">
              {create.error.message}
            </p>
          )}
        </form>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title={t('writing.list.deleteConfirm', {
          title: pendingDelete?.title.trim() || t('writing.list.untitled'),
        })}
        description={t('writing.list.deleteHint')}
        confirmLabel={t('common.delete')}
        pending={remove.isPending}
        error={remove.error?.message ?? null}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) })
        }
      />
    </div>
  );
}
