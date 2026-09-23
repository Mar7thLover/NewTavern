import { useTranslation } from 'react-i18next';

import { Input, Select } from '../../components/ui/field';
import { Segmented } from '../../components/ui/segmented';
import { useConnectionModels, useConnections } from '../../lib/api';
import { useMvuSettings, useSetMvuSettings, type MvuSettings } from '../../lib/api-cards';

/**
 * 设置 → 前端卡 → 变量框架里的两项 MVU 补全（M5（三）§3.5）：
 *
 * - **额外模型解析**：选一个连接 + 模型；「缺了才用」= 本轮正文里没有更新命令时才请求，
 *   「总是用」= 每轮都交给它；不选连接 = 关闭；
 * - **旧快照清理**：只保留最近 N 层的完整变量快照（0 = 不清理）。
 */
export function MvuExtraSettings() {
  const { t } = useTranslation();
  const mvu = useMvuSettings();
  const save = useSetMvuSettings();
  const connections = useConnections();
  const current: MvuSettings = mvu.data ?? { enabled: true, keepSnapshots: 0 };
  const extra = current.extraModel;
  const models = useConnectionModels(extra?.connectionId ?? null);

  const patch = (next: Partial<MvuSettings>) => {
    const merged: MvuSettings = { ...current, ...next };
    if (next.extraModel === undefined && 'extraModel' in next) delete merged.extraModel;
    save.mutate(merged);
  };

  return (
    <div data-part="mvu-extra" className="space-y-3 py-2">
      <div className="space-y-1.5">
        <div className="text-sm">{t('cards.mvuExtra.title')}</div>
        <p className="text-xs leading-relaxed text-ink-2">{t('cards.mvuExtra.hint')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Select
            size="sm"
            aria-label={t('cards.mvuExtra.connection')}
            value={extra?.connectionId ?? ''}
            onChange={(event) => {
              const connectionId = event.target.value;
              if (connectionId === '') patch({ extraModel: undefined });
              else
                patch({
                  extraModel: {
                    connectionId,
                    model: extra?.connectionId === connectionId ? extra.model : '',
                    when: extra?.when ?? 'missing',
                  },
                });
            }}
          >
            <option value="">{t('cards.mvuExtra.off')}</option>
            {(connections.data ?? []).map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label}
              </option>
            ))}
          </Select>
          {extra && (
            <Input
              size="sm"
              list="nt-mvu-extra-models"
              aria-label={t('cards.mvuExtra.model')}
              placeholder={t('cards.mvuExtra.model')}
              defaultValue={extra.model}
              onBlur={(event) => {
                const model = event.target.value.trim();
                if (model !== extra.model) patch({ extraModel: { ...extra, model } });
              }}
            />
          )}
          <datalist id="nt-mvu-extra-models">
            {(models.data?.models ?? []).map((model) => (
              <option key={model.id} value={model.id} />
            ))}
          </datalist>
        </div>
        {extra && (
          <Segmented
            size="sm"
            label={t('cards.mvuExtra.when')}
            value={extra.when}
            onChange={(when) => patch({ extraModel: { ...extra, when } })}
            items={[
              { value: 'missing', label: t('cards.mvuExtra.whenMissing') },
              { value: 'always', label: t('cards.mvuExtra.whenAlways') },
            ]}
          />
        )}
        {extra && extra.model === '' && (
          <p className="text-xs text-warning">{t('cards.mvuExtra.needModel')}</p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm">{t('cards.mvuExtra.keepTitle')}</div>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{t('cards.mvuExtra.keepHint')}</p>
        </div>
        <Input
          size="sm"
          type="number"
          min={0}
          step={1}
          className="w-24"
          aria-label={t('cards.mvuExtra.keepTitle')}
          defaultValue={current.keepSnapshots}
          key={current.keepSnapshots}
          onBlur={(event) => {
            const value = Math.max(0, Math.floor(Number(event.target.value) || 0));
            if (value !== current.keepSnapshots) patch({ keepSnapshots: value });
          }}
        />
      </div>
    </div>
  );
}
