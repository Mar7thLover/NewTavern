import { ChevronDown, ChevronUp, Download, GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  moveItem,
  SCRIPTS_IMPORT_URL,
  scriptExportUrl,
  useCreateScript,
  useDeleteScript,
  useReorderScripts,
  useScripts,
  useSetScriptOwnerEnabled,
  useUpdateScript,
  type ScriptRow,
  type ScriptScope,
} from './api';
import { EMPTY_SCRIPT_DRAFT, ScriptEditor, type ScriptDraft } from './ScriptEditor';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import { Switch } from '../../components/ui/switch';
import { useCardSettings } from '../../lib/api-cards';
import { mutate, useDefaultPresetId, usePresets } from '../../lib/api';
import { cn } from '../../lib/utils';
import { errorMessage } from '../library/shared';
import { SettingsSection } from '../settings/shared';

/**
 * 设置 · 脚本库（`?section=scripts`，M5（三）§2.3）。
 *
 * 两组：**我的脚本**（全局，每个会话都跑）与**预设自带**（跟着预设走，只在用这个预设的会话里跑）。
 * 预设组用一个下拉选看哪份预设——设置页没有「当前会话」，缺省落在「新对话默认用的预设」上，
 * 那是用户最常打交道的一份；想看别的预设直接切。
 * 角色卡自带的脚本仍在卡里（工作台编辑），这里不列。
 *
 * 排序：桌面拖拽（原生 HTML5 drag），窄屏用上下移按钮（触屏上 HTML5 drag 不可用）。
 */
export function ScriptsSettings() {
  const { t } = useTranslation();
  const cards = useCardSettings();
  const presets = usePresets();
  const defaultPreset = useDefaultPresetId();
  const [presetId, setPresetId] = useState<string | null>(null);

  // 预设组缺省：默认预设 → 第一份预设
  useEffect(() => {
    if (presetId !== null || !presets.data || presets.data.length === 0) return;
    const fallback = presets.data.find((preset) => preset.id === defaultPreset.data)?.id;
    setPresetId(fallback ?? presets.data[0]?.id ?? null);
  }, [presetId, presets.data, defaultPreset.data]);

  const runnerOff = cards.data?.scripts === false;

  return (
    <div className="space-y-10">
      {runnerOff && (
        <p
          role="status"
          data-part="scripts-runner-off"
          className="edge-rule border-s-2 ps-3 text-xs leading-relaxed text-warning"
        >
          {t('scripts.runnerOff')}
        </p>
      )}

      <ScriptGroup
        scope="global"
        ownerId={null}
        title={t('scripts.global')}
        hint={t('scripts.globalHint')}
      />

      <ScriptGroup
        scope="preset"
        ownerId={presetId}
        title={t('scripts.preset')}
        hint={t('scripts.presetHint')}
        picker={
          <Select
            size="sm"
            className="w-48 max-w-full"
            aria-label={t('scripts.presetPick')}
            value={presetId ?? ''}
            disabled={!presets.data || presets.data.length === 0}
            onChange={(event) => setPresetId(event.target.value || null)}
          >
            {(presets.data ?? []).length === 0 && (
              <option value="">{t('scripts.presetNone')}</option>
            )}
            {(presets.data ?? []).map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </Select>
        }
      />
    </div>
  );
}

interface ScriptGroupProps {
  scope: ScriptScope;
  ownerId: string | null;
  title: string;
  hint: string;
  picker?: ReactNode;
}

/** 编辑器的目标：新建（null）或某一行 */
type EditTarget = { kind: 'new' } | { kind: 'edit'; script: ScriptRow };

function draftOf(script: ScriptRow): ScriptDraft {
  return {
    name: script.name,
    content: script.content,
    info: script.info,
    buttons: script.buttons,
    buttonsEnabled: script.buttonsEnabled,
  };
}

function ScriptGroup({ scope, ownerId, title, hint, picker }: ScriptGroupProps) {
  const { t } = useTranslation();
  const scripts = useScripts(scope, ownerId);
  const create = useCreateScript();
  const update = useUpdateScript();
  const remove = useDeleteScript();
  const reorder = useReorderScripts();
  const setOwnerEnabled = useSetScriptOwnerEnabled();

  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ScriptRow | null>(null);
  const [imported, setImported] = useState<ScriptRow[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const list = useMemo(() => scripts.data ?? [], [scripts.data]);
  const usable = scope === 'global' || ownerId !== null;
  const anyEnabled = list.some((script) => script.enabled);

  const commitOrder = (next: ScriptRow[]) => reorder.mutate(next.map((script) => script.id));

  const handleFiles = async (files: FileList | null) => {
    const picked = Array.from(files ?? []);
    if (fileRef.current) fileRef.current.value = '';
    if (picked.length === 0) return;
    setImporting(true);
    setImportErrors([]);
    const rows: ScriptRow[] = [];
    const errors: string[] = [];
    for (const file of picked) {
      const form = new FormData();
      form.append('file', file);
      form.append('scope', scope);
      if (ownerId) form.append('ownerId', ownerId);
      try {
        const result = await mutate<{ count: number; scripts: ScriptRow[] }>(
          SCRIPTS_IMPORT_URL,
          'POST',
          form,
        );
        rows.push(...result.scripts);
      } catch (error) {
        errors.push(`${file.name}: ${errorMessage(error) ?? ''}`);
      }
    }
    setImporting(false);
    setImportErrors(errors);
    // 导入默认关闭：跑陌生代码之前问一句（与自带正则同一交互）
    setImported(rows);
    void scripts.refetch();
  };

  const save = (draft: ScriptDraft) => {
    if (!editing) return;
    const done = { onSuccess: () => setEditing(null) };
    if (editing.kind === 'new') {
      create.mutate({ scope, ownerId, ...draft }, done);
    } else {
      update.mutate({ id: editing.script.id, ...draft }, done);
    }
  };

  const saving = create.isPending || update.isPending;
  const saveError = errorMessage(create.error ?? update.error);

  return (
    <SettingsSection
      title={title}
      hint={hint}
      actions={
        <>
          {scope === 'preset' && ownerId && list.length > 0 && (
            <Switch
              checked={anyEnabled}
              label={t('scripts.toggleAll')}
              disabled={setOwnerEnabled.isPending}
              onChange={(checked) =>
                setOwnerEnabled.mutate({ scope: 'preset', ownerId, enabled: checked })
              }
            />
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            multiple
            className="hidden"
            onChange={(event) => void handleFiles(event.target.files)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={!usable || importing}
            aria-busy={importing}
            onClick={() => fileRef.current?.click()}
          >
            {importing ? t('common.importing') : t('scripts.import')}
          </Button>
          <Button
            size="sm"
            disabled={!usable}
            onClick={() => {
              create.reset();
              setEditing({ kind: 'new' });
            }}
          >
            <Plus className="size-3.5" aria-hidden />
            {t('scripts.new')}
          </Button>
        </>
      }
    >
      {picker && <div className="flex items-center gap-2">{picker}</div>}

      {importErrors.length > 0 && (
        <ul role="alert" className="space-y-0.5 text-xs text-danger">
          {importErrors.map((message) => (
            <li key={message} className="break-words">
              {message}
            </li>
          ))}
        </ul>
      )}

      {scripts.error && (
        <p role="alert" className="text-xs text-danger">
          {errorMessage(scripts.error)}
        </p>
      )}

      {usable && scripts.data && list.length === 0 && (
        <p className="py-3 text-sm text-ink-2">
          {scope === 'global' ? t('scripts.emptyGlobal') : t('scripts.emptyPreset')}
        </p>
      )}

      {list.length > 0 && (
        <ul data-part="script-list" data-scope={scope} className="edge-rule border-t">
          {list.map((script, index) => (
            <li
              key={script.id}
              data-part="script-row"
              data-enabled={script.enabled}
              draggable
              onDragStart={(event) => {
                setDragFrom(index);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', script.id);
              }}
              onDragOver={(event) => {
                if (dragFrom === null) return;
                event.preventDefault();
                setDragOver(index);
              }}
              onDragLeave={() => setDragOver((current) => (current === index ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                if (dragFrom !== null && dragFrom !== index)
                  commitOrder(moveItem(list, dragFrom, index));
                setDragFrom(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              className={cn(
                'edge-rule flex items-center gap-2 border-b py-2.5',
                !script.enabled && 'opacity-60',
                dragFrom === index && 'opacity-40',
                dragOver === index && dragFrom !== index && 'edge-rule-strong border-t',
              )}
            >
              <GripVertical
                aria-hidden
                className="hidden size-4 shrink-0 cursor-grab text-ink-3 md:block"
              />
              <div className="flex flex-col md:hidden">
                <IconButton
                  label={t('scripts.moveUp')}
                  size="xs"
                  disabled={index === 0 || reorder.isPending}
                  onClick={() => commitOrder(moveItem(list, index, index - 1))}
                >
                  <ChevronUp aria-hidden />
                </IconButton>
                <IconButton
                  label={t('scripts.moveDown')}
                  size="xs"
                  disabled={index === list.length - 1 || reorder.isPending}
                  onClick={() => commitOrder(moveItem(list, index, index + 1))}
                >
                  <ChevronDown aria-hidden />
                </IconButton>
              </div>

              <button
                type="button"
                className="focus-ring-inset min-w-0 flex-1 cursor-pointer text-left"
                onClick={() => {
                  update.reset();
                  setEditing({ kind: 'edit', script });
                }}
              >
                <div className="truncate text-sm font-medium">
                  {script.name || t('scripts.untitled')}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {script.folder && <Badge variant="muted">{script.folder}</Badge>}
                  {script.buttonsEnabled && script.buttons.length > 0 && (
                    <Badge variant="outline">
                      {t('scripts.buttonCount', { count: script.buttons.length })}
                    </Badge>
                  )}
                  {script.info && (
                    <span className="min-w-0 truncate text-xs text-ink-3">
                      {script.info.split('\n')[0]}
                    </span>
                  )}
                </div>
              </button>

              <Switch
                checked={script.enabled}
                label={t('scripts.toggle')}
                disabled={update.isPending}
                onChange={(checked) => update.mutate({ id: script.id, enabled: checked })}
              />
              <IconButton
                label={t('scripts.edit')}
                size="sm"
                className="hidden sm:inline-flex"
                onClick={() => {
                  update.reset();
                  setEditing({ kind: 'edit', script });
                }}
              >
                <Pencil aria-hidden />
              </IconButton>
              <a
                href={scriptExportUrl(script.id)}
                download
                aria-label={t('scripts.export')}
                title={t('scripts.export')}
                className="action-ghost focus-ring inline-flex size-7 shrink-0 items-center justify-center [&_svg]:size-4"
              >
                <Download aria-hidden />
              </a>
              <IconButton
                label={t('common.delete')}
                size="sm"
                variant="destructive"
                onClick={() => {
                  remove.reset();
                  setPendingDelete(script);
                }}
              >
                <Trash2 aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <ScriptEditor
        open={editing !== null}
        initial={editing?.kind === 'edit' ? draftOf(editing.script) : EMPTY_SCRIPT_DRAFT}
        title={
          editing?.kind === 'edit' ? t('scripts.editor.editTitle') : t('scripts.editor.newTitle')
        }
        saving={saving}
        error={saveError}
        onSave={save}
        onClose={() => setEditing(null)}
      />

      <ConfirmDialog
        open={imported.length > 0}
        title={t('scripts.importAskTitle')}
        description={t('scripts.importAskBody', { count: imported.length })}
        confirmLabel={t('scripts.enableNow')}
        cancelLabel={t('scripts.later')}
        pending={update.isPending}
        onCancel={() => setImported([])}
        onConfirm={() => {
          const targets = imported;
          setImported([]);
          for (const script of targets) update.mutate({ id: script.id, enabled: true });
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title={t('scripts.deleteTitle')}
        description={t('scripts.deleteMessage', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        pending={remove.isPending}
        error={errorMessage(remove.error)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() =>
          pendingDelete &&
          remove.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) })
        }
      />
    </SettingsSection>
  );
}
