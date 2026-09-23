import { TRUST_LEVELS, type FrontendCardTrustLevel } from '@newtavern/sandbox-sdk';
import { useTranslation } from 'react-i18next';

import { SettingsSection } from './shared';
import { useUiStore } from '../../app/store/ui';
import { Segmented } from '../../components/ui/segmented';
import { SwitchRow } from '../../components/ui/switch';
import { useCharacters, useSetSetting, useSetting } from '../../lib/api';
import {
  DEFAULT_CARD_SETTINGS,
  useCardSettings,
  useMvuSettings,
  useSetCardSettings,
  useSetMvuSettings,
  type CardSettings,
} from '../../lib/api-cards';
import { MvuExtraSettings } from '../cards/MvuExtraSettings';
import { Avatar } from '../library/shared';

/**
 * 设置 → 前端卡。见 docs/M5-CONTRACT.md §6。
 *
 * 分三层：
 * - **跑不跑**（`cardRuntime`，存本机）：关掉 = 带脚本的卡退回代码块；
 * - **给多少权限**（信任级别，存服务端，可按角色卡单独调）；
 * - **变量框架**（MVU 自动解析开关、EJS 提示词模板开关，存服务端）。
 *
 * 信任级别是安全边界，写得比一般设置详细：用户改它之前要知道自己在放开什么。
 */

/** 设置 KV `ejs`：EJS 提示词模板开关（服务端组装时读，缺省开；M5（三）契约 §4.2） */
const normalizeEjsSettings = (value: unknown): { enabled: boolean } => {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return { enabled: typeof source.enabled === 'boolean' ? source.enabled : true };
};

const TRUST_ICON: Record<FrontendCardTrustLevel, string> = {
  strict: '🔒',
  standard: '🛡️',
  trusted: '🌐',
  'legacy-unsafe': '⚠️',
};

export function CardsSettings() {
  const { t } = useTranslation();
  const cardRuntime = useUiStore((state) => state.cardRuntime);
  const setCardRuntime = useUiStore((state) => state.setCardRuntime);
  const settings = useCardSettings();
  const saveSettings = useSetCardSettings();
  const mvu = useMvuSettings();
  const saveMvu = useSetMvuSettings();
  const ejs = useSetting('ejs', normalizeEjsSettings);
  const saveEjs = useSetSetting('ejs', normalizeEjsSettings);
  const characters = useCharacters();

  const current: CardSettings = settings.data ?? DEFAULT_CARD_SETTINGS;
  const patch = (next: Partial<CardSettings>) => saveSettings.mutate({ ...current, ...next });

  const trustItems = TRUST_LEVELS.map((level) => ({
    value: level,
    label: `${TRUST_ICON[level]} ${t(`cards.trust.${level}`)}`,
  }));

  /** 只列出被改过信任级别的角色卡：默认档不必占一行 */
  const overridden = Object.keys(current.trustByCharacter);

  return (
    <div className="space-y-8">
      <SettingsSection title={t('cards.runtime')} hint={t('cards.runtimeHint')}>
        <div className="divide-y divide-edge">
          <SwitchRow
            title={t('cards.runtimeSwitch')}
            hint={t('cards.runtimeSwitchHint')}
            checked={cardRuntime}
            onChange={setCardRuntime}
          />
          <SwitchRow
            title={t('cards.externalLibs')}
            hint={t('cards.externalLibsHint')}
            checked={current.externalLibs}
            onChange={(value) => patch({ externalLibs: value })}
          />
          <SwitchRow
            title={t('cards.scripts')}
            hint={t('cards.scriptsHint')}
            checked={current.scripts}
            onChange={(value) => patch({ scripts: value })}
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('cards.trustTitle')} hint={t('cards.trustHint')}>
        <Segmented
          items={trustItems}
          value={current.defaultTrust}
          label={t('cards.trustTitle')}
          onChange={(value) => patch({ defaultTrust: value })}
        />
        <p className="text-xs leading-relaxed text-ink-2">
          {t(`cards.trustDetail.${current.defaultTrust}`)}
        </p>
        {current.defaultTrust === 'legacy-unsafe' && (
          <p role="alert" className="text-xs leading-relaxed text-danger">
            {t('cards.legacyWarning')}
          </p>
        )}

        {overridden.length > 0 && (
          <div className="rounded-card edge-rule divide-y divide-edge border">
            {overridden.map((characterId) => {
              const character = characters.data?.find((item) => item.id === characterId);
              return (
                <div key={characterId} className="flex items-center gap-3 px-3 py-2">
                  <Avatar
                    name={character?.name ?? characterId}
                    assetId={character?.avatarAssetId ?? null}
                    role="character"
                    className="size-7"
                    textClassName="text-[11px]"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {character?.name ?? t('cards.unknownCharacter')}
                  </span>
                  <Segmented
                    size="sm"
                    items={trustItems}
                    value={current.trustByCharacter[characterId] ?? current.defaultTrust}
                    onChange={(value) =>
                      patch({
                        trustByCharacter: { ...current.trustByCharacter, [characterId]: value },
                      })
                    }
                  />
                  <button
                    type="button"
                    className="cursor-pointer text-xs text-ink-3 hover:text-ink"
                    onClick={() => {
                      const next = { ...current.trustByCharacter };
                      delete next[characterId];
                      patch({ trustByCharacter: next });
                    }}
                  >
                    {t('cards.resetTrust')}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t('cards.mvuTitle')} hint={t('cards.mvuHint')}>
        <div className="divide-y divide-edge">
          <SwitchRow
            title={t('cards.mvuSwitch')}
            hint={t('cards.mvuSwitchHint')}
            checked={mvu.data?.enabled !== false}
            onChange={(value) =>
              saveMvu.mutate({ ...(mvu.data ?? { keepSnapshots: 0 }), enabled: value })
            }
          />
          {/* 额外模型解析与旧快照清理（M5（三）§3.5） */}
          <MvuExtraSettings />
          <SwitchRow
            title={t('cards.ejsSwitch')}
            hint={t('cards.ejsSwitchHint')}
            checked={ejs.data?.enabled !== false}
            onChange={(value) => saveEjs.mutate({ enabled: value })}
          />
        </div>
      </SettingsSection>
    </div>
  );
}
