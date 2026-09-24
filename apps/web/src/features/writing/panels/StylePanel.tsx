import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../components/ui/button';
import { FieldLabel, Input, Select, Textarea } from '../../../components/ui/field';
import type { WritingProjectDetail } from '../../../lib/api-writing';

/**
 * 右栏「风格」页签（M7 §5.2）：风格指南、项目系统提示词，以及写作语言、布局、上下文预算。
 * 改完点保存（这几项都是整段文字，不做逐字自动保存）。
 */
export function StylePanel({
  project,
  saving,
  onSave,
}: {
  project: WritingProjectDetail;
  saving: boolean;
  onSave: (patch: Record<string, unknown>) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const settings = project.settings;
  const initial = {
    styleGuide: settings.styleGuide,
    systemPrompt: settings.systemPrompt ?? '',
    language: settings.language ?? 'zh-CN',
    layoutMode: settings.layoutMode,
    contextBudget: settings.contextBudget ? String(settings.contextBudget) : '',
  };
  const [draft, setDraft] = useState(initial);
  const [saved, setSaved] = useState(false);
  const key = JSON.stringify(initial);
  // 服务端的值变了（别处改过）就跟上
  useEffect(() => setDraft(JSON.parse(key) as typeof initial), [key]);

  const dirty = JSON.stringify(draft) !== key;

  const save = async () => {
    const budget = Number.parseInt(draft.contextBudget, 10);
    await onSave({
      styleGuide: draft.styleGuide,
      systemPrompt: draft.systemPrompt.trim() === '' ? null : draft.systemPrompt,
      language: draft.language,
      layoutMode: draft.layoutMode,
      contextBudget: Number.isFinite(budget) && budget > 0 ? budget : null,
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div data-part="writing-style-panel" className="flex flex-col gap-5 p-4">
      <section>
        <FieldLabel htmlFor={`${id}-guide`}>{t('writing.style.guide')}</FieldLabel>
        <Textarea
          id={`${id}-guide`}
          rows={8}
          value={draft.styleGuide}
          placeholder={t('writing.style.guidePlaceholder')}
          onChange={(event) => setDraft({ ...draft, styleGuide: event.target.value })}
        />
      </section>
      <section>
        <FieldLabel htmlFor={`${id}-system`}>{t('writing.style.systemPrompt')}</FieldLabel>
        <Textarea
          id={`${id}-system`}
          rows={5}
          value={draft.systemPrompt}
          placeholder={t('writing.style.systemPromptPlaceholder')}
          onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
        />
        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
          {t('writing.style.systemPromptHint')}
        </p>
      </section>
      <section className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor={`${id}-lang`}>{t('writing.style.language')}</FieldLabel>
          <Select
            id={`${id}-lang`}
            size="sm"
            value={draft.language}
            onChange={(event) =>
              setDraft({ ...draft, language: event.target.value as 'zh-CN' | 'en' })
            }
          >
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </Select>
        </div>
        <div>
          <FieldLabel htmlFor={`${id}-layout`}>{t('writing.style.layoutMode')}</FieldLabel>
          <Select
            id={`${id}-layout`}
            size="sm"
            value={draft.layoutMode}
            onChange={(event) =>
              setDraft({ ...draft, layoutMode: event.target.value as 'cache-aware' | 'strict' })
            }
          >
            <option value="cache-aware">{t('writing.style.cacheAware')}</option>
            <option value="strict">{t('writing.style.strict')}</option>
          </Select>
        </div>
        <div className="col-span-2">
          <FieldLabel htmlFor={`${id}-budget`}>{t('writing.style.budget')}</FieldLabel>
          <Input
            id={`${id}-budget`}
            size="sm"
            inputMode="numeric"
            value={draft.contextBudget}
            placeholder={t('writing.style.budgetPlaceholder')}
            onChange={(event) =>
              setDraft({ ...draft, contextBudget: event.target.value.replace(/[^\d]/g, '') })
            }
          />
        </div>
      </section>
      <div className="flex items-center justify-end gap-3">
        {saved && !dirty && <span className="text-xs text-ink-3">{t('writing.style.saved')}</span>}
        <Button size="sm" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? t('common.processing') : t('common.save')}
        </Button>
      </div>
    </div>
  );
}
