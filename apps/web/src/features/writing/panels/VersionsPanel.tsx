import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Button } from '../../../components/ui/button';
import { FieldLabel, Input } from '../../../components/ui/field';
import { toast } from '../../../components/ui/toast';
import {
  restoreWritingVersion,
  useWritingVersion,
  useWritingVersions,
  type WritingDocumentSummary,
  type WritingVersionDetail,
  type WritingVersionSummary,
} from '../../../lib/api-writing';
import { cn } from '../../../lib/utils';
import { formatDate } from '../../library/shared';
import { DiffView } from '../DiffView';
import type { DocSession } from '../useWritingAi';

/**
 * 右栏「版本」页签（M7 §5.4）：列表（版本号、作者、标签、时间、字数变化），选中看与当前稿的对照；
 * 「恢复」「以此为基础新建章节」；上面可以手动存一版。
 */
export function VersionsPanel({
  doc,
  session,
  currentText,
  onSaveVersion,
  onNewChapterFrom,
}: {
  doc: WritingDocumentSummary | null;
  session: DocSession | null;
  /** 编辑器里的当前稿（纯文本） */
  currentText: () => string;
  onSaveVersion: (label?: string) => Promise<void>;
  onNewChapterFrom: (version: WritingVersionDetail) => Promise<void>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const docId = doc?.id ?? null;
  const versions = useWritingVersions(docId);
  const [selected, setSelected] = useState<number | null>(null);
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const detail = useWritingVersion(docId, selected);

  if (!doc) {
    return <p className="p-4 text-xs text-ink-3">{t('writing.context.noDocument')}</p>;
  }

  const list = versions.data ?? [];

  const saveVersion = async () => {
    setSaving(true);
    try {
      await onSaveVersion(label.trim() || undefined);
      setLabel('');
    } finally {
      setSaving(false);
    }
  };

  const restore = async (version: number) => {
    setRestoring(version);
    try {
      await session?.flush();
      const document = await restoreWritingVersion(queryClient, doc.id, version);
      session?.load(document.content, document.text);
      session?.noteVersioned();
      setSelected(null);
      toast({ title: t('writing.versions.restored', { version }), tone: 'success' });
    } catch (error) {
      toast({
        title: t('writing.versions.restoreFailed'),
        description: error instanceof Error ? error.message : String(error),
        tone: 'danger',
      });
    } finally {
      setRestoring(null);
      setConfirmRestore(null);
    }
  };

  return (
    <div data-part="writing-versions-panel" className="flex flex-col gap-5 p-4">
      <section>
        <FieldLabel htmlFor="writing-version-label">{t('writing.versions.save')}</FieldLabel>
        <div className="flex gap-2">
          <Input
            id="writing-version-label"
            size="sm"
            value={label}
            placeholder={t('writing.versions.labelPlaceholder')}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveVersion();
            }}
          />
          <Button size="sm" disabled={saving || !session} onClick={() => void saveVersion()}>
            {saving ? t('common.processing') : t('writing.versions.saveShort')}
          </Button>
        </div>
      </section>

      <section>
        <FieldLabel>{t('writing.versions.list')}</FieldLabel>
        {versions.isPending ? (
          <p className="text-xs text-ink-3">{t('common.loading')}</p>
        ) : list.length === 0 ? (
          <p className="text-xs text-ink-3">{t('writing.versions.empty')}</p>
        ) : (
          <ol
            data-part="writing-version-list"
            className="edge-rule rounded-card max-h-72 divide-y divide-edge overflow-y-auto border"
          >
            {list.map((version, index) => (
              <VersionRow
                key={version.version}
                version={version}
                previous={list[index + 1] ?? null}
                active={selected === version.version}
                onSelect={() => setSelected(selected === version.version ? null : version.version)}
              />
            ))}
          </ol>
        )}
      </section>

      {selected !== null && (
        <section data-part="writing-version-compare">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <FieldLabel>{t('writing.versions.compare', { version: selected })}</FieldLabel>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!detail.data || creating}
                onClick={() => {
                  if (!detail.data) return;
                  setCreating(true);
                  void onNewChapterFrom(detail.data).finally(() => setCreating(false));
                }}
              >
                {t('writing.versions.newChapter')}
              </Button>
              <Button
                size="sm"
                disabled={!detail.data || restoring !== null}
                onClick={() => setConfirmRestore(selected)}
              >
                {t('writing.versions.restore')}
              </Button>
            </div>
          </div>
          {detail.data ? (
            <div className="edge-rule rounded-card max-h-[50dvh] overflow-y-auto border p-3">
              <DiffView before={detail.data.text} after={currentText()} />
            </div>
          ) : (
            <p className="text-xs text-ink-3">{t('common.loading')}</p>
          )}
          <p className="mt-1.5 text-[11px] text-ink-3">{t('writing.versions.compareHint')}</p>
        </section>
      )}

      <ConfirmDialog
        open={confirmRestore !== null}
        title={t('writing.versions.restoreConfirm', { version: confirmRestore ?? 0 })}
        description={t('writing.versions.restoreHint')}
        confirmLabel={t('writing.versions.restore')}
        pending={restoring !== null}
        onCancel={() => setConfirmRestore(null)}
        onConfirm={() => confirmRestore !== null && void restore(confirmRestore)}
      />
    </div>
  );
}

function VersionRow({
  version,
  previous,
  active,
  onSelect,
}: {
  version: WritingVersionSummary;
  previous: WritingVersionSummary | null;
  active: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const delta = previous ? version.wordCount - previous.wordCount : version.wordCount;
  return (
    <li data-part="writing-version" data-active={active} data-author={version.author}>
      <button
        type="button"
        aria-pressed={active}
        onClick={onSelect}
        className={cn(
          'focus-ring-inset flex w-full cursor-pointer items-baseline gap-2 px-3 py-2 text-left text-xs',
          active ? 'bg-accent-soft text-ink' : 'text-ink-story hover:text-ink',
        )}
      >
        <span className="w-8 shrink-0 text-ink-3 tabular-nums">#{version.version}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            {t(`writing.versions.author.${version.author}`)}
            {version.label ? ` · ${versionLabel(version.label, t)}` : ''}
          </span>
          <span className="block text-[11px] text-ink-3">{formatDate(version.createdAt)}</span>
        </span>
        <span
          className={cn(
            'shrink-0 tabular-nums',
            delta > 0 ? 'text-ink-2' : delta < 0 ? 'text-ink-3' : 'text-ink-3',
          )}
        >
          {delta > 0 ? `+${delta}` : delta}
        </span>
      </button>
    </li>
  );
}

/** 服务端 / 前端写的机器标签（before:continue、ai:rewrite、auto）换成人话 */
function versionLabel(
  label: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const [kind, action] = label.split(':');
  if (label === 'auto') return t('writing.versions.labels.auto');
  if (label === 'before:restore') return t('writing.versions.labels.beforeRestore');
  if ((kind === 'before' || kind === 'ai') && action) {
    return t(`writing.versions.labels.${kind}`, {
      action: t(`writing.ai.actions.${action}`, { defaultValue: action }),
    });
  }
  return label;
}
