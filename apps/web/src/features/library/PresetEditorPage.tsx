import { ArrowLeft } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useBeforeUnload, useBlocker, useParams } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  useBuiltinPresetId,
  usePreset,
  useResetBuiltinPreset,
  type PresetDetail,
} from '../../lib/api';
import {
  PresetEditor,
  isPresetDraftDirty,
  presetToDraft,
  useSavePresetDraft,
  type PresetDraft,
} from './preset-editor';
import { QueryStatus, errorMessage } from './shared';

/*
 * 预设编辑页（`/presets/:id`）：薄壳。
 * 编辑器本体是受控的 `PresetEditor`（`./preset-editor`，工作台与写作页也用它）；
 * 这里只管取数、草稿与基线、保存、离开拦截，以及内置预设的「恢复内置内容」。
 */

export function PresetEditorPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const preset = usePreset(id);

  return (
    <div className="mx-auto max-w-4xl">
      <Link
        to="/presets"
        className="focus-ring rounded-control mb-3 inline-flex items-center gap-1 text-xs text-ink-2 hover:text-ink"
      >
        <ArrowLeft aria-hidden className="size-3.5" />
        {t('presets.back')}
      </Link>
      <QueryStatus
        isPending={preset.isPending}
        error={preset.error}
        onRetry={() => void preset.refetch()}
      />
      {/* key：换了预设就整体重建草稿 */}
      {preset.data && <PresetEditorShell key={preset.data.id} preset={preset.data} />}
    </div>
  );
}

function PresetEditorShell({ preset }: { preset: PresetDetail }) {
  const { t } = useTranslation();
  const save = useSavePresetDraft(preset.id);
  const builtinPresetId = useBuiltinPresetId();
  const resetBuiltin = useResetBuiltinPreset(preset.id);
  const isBuiltin = builtinPresetId.data === preset.id;
  const [confirmReset, setConfirmReset] = useState(false);

  const [baseline, setBaseline] = useState<PresetDraft>(() => presetToDraft(preset));
  const [draft, setDraft] = useState<PresetDraft>(baseline);
  /** 恢复内置内容后递增：编辑器整体重建（收起所有展开的条目） */
  const [epoch, setEpoch] = useState(0);

  const dirty = useMemo(() => isPresetDraftDirty(baseline, draft), [baseline, draft]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useBeforeUnload(
    useCallback(
      (event: BeforeUnloadEvent) => {
        if (dirty) event.preventDefault();
      },
      [dirty],
    ),
  );

  const adopt = (row: PresetDetail) => {
    const next = presetToDraft(row);
    setBaseline(next);
    setDraft(next);
  };

  const onChange = (next: PresetDraft) => {
    setDraft(next);
    // 放弃修改（回到基线）时一并清掉上次的保存结果
    if (next === baseline) save.reset();
  };

  const onSave = () => {
    save.mutate(
      { draft, baseline },
      {
        onSuccess: (row) => {
          if (row) adopt(row);
        },
      },
    );
  };

  /** 恢复内置内容：服务端返回的新行直接作为基线，本地草稿（含未保存的名称）一并丢弃 */
  const restoreBuiltin = () => {
    resetBuiltin.mutate(undefined, {
      onSuccess: (row) => {
        adopt(row);
        setEpoch((value) => value + 1);
        save.reset();
        setConfirmReset(false);
      },
    });
  };

  return (
    <>
      <PresetEditor
        key={epoch}
        value={draft}
        onChange={onChange}
        baseline={baseline}
        onSave={onSave}
        saving={save.isPending}
        saveError={save.error}
        saved={save.isSuccess}
        badges={isBuiltin && <Badge variant="muted">{t('presets.builtinBadge')}</Badge>}
        basicActions={
          isBuiltin ? (
            <Button
              variant="outline"
              size="sm"
              disabled={resetBuiltin.isPending}
              onClick={() => {
                resetBuiltin.reset();
                setConfirmReset(true);
              }}
            >
              {t('presets.resetBuiltin')}
            </Button>
          ) : undefined
        }
      />

      <ConfirmDialog
        open={confirmReset}
        destructive
        title={t('presets.resetBuiltinTitle')}
        description={t('presets.resetBuiltinMessage')}
        confirmLabel={t('presets.resetBuiltinConfirm')}
        pending={resetBuiltin.isPending}
        error={errorMessage(resetBuiltin.error)}
        onCancel={() => setConfirmReset(false)}
        onConfirm={restoreBuiltin}
      />

      <ConfirmDialog
        open={blocker.state === 'blocked'}
        destructive
        title={t('presets.leaveTitle')}
        description={t('presets.leaveMessage')}
        confirmLabel={t('presets.leave')}
        onCancel={() => blocker.reset?.()}
        onConfirm={() => blocker.proceed?.()}
      />
    </>
  );
}
