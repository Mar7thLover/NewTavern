import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  DEFAULT_EXPRESSIONS,
  normalizeSpriteLabel,
  useSetSpriteSettings,
  useSpriteSettings,
  type SpriteMode,
  type SpriteSettings as SpriteSettingsValue,
} from './api';
import { FieldLabel, Input, Select } from '../../components/ui/field';
import { Segmented } from '../../components/ui/segmented';
import { useConnections } from '../../lib/api';

const MODES: SpriteMode[] = ['classify', 'manual', 'off'];

/**
 * 设置 → 外观 →「立绘」：表情怎么选（M4（二）§B.2）。
 * 分类用的连接缺省 = 会话当前连接；fallback 是分类失败 / 没有对应立绘时用的标签。
 */
export function SpriteSettings() {
  const { t } = useTranslation();
  const settings = useSpriteSettings();
  const save = useSetSpriteSettings();
  const connections = useConnections();
  const value: SpriteSettingsValue = settings.data ?? { mode: 'classify', fallback: 'neutral' };
  const [model, setModel] = useState(value.model ?? '');
  const [fallback, setFallback] = useState(value.fallback);
  useEffect(() => setModel(value.model ?? ''), [value.model]);
  useEffect(() => setFallback(value.fallback), [value.fallback]);

  const patch = (partial: Partial<SpriteSettingsValue>) => {
    const next: SpriteSettingsValue = { ...value, ...partial };
    if (!next.connectionId) delete next.connectionId;
    if (!next.model) delete next.model;
    save.mutate(next);
  };

  return (
    <div data-part="sprite-settings" className="space-y-3">
      <Segmented
        value={value.mode}
        onChange={(mode) => patch({ mode })}
        items={MODES.map((mode) => ({ value: mode, label: t(`sprites.modes.${mode}`) }))}
      />
      <p className="text-xs leading-relaxed text-ink-2">{t(`sprites.modeHints.${value.mode}`)}</p>
      {value.mode === 'classify' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <FieldLabel>{t('sprites.connection')}</FieldLabel>
            <Select
              size="sm"
              value={value.connectionId ?? ''}
              onChange={(event) => patch({ connectionId: event.target.value || undefined })}
            >
              <option value="">{t('sprites.connectionFollow')}</option>
              {(connections.data ?? []).map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <FieldLabel>{t('sprites.model')}</FieldLabel>
            <Input
              size="sm"
              value={model}
              placeholder={t('sprites.modelFollow')}
              onChange={(event) => setModel(event.target.value)}
              onBlur={() => model.trim() !== (value.model ?? '') && patch({ model: model.trim() || undefined })}
            />
          </div>
        </div>
      )}
      {value.mode !== 'off' && (
        <div className="max-w-xs">
          <FieldLabel>{t('sprites.fallback')}</FieldLabel>
          <Input
            size="sm"
            list="nt-sprite-fallbacks"
            value={fallback}
            aria-invalid={normalizeSpriteLabel(fallback) === null}
            onChange={(event) => setFallback(event.target.value)}
            onBlur={() => {
              const next = normalizeSpriteLabel(fallback);
              if (next && next !== value.fallback) patch({ fallback: next });
              else setFallback(value.fallback);
            }}
          />
          <datalist id="nt-sprite-fallbacks">
            {DEFAULT_EXPRESSIONS.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
        </div>
      )}
    </div>
  );
}
