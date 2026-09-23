import { Plus, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cleanButtons, type ScriptButton } from './api';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui/button';
import { FieldLabel, Input, Textarea } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import { Switch } from '../../components/ui/switch';

/** CodeMirror 只在打开编辑器时才下载（不进主包） */
const CodeEditor = lazy(() => import('./CodeEditor'));

/** 编辑器里的一份脚本草稿（与存哪无关：全局 / 预设 / 角色卡脚本都用它） */
export interface ScriptDraft {
  name: string;
  content: string;
  /** 作者说明（酒馆助手 `info`） */
  info: string;
  buttons: ScriptButton[];
  /** 酒馆助手 `button.enabled` */
  buttonsEnabled: boolean;
}

export const EMPTY_SCRIPT_DRAFT: ScriptDraft = {
  name: '',
  content: '',
  info: '',
  buttons: [],
  buttonsEnabled: true,
};

export interface ScriptEditorProps {
  open: boolean;
  /** 打开时的初始值；`open` 由 false 变 true 时重置表单 */
  initial: ScriptDraft;
  title: string;
  onSave: (draft: ScriptDraft) => void;
  onClose: () => void;
  saving?: boolean;
  error?: string | null;
}

/**
 * 脚本编辑器（M5（三）§2.3）：名称、代码（CodeMirror：JS 高亮、行号、Ctrl+F 搜索、Tab 缩进）、
 * 按钮列表（名称 + 是否显示）、作者说明。只管表单，不管存哪——保存交给调用方，
 * 所以工作台编辑角色卡自带的脚本也能直接复用。
 */
export function ScriptEditor({
  open,
  initial,
  title,
  onSave,
  onClose,
  saving,
  error,
}: ScriptEditorProps) {
  const { t } = useTranslation();
  const id = useId();
  const [draft, setDraft] = useState<ScriptDraft>(initial);

  // 每次打开都从 initial 重新开始（关掉再开不应该留着上次没保存的改动）
  useEffect(() => {
    if (open) setDraft(initial);
    // initial 往往是每次渲染新建的对象，只在打开那一刻取一次
  }, [open]);

  const set = <K extends keyof ScriptDraft>(key: K, value: ScriptDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const setButton = (index: number, patch: Partial<ScriptButton>) =>
    set(
      'buttons',
      draft.buttons.map((button, i) => (i === index ? { ...button, ...patch } : button)),
    );

  const nameMissing = draft.name.trim() === '';
  const save = () => {
    if (nameMissing) return;
    onSave({ ...draft, name: draft.name.trim(), buttons: cleanButtons(draft.buttons) });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="xl"
      dismissible={!saving}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {error && (
            <p role="alert" className="me-auto min-w-0 text-xs break-words text-danger">
              {error}
            </p>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" onClick={save} disabled={saving || nameMissing}>
            {saving ? t('scripts.editor.saving') : t('common.save')}
          </Button>
        </div>
      }
    >
      <div data-part="script-editor" className="flex flex-col gap-4">
        <div>
          <FieldLabel htmlFor={`${id}-name`}>{t('scripts.editor.name')}</FieldLabel>
          <Input
            id={`${id}-name`}
            value={draft.name}
            aria-invalid={nameMissing}
            onChange={(event) => set('name', event.target.value)}
          />
        </div>

        <div>
          <FieldLabel>{t('scripts.editor.content')}</FieldLabel>
          <div className="field h-[46dvh] min-h-60 overflow-hidden p-0 md:h-[52dvh]">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs text-ink-3">
                  {t('scripts.editor.loading')}
                </div>
              }
            >
              <CodeEditor
                value={draft.content}
                onChange={(value) => set('content', value)}
                label={t('scripts.editor.content')}
                placeholder={t('scripts.editor.contentPlaceholder')}
                className="h-full"
              />
            </Suspense>
          </div>
          <p className="mt-1 text-[11px] text-ink-3">{t('scripts.editor.keys')}</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div data-part="script-buttons-editor">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <FieldLabel>{t('scripts.editor.buttons')}</FieldLabel>
              <label className="flex items-center gap-2 text-xs text-ink-2">
                {t('scripts.editor.buttonsEnabled')}
                <Switch
                  checked={draft.buttonsEnabled}
                  label={t('scripts.editor.buttonsEnabled')}
                  onChange={(checked) => set('buttonsEnabled', checked)}
                />
              </label>
            </div>
            <ul className="edge-rule border-t">
              {draft.buttons.map((button, index) => (
                <li key={index} className="edge-rule flex items-center gap-2 border-b py-1.5">
                  <Input
                    size="sm"
                    value={button.name}
                    aria-label={t('scripts.editor.buttonName')}
                    placeholder={t('scripts.editor.buttonName')}
                    onChange={(event) => setButton(index, { name: event.target.value })}
                  />
                  <Switch
                    checked={button.visible}
                    label={t('scripts.editor.buttonVisible')}
                    onChange={(checked) => setButton(index, { visible: checked })}
                  />
                  <IconButton
                    label={t('scripts.editor.removeButton')}
                    size="sm"
                    variant="destructive"
                    onClick={() =>
                      set(
                        'buttons',
                        draft.buttons.filter((_, i) => i !== index),
                      )
                    }
                  >
                    <X aria-hidden />
                  </IconButton>
                </li>
              ))}
            </ul>
            <Button
              variant="ghost"
              size="sm"
              className="mt-1.5"
              onClick={() => set('buttons', [...draft.buttons, { name: '', visible: true }])}
            >
              <Plus className="size-3.5" aria-hidden />
              {t('scripts.editor.addButton')}
            </Button>
          </div>

          <div>
            <FieldLabel htmlFor={`${id}-info`}>{t('scripts.editor.info')}</FieldLabel>
            <Textarea
              id={`${id}-info`}
              rows={6}
              value={draft.info}
              placeholder={t('scripts.editor.infoPlaceholder')}
              onChange={(event) => set('info', event.target.value)}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
