import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Button } from '../../../components/ui/button';
import { FieldLabel, Input, Select, Textarea } from '../../../components/ui/field';
import { useConnectionModels, useConnections } from '../../../lib/api';
import type { WritingAction, WritingProjectDetail } from '../../../lib/api-writing';
import type { WritingAiController } from '../useWritingAi';

export const AI_ACTIONS: readonly WritingAction[] = [
  'continue',
  'rewrite',
  'expand',
  'condense',
  'summarize',
];

export interface AiPanelProps {
  project: WritingProjectDetail;
  ai: WritingAiController;
  ready: boolean;
  /** 当前打开的是章节 / 笔记（大纲页没有编辑器） */
  hasDocument: boolean;
  isChapter: boolean;
  hasSelection: boolean;
  instruction: string;
  onInstructionChange: (value: string) => void;
  onSettings: (patch: Record<string, unknown>) => void;
}

/**
 * 右栏「AI」页签（M7 §5.2）：动作按钮 + 指令输入 + 连接 / 模型 / 目标长度。
 * 没连模型时照样能看，按钮点了给去连接页的提示。
 */
export function AiPanel({
  project,
  ai,
  ready,
  hasDocument,
  isChapter,
  hasSelection,
  instruction,
  onInstructionChange,
  onSettings,
}: AiPanelProps) {
  const { t } = useTranslation();
  const connections = useConnections();
  const settings = project.settings;
  const connectionId = settings.connectionId ?? '';
  const models = useConnectionModels(connectionId || null);
  const [model, setModel] = useState(settings.model ?? '');
  const [target, setTarget] = useState(
    typeof settings.targetLength === 'number' ? String(settings.targetLength) : '',
  );
  const listId = useId();
  useEffect(() => setModel(settings.model ?? ''), [settings.model]);

  const busy = ai.phase !== 'idle';
  const noConnections = connections.data !== undefined && connections.data.length === 0;

  const commitModel = () => {
    const next = model.trim();
    if (next !== (settings.model ?? '')) onSettings({ model: next || null });
  };
  const commitTarget = () => {
    const value = Number.parseInt(target, 10);
    const next = Number.isFinite(value) && value > 0 ? value : null;
    if (next !== (settings.targetLength ?? null)) onSettings({ targetLength: next });
  };

  const disabledFor = (action: WritingAction) => {
    if (!hasDocument || busy) return true;
    if (action === 'summarize') return !isChapter || ai.summarizing !== null;
    return false;
  };

  return (
    <div data-part="writing-ai-panel" className="flex flex-col gap-5 p-4">
      {!ready && (
        <div
          data-part="writing-ai-notice"
          role="note"
          className="rounded-card edge-rule border px-3 py-2.5 text-xs leading-relaxed text-ink-2"
        >
          {noConnections ? t('writing.ai.noConnection') : t('writing.ai.noModel')}{' '}
          <Link to="/connections" className="text-accent underline underline-offset-2">
            {t('writing.ai.goConnect')}
          </Link>
        </div>
      )}

      <section>
        <FieldLabel>{t('writing.ai.actionsLabel')}</FieldLabel>
        <div className="grid grid-cols-2 gap-2">
          {AI_ACTIONS.map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === 'continue' ? 'default' : 'outline'}
              disabled={disabledFor(action)}
              title={
                action === 'continue' || action === 'summarize'
                  ? undefined
                  : hasSelection
                    ? undefined
                    : t('writing.ai.needSelection')
              }
              onClick={() => void ai.run(action)}
              className={action === 'continue' ? 'col-span-2' : undefined}
            >
              {action === 'summarize' && ai.summarizing !== null
                ? t('writing.ai.summarizing')
                : t(`writing.ai.actions.${action}`)}
            </Button>
          ))}
        </div>
        {!hasSelection && hasDocument && (
          <p className="mt-2 text-[11px] leading-relaxed text-ink-3">
            {t('writing.ai.selectionHint')}
          </p>
        )}
      </section>

      <section>
        <FieldLabel htmlFor={`${listId}-instruction`}>{t('writing.ai.instruction')}</FieldLabel>
        <Textarea
          id={`${listId}-instruction`}
          rows={3}
          value={instruction}
          placeholder={t('writing.ai.instructionPlaceholder')}
          onChange={(event) => onInstructionChange(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          className="mt-2 w-full"
          disabled={!hasDocument || busy || instruction.trim() === ''}
          onClick={() => void ai.run('custom', { instruction })}
        >
          {hasSelection ? t('writing.ai.customSelection') : t('writing.ai.customCursor')}
        </Button>
      </section>

      <section className="flex flex-col gap-3">
        <div>
          <FieldLabel htmlFor={`${listId}-connection`}>{t('writing.ai.connection')}</FieldLabel>
          <Select
            id={`${listId}-connection`}
            size="sm"
            value={connectionId}
            onChange={(event) =>
              onSettings({ connectionId: event.target.value || null, model: null })
            }
          >
            <option value="">{t('writing.ai.connectionDefault')}</option>
            {(connections.data ?? []).map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel htmlFor={`${listId}-model`}>{t('writing.ai.model')}</FieldLabel>
          <Input
            id={`${listId}-model`}
            size="sm"
            list={`${listId}-models`}
            value={model}
            disabled={connectionId === ''}
            placeholder={
              connectionId === '' ? t('writing.ai.modelDefault') : t('writing.ai.modelPlaceholder')
            }
            onChange={(event) => setModel(event.target.value)}
            onBlur={commitModel}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitModel();
            }}
          />
          <datalist id={`${listId}-models`}>
            {(models.data?.models ?? []).slice(0, 200).map((item) => (
              <option key={item.id} value={item.id} />
            ))}
          </datalist>
        </div>
        <div>
          <FieldLabel htmlFor={`${listId}-target`}>{t('writing.ai.targetLength')}</FieldLabel>
          <Input
            id={`${listId}-target`}
            size="sm"
            inputMode="numeric"
            value={target}
            placeholder={t('writing.ai.targetLengthPlaceholder')}
            onChange={(event) => setTarget(event.target.value.replace(/[^\d]/g, ''))}
            onBlur={commitTarget}
          />
        </div>
      </section>

      {ai.usage && (
        <p
          data-part="writing-ai-usage"
          className="text-[11px] leading-relaxed text-ink-3 tabular-nums"
        >
          {t('writing.ai.usage', {
            input: ai.usage.input,
            output: ai.usage.output,
            cacheRead: ai.usage.cacheRead,
          })}
        </p>
      )}
      {ai.error && ai.phase === 'idle' && (
        <p role="alert" className="text-xs text-danger">
          {t('writing.ai.failed', { message: ai.error })}
        </p>
      )}
    </div>
  );
}
