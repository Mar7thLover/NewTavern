import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SettingsSection } from './shared';
import { Button } from '../../components/ui/button';
import { FieldLabel, Input } from '../../components/ui/field';
import { SwitchRow } from '../../components/ui/switch';
import {
  DEFAULT_WORLD_INFO_SETTINGS,
  useGlobalBookIds,
  useSetGlobalBookIds,
  useSetWorldInfoSettings,
  useWorldInfoSettings,
  type WorldInfoSettings as WorldInfoSettingsValue,
} from '../../lib/api';
import { LorebookPicker } from '../library/LorebookPicker';

type NumberKey =
  | 'scanDepth'
  | 'budgetPercent'
  | 'budgetCap'
  | 'maxRecursionSteps'
  | 'minActivations'
  | 'minActivationsDepthMax';

type BooleanKey =
  'recursive' | 'caseSensitive' | 'matchWholeWords' | 'useGroupScoring' | 'includeNames';

const NUMBER_FIELDS: { key: NumberKey; hint?: boolean }[] = [
  { key: 'scanDepth', hint: true },
  { key: 'budgetPercent', hint: true },
  { key: 'budgetCap', hint: true },
  { key: 'maxRecursionSteps', hint: true },
  { key: 'minActivations', hint: true },
  { key: 'minActivationsDepthMax', hint: true },
];

const BOOLEAN_FIELDS: { key: BooleanKey; hint?: boolean }[] = [
  { key: 'recursive', hint: true },
  { key: 'caseSensitive' },
  { key: 'matchWholeWords' },
  { key: 'useGroupScoring' },
  { key: 'includeNames' },
];

/** 设置页「世界书」分区：全局书选择 + WISettings 表单（默认值照 ST 1.18） */
export function WorldInfoSettings() {
  const { t } = useTranslation();
  const globalBooks = useGlobalBookIds();
  const setGlobalBooks = useSetGlobalBookIds();
  const settings = useWorldInfoSettings();
  const saveSettings = useSetWorldInfoSettings();

  const [draft, setDraft] = useState<WorldInfoSettingsValue>(DEFAULT_WORLD_INFO_SETTINGS);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);

  const commit = (next: WorldInfoSettingsValue) => {
    setDraft(next);
    saveSettings.mutate(next);
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={t('worldInfo.globalBooks')} hint={t('worldInfo.globalBooksHint')}>
        <LorebookPicker
          selected={globalBooks.data ?? []}
          disabled={setGlobalBooks.isPending}
          onChange={(bookIds) => setGlobalBooks.mutate(bookIds)}
        />
        <p className="text-xs text-muted-foreground">
          {(globalBooks.data ?? []).length > 0
            ? t('worldInfo.selected', { total: (globalBooks.data ?? []).length })
            : t('worldInfo.selectNone')}
        </p>
      </SettingsSection>

      <SettingsSection
        title={t('worldInfo.settings')}
        hint={t('worldInfo.settingsHint')}
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => commit(DEFAULT_WORLD_INFO_SETTINGS)}
            disabled={saveSettings.isPending}
          >
            {t('common.reset')}
          </Button>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {NUMBER_FIELDS.map(({ key, hint }) => (
            <div key={key}>
              <FieldLabel htmlFor={`wi-${key}`}>{t(`worldInfo.fields.${key}`)}</FieldLabel>
              <Input
                id={`wi-${key}`}
                type="number"
                min={0}
                value={draft[key]}
                onChange={(event) => setDraft({ ...draft, [key]: Number(event.target.value) || 0 })}
                onBlur={() => draft[key] !== settings.data?.[key] && commit(draft)}
              />
              {hint && (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(`worldInfo.fields.${key}Hint`)}
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="divide-y divide-border">
          {BOOLEAN_FIELDS.map(({ key, hint }) => (
            <SwitchRow
              key={key}
              title={t(`worldInfo.fields.${key}`)}
              {...(hint ? { hint: t(`worldInfo.fields.${key}Hint`) } : {})}
              checked={draft[key]}
              onChange={(checked) => commit({ ...draft, [key]: checked })}
            />
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
