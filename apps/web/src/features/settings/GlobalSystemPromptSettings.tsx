import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsSection } from './shared';
import { FieldLabel, Select, Textarea } from '../../components/ui/field';
import { Switch } from '../../components/ui/switch';
import {
  DEFAULT_GLOBAL_SYSTEM_PROMPT,
  useGlobalSystemPrompt,
  useSetGlobalSystemPrompt,
  type GlobalSystemPrompt,
  type GlobalSystemPromptPosition,
} from '../../lib/api';

const POSITIONS: GlobalSystemPromptPosition[] = ['before_main', 'after_main'];

/** 设置页「全局系统提示词」分区（契约 §3.4） */
export function GlobalSystemPromptSettings() {
  const { t } = useTranslation();
  const query = useGlobalSystemPrompt();
  const save = useSetGlobalSystemPrompt();
  const [draft, setDraft] = useState<GlobalSystemPrompt>(DEFAULT_GLOBAL_SYSTEM_PROMPT);

  useEffect(() => {
    if (query.data) setDraft(query.data);
  }, [query.data]);

  const commit = (next: GlobalSystemPrompt) => {
    setDraft(next);
    save.mutate(next);
  };

  return (
    <SettingsSection title={t('globalSystemPrompt.title')} hint={t('globalSystemPrompt.hint')}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">{t('globalSystemPrompt.enabled')}</span>
        <Switch
          checked={draft.enabled}
          label={t('globalSystemPrompt.enabled')}
          onChange={(enabled) => commit({ ...draft, enabled })}
        />
      </div>

      <div>
        <FieldLabel htmlFor="gsp-text">{t('globalSystemPrompt.text')}</FieldLabel>
        <Textarea
          id="gsp-text"
          rows={6}
          value={draft.text}
          placeholder={t('globalSystemPrompt.textPlaceholder')}
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          onBlur={() => draft.text !== query.data?.text && commit(draft)}
        />
      </div>

      <div className="max-w-xs">
        <FieldLabel htmlFor="gsp-position">{t('globalSystemPrompt.position')}</FieldLabel>
        <Select
          id="gsp-position"
          value={draft.position}
          onChange={(event) =>
            commit({ ...draft, position: event.target.value as GlobalSystemPromptPosition })
          }
        >
          {POSITIONS.map((position) => (
            <option key={position} value={position}>
              {t(`globalSystemPrompt.positions.${position}`)}
            </option>
          ))}
        </Select>
      </div>
    </SettingsSection>
  );
}
