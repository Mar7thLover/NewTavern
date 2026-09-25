import { AlertTriangle, ChevronRight, Send, Square, Wrench } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Button } from '../../../components/ui/button';
import { FieldLabel, Input, Select } from '../../../components/ui/field';
import { IconButton } from '../../../components/ui/icon-button';
import { Segmented } from '../../../components/ui/segmented';
import { useConnectionModels, useConnections, usePresets } from '../../../lib/api';
import type { StudioKind } from '../../../lib/api-studio';
import { cn } from '../../../lib/utils';
import { Markdown } from '../../chat/Markdown';
import { opsToRows } from '../draft/changes';
import { ChangeList } from '../diff/ChangeList';
import type { AnyStudioDraft } from '../types';
import type { AssistMode } from './api';
import { pendingIndexes, type AssistItem, type AssistTurn } from './turns';
import type { AssistController, useAssistConnection } from './useAssist';

/*
 * AI 协作面板（M6 §4.3）：连接、模型与预设、对话流（文字流式、工具调用折叠条）、本轮改动卡（逐条 / 全部接受）。
 * 接受 = 合进草稿（不自动保存）；保存时草稿含 AI 改动则记作 AI 版本。
 */

export interface AssistPanelProps {
  kind: StudioKind;
  assist: AssistController;
  connection: ReturnType<typeof useAssistConnection>;
  /** 当前草稿（改动卡的标签要用） */
  draft: AnyStudioDraft | undefined;
  /** 世界书里有还没保存的新条目（AI 看不到） */
  unsavedEntries: boolean;
  /** 草稿不合法时不能发（例如角色卡名称为空） */
  canSend: boolean;
}

export function AssistPanel({
  kind,
  assist,
  connection,
  draft,
  unsavedEntries,
  canSend,
}: AssistPanelProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [mode, setMode] = useState<AssistMode>('edit');
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // 贴底：用户没往上翻时，新内容进来自动滚到底
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickRef.current && assist.running) element.scrollTop = element.scrollHeight;
  }, [assist.turns, assist.running]);

  const submit = () => {
    const instruction = text.trim();
    if (!instruction || assist.running || !canSend) return;
    stickRef.current = true;
    void assist.send(instruction, mode);
    setText('');
  };

  return (
    <div data-part="studio-assist" className="flex h-full min-h-0 flex-col">
      <ConnectionBar connection={connection} />

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-6 overflow-y-auto px-3 py-4"
        onScroll={(event) => {
          const element = event.currentTarget;
          stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {assist.turns.length === 0 ? (
          <div className="space-y-3 pt-2">
            <p className="text-sm leading-relaxed text-ink-2">{t(`studio.assist.intro.${kind}`)}</p>
            <ul className="space-y-1.5">
              {(t(`studio.assist.examples.${kind}`, { returnObjects: true }) as string[]).map(
                (example) => (
                  <li key={example}>
                    <button
                      type="button"
                      className="focus-ring rounded-control cursor-pointer text-left text-xs text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                      onClick={() => setText(example)}
                    >
                      {example}
                    </button>
                  </li>
                ),
              )}
            </ul>
          </div>
        ) : (
          assist.turns.map((turn, index) => (
            <TurnView
              key={turn.id}
              kind={kind}
              turn={turn}
              assist={assist}
              draft={draft}
              last={index === assist.turns.length - 1}
            />
          ))
        )}
      </div>

      <div className="edge-rule shrink-0 space-y-2 border-t px-3 pt-2 pb-3">
        {unsavedEntries && (
          <p className="text-[11px] leading-relaxed text-ink-3">
            {t('studio.assist.unsavedEntries')}
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <Segmented
            size="sm"
            className="border-b-0"
            value={mode}
            onChange={setMode}
            items={[
              { value: 'edit', label: t('studio.assist.modeEdit') },
              { value: 'generate', label: t('studio.assist.modeGenerate') },
            ]}
          />
          {assist.turns.length > 0 && !assist.running && (
            <button
              type="button"
              className="focus-ring rounded-control cursor-pointer text-[11px] text-ink-3 hover:text-ink"
              onClick={assist.clear}
            >
              {t('studio.assist.clear')}
            </button>
          )}
        </div>
        <div className="field flex items-end gap-2 p-1.5 ps-2.5">
          <textarea
            value={text}
            rows={2}
            aria-label={t('studio.assist.inputLabel')}
            placeholder={t(`studio.assist.placeholder.${mode}`)}
            className="max-h-40 min-h-10 flex-1 resize-none bg-transparent py-1 text-sm leading-relaxed outline-none"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
          />
          {assist.running ? (
            <IconButton
              label={t('studio.assist.stop')}
              variant="outline"
              size="md"
              onClick={assist.stop}
            >
              <Square aria-hidden />
            </IconButton>
          ) : (
            <IconButton
              label={t('studio.assist.send')}
              variant="solid"
              size="md"
              disabled={text.trim() === '' || !canSend}
              onClick={submit}
            >
              <Send aria-hidden />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ConnectionBar({ connection }: { connection: ReturnType<typeof useAssistConnection> }) {
  const { t } = useTranslation();
  const id = useId();
  const connections = useConnections();
  const presets = usePresets();
  const chatConnections = (connections.data ?? []).filter((item) => item.kind !== 'image');
  const models = useConnectionModels(connection.connectionId);
  const [model, setModel] = useState(connection.model ?? '');
  useEffect(() => setModel(connection.model ?? ''), [connection.model]);

  if (connections.data && chatConnections.length === 0) {
    return (
      <div className="edge-rule shrink-0 border-b px-3 py-2.5 text-xs">
        {t('errors.no_connection')}{' '}
        <Link to="/connections" className="text-accent underline underline-offset-2">
          {t('chat.panel.addConnection')}
        </Link>
      </div>
    );
  }

  return (
    <div className="edge-rule grid shrink-0 grid-cols-2 gap-2 border-b px-3 py-2.5">
      <div className="min-w-0">
        <FieldLabel htmlFor={`${id}-conn`}>{t('studio.assist.connection')}</FieldLabel>
        <Select
          id={`${id}-conn`}
          size="sm"
          value={connection.connectionId ?? ''}
          onChange={(event) => connection.setConnection(event.target.value || null)}
        >
          <option value="">{t('chat.panel.connectionUnset')}</option>
          {chatConnections.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </Select>
      </div>
      <div className="min-w-0">
        <FieldLabel htmlFor={`${id}-model`}>{t('chat.panel.model')}</FieldLabel>
        <Input
          id={`${id}-model`}
          size="sm"
          list={`${id}-models`}
          value={model}
          disabled={!connection.connectionId}
          placeholder={t('chat.panel.modelPlaceholder')}
          onChange={(event) => setModel(event.target.value)}
          onBlur={() => {
            const next = model.trim();
            if (next !== (connection.model ?? '')) connection.setModel(next || null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
          }}
        />
        <datalist id={`${id}-models`}>
          {(models.data?.models ?? []).slice(0, 200).map((item) => (
            <option key={item.id} value={item.id} />
          ))}
        </datalist>
      </div>
      {/* 预设单独一行：窄栏里三列放不下预设名 */}
      <div className="col-span-2 min-w-0" title={t('studio.assist.presetHint')}>
        <FieldLabel htmlFor={`${id}-preset`}>{t('studio.assist.preset')}</FieldLabel>
        <Select
          id={`${id}-preset`}
          size="sm"
          value={connection.presetId ?? ''}
          onChange={(event) => connection.setPreset(event.target.value || null)}
        >
          <option value="">{t('studio.assist.presetNone')}</option>
          {(presets.data ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {item.id === connection.defaultPresetId
                ? t('studio.assist.presetDefault', { name: item.name })
                : item.name}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

function TurnView({
  kind,
  turn,
  assist,
  draft,
  last,
}: {
  kind: StudioKind;
  turn: AssistTurn;
  assist: AssistController;
  draft: AnyStudioDraft | undefined;
  /** 最后一轮失败 / 停止时给「重试」 */
  last: boolean;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => (turn.patch ? opsToRows(turn.patch.ops) : []), [turn.patch]);
  const pending = pendingIndexes(turn);
  // 补丁到达时把「本轮改动」卡的开头滚进视野（比贴底更有用：卡往往很长）
  const patchRef = useRef<HTMLElement>(null);
  const hasRows = rows.length > 0;
  useEffect(() => {
    if (hasRows) patchRef.current?.scrollIntoView({ block: 'start' });
  }, [hasRows]);
  return (
    <article className="space-y-3">
      <div className="edge-rule border-s-2 ps-2.5">
        <div className="text-[10px] tracking-wide text-ink-3">
          {turn.mode === 'generate' ? t('studio.assist.youGenerate') : t('studio.assist.you')}
        </div>
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
          {turn.instruction}
        </p>
      </div>

      {turn.items.map((item, index) => (
        <ItemView key={index} item={item} />
      ))}

      {turn.status === 'running' && (
        <p className="pulse-live text-xs text-ink-3">{t('studio.assist.working')}</p>
      )}
      {turn.status === 'aborted' && (
        <p className="text-xs text-ink-3">{t('studio.assist.aborted')}</p>
      )}
      {turn.stopReason === 'max_steps' && (
        <p className="text-xs text-ink-3">{t('studio.assist.maxSteps')}</p>
      )}
      {turn.error && (
        <p role="alert" className="flex gap-1.5 text-xs leading-relaxed text-danger">
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{turn.error}</span>
        </p>
      )}

      {last && !assist.running && (turn.status === 'error' || turn.status === 'aborted') && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void assist.send(turn.instruction, turn.mode)}
        >
          {t('studio.assist.retry')}
        </Button>
      )}

      {turn.patch && (rows.length > 0 || turn.status === 'done') && (
        <section
          ref={patchRef}
          className="surface-raised edge-rule rounded-card scroll-mt-2 border px-3 pt-2.5 pb-1"
        >
          <header className="flex flex-wrap items-center gap-2">
            <h3 className="me-auto text-xs font-medium">
              {rows.length === 0
                ? t('studio.assist.noChanges')
                : t('studio.assist.changes', { n: rows.length })}
            </h3>
            {pending.length > 0 && (
              <>
                <Button variant="ghost" size="sm" onClick={() => assist.reject(turn.id)}>
                  {t('studio.assist.rejectAll')}
                </Button>
                <Button size="sm" onClick={() => assist.accept(turn.id)}>
                  {t('studio.assist.acceptAll')}
                </Button>
              </>
            )}
          </header>
          {rows.length > 0 && (
            <ChangeList
              kind={kind}
              rows={rows}
              draft={draft}
              decisions={turn.patch.decisions}
              onAccept={(index) => assist.accept(turn.id, [index])}
              onReject={(index) => assist.reject(turn.id, [index])}
            />
          )}
        </section>
      )}
    </article>
  );
}

function ItemView({ item }: { item: AssistItem }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (item.type === 'text') {
    // 模型常用 Markdown 写说明（标题、列表）；不解析原生 HTML
    return <Markdown className="text-sm leading-relaxed break-words">{item.text}</Markdown>;
  }
  if (item.type === 'reasoning') {
    return (
      <div>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="focus-ring rounded-control flex cursor-pointer items-center gap-1 text-[11px] text-ink-3 hover:text-ink-2"
        >
          <ChevronRight
            aria-hidden
            className={cn('motion-transform size-3', open && 'rotate-90')}
          />
          {t('studio.assist.reasoning')}
        </button>
        {open && (
          <p className="mt-1 ps-4 text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-3">
            {item.text}
          </p>
        )}
      </div>
    );
  }
  const status = item.result ? (item.result.ok ? 'ok' : 'error') : 'running';
  return (
    <div data-part="studio-tool-call" data-status={status} className="text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="focus-ring rounded-control flex w-full cursor-pointer items-center gap-1.5 py-0.5 text-left text-ink-2 hover:text-ink"
      >
        <ChevronRight
          aria-hidden
          className={cn('motion-transform size-3 shrink-0', open && 'rotate-90')}
        />
        <Wrench aria-hidden className="size-3 shrink-0" />
        <span className="shrink-0 font-mono text-[11px]">{item.name}</span>
        <span className="min-w-0 flex-1 truncate text-ink-3">
          {item.result?.summary ?? item.summary}
        </span>
        {status === 'running' && <span className="pulse-live shrink-0 text-ink-3">…</span>}
        {status === 'error' && (
          <span className="shrink-0 text-danger">{t('studio.assist.toolFailed')}</span>
        )}
      </button>
      {open && (
        <div className="mt-1.5 space-y-2 ps-4">
          <ToolBlock label={t('studio.assist.toolArgs')} value={item.args} />
          {item.result && (
            <ToolBlock label={t('studio.assist.toolResult')} value={item.result.content} />
          )}
        </div>
      )}
    </div>
  );
}

function ToolBlock({ label, value }: { label: string; value: unknown }) {
  let text: string;
  if (typeof value === 'string') {
    // 结果常是 JSON 字符串：能解析就缩进显示
    try {
      text = JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      text = value;
    }
  } else {
    text = JSON.stringify(value, null, 2) ?? '';
  }
  return (
    <div>
      <div className="mb-0.5 text-[10px] tracking-wide text-ink-3">{label}</div>
      <pre className="edge-rule rounded-control max-h-60 overflow-auto border p-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}
