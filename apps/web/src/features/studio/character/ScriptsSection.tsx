import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Button } from '../../../components/ui/button';
import { IconButton } from '../../../components/ui/icon-button';
import { Switch } from '../../../components/ui/switch';
import { EMPTY_SCRIPT_DRAFT, ScriptEditor } from '../../scripts/ScriptEditor';
import type { CharacterDraft } from '../types';
import {
  addCardScript,
  deleteCardScript,
  patchCardScript,
  readCardScripts,
  scriptToDraft,
  type CardScript,
} from './scripts';

/**
 * 角色脚本：卡里自带的酒馆助手脚本（写回 `extensions`，保持酒馆助手格式）。
 * 列表 + 启用开关；代码编辑复用脚本库的编辑器（CodeMirror）。改动进草稿，随卡一起保存。
 */
export function ScriptsSection({
  value,
  update,
}: {
  value: CharacterDraft;
  update: (fn: (current: CharacterDraft) => CharacterDraft) => void;
}) {
  const { t } = useTranslation();
  const scripts = useMemo(() => readCardScripts(value), [value]);
  /** 正在编辑：脚本的 pointer；'new' = 新建 */
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CardScript | null>(null);

  const current = editing && editing !== 'new' ? scripts.find((s) => s.pointer === editing) : null;

  return (
    <div className="space-y-2">
      {scripts.length === 0 ? (
        <p className="text-xs text-ink-3">{t('studio.character.scriptsEmpty')}</p>
      ) : (
        <ul className="edge-rule divide-y divide-edge border-y">
          {scripts.map((script) => (
            <li key={script.pointer} className="flex items-center gap-2 py-1.5">
              <Switch
                checked={script.enabled}
                label={t('studio.character.scriptEnabled', { name: script.name })}
                onChange={(enabled) =>
                  update((data) => {
                    const fresh = readCardScripts(data).find((s) => s.pointer === script.pointer);
                    return fresh ? patchCardScript(data, fresh, { enabled }) : data;
                  })
                }
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">
                  {script.name || t('studio.character.scriptUnnamed')}
                </div>
                {script.folder && (
                  <div className="truncate text-[11px] text-ink-3">{script.folder}</div>
                )}
              </div>
              <IconButton label={t('common.edit')} onClick={() => setEditing(script.pointer)}>
                <Pencil aria-hidden />
              </IconButton>
              <IconButton
                label={t('common.delete')}
                variant="destructive"
                onClick={() => setDeleting(script)}
              >
                <Trash2 aria-hidden />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" onClick={() => setEditing('new')}>
        <Plus className="size-3.5" aria-hidden />
        {t('studio.character.scriptAdd')}
      </Button>

      <ScriptEditor
        open={editing !== null}
        initial={current ? scriptToDraft(current) : EMPTY_SCRIPT_DRAFT}
        title={current ? t('studio.character.scriptEdit') : t('studio.character.scriptAdd')}
        onClose={() => setEditing(null)}
        onSave={(draft) => {
          const target = editing;
          update((data) => {
            if (target === 'new') return addCardScript(data, draft);
            const fresh = readCardScripts(data).find((s) => s.pointer === target);
            return fresh ? patchCardScript(data, fresh, draft) : data;
          });
          setEditing(null);
        }}
      />

      <ConfirmDialog
        open={deleting !== null}
        destructive
        title={t('studio.character.scriptDeleteTitle')}
        description={t('studio.character.scriptDeleteMessage', { name: deleting?.name ?? '' })}
        confirmLabel={t('common.delete')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const target = deleting;
          if (target) {
            update((data) => {
              const fresh = readCardScripts(data).find((s) => s.pointer === target.pointer);
              return fresh ? deleteCardScript(data, fresh) : data;
            });
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}
