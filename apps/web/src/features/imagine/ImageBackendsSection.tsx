import { Check, ChevronDown, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import {
  IMAGE_BACKEND_IDS,
  IMAGE_DEFAULT_BASE_URLS,
  useImageConnections,
  useImageGenSettings,
  useSaveImageConnection,
  useSetImageGenSettings,
  type ImageBackendId,
  type ImageConnectionSummary,
  type ImageGenSettings,
} from './api';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { FieldLabel, Input, Select, Textarea } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import {
  useConnectionModels,
  useConnections,
  useDeleteConnection,
  useTestConnection,
} from '../../lib/api';
import { cn } from '../../lib/utils';
import { errorMessage } from '../library/shared';

/**
 * 连接页里的「生图后端」分组（docs/M4-CONTRACT.md 第二部分 §D.3）：
 * 生图连接的增删改测，以及设置 KV `imageGen`（用哪个后端、默认尺寸与参数、画风前缀、
 * 写提示词用的模型、ComfyUI 工作流）。
 */

type FormTarget = null | 'new' | ImageConnectionSummary;

export function ImageBackendsSection() {
  const { t } = useTranslation();
  const connections = useImageConnections();
  const settings = useImageGenSettings();
  const setSettings = useSetImageGenSettings();
  const deleteConnection = useDeleteConnection();
  const testConnection = useTestConnection();
  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [pendingDelete, setPendingDelete] = useState<ImageConnectionSummary | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  const list = connections.data ?? [];
  const activeId = settings.data?.connectionId ?? null;

  const use = (id: string) => {
    if (!settings.data) return;
    setSettings.mutate({
      ...settings.data,
      connectionId: id,
      model: undefined,
    } as ImageGenSettings);
  };

  return (
    <section data-part="image-backends" className="mt-14">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-xl leading-tight">{t('imageGen.backends.title')}</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-2">{t('imageGen.backends.hint')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setFormTarget('new')}>
          {t('imageGen.backends.create')}
        </Button>
      </div>

      {list.length === 0 ? (
        <p className="edge-rule rounded-card border border-dashed px-4 py-6 text-center text-sm text-ink-2">
          {t('imageGen.backends.empty')}
        </p>
      ) : (
        <ul className="space-y-3">
          {list.map((connection) => {
            const testResult =
              testConnection.variables?.id === connection.id ? testConnection : null;
            const active = connection.id === activeId;
            return (
              <li
                key={connection.id}
                data-part="connection-card"
                data-kind="image"
                className="rounded-card edge-rule border text-ink"
              >
                <div className="flex flex-wrap items-start gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{connection.label}</span>
                      <Badge variant="muted">
                        {t(`connections.providers.${connection.provider}`)}
                      </Badge>
                      {active && <Badge>{t('imageGen.backends.inUse')}</Badge>}
                    </div>
                    <div className="mt-1 truncate font-mono text-xs text-ink-2">
                      {connection.baseUrl ?? IMAGE_DEFAULT_BASE_URLS[connection.provider]}
                    </div>
                    <div className="mt-1 text-xs text-ink-2">
                      {connection.keyCount > 0
                        ? t('connections.keyCount', {
                            total: connection.keyCount,
                            hints: connection.keyHints.map((hint) => `…${hint}`).join(' '),
                          })
                        : t('connections.noKeys')}
                    </div>
                  </div>
                  <div className="flex basis-full flex-wrap items-center gap-2 sm:basis-auto sm:shrink-0">
                    {!active && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={setSettings.isPending || !settings.data}
                        onClick={() => use(connection.id)}
                      >
                        {t('imageGen.backends.use')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={testConnection.isPending}
                      onClick={() => testConnection.mutate({ id: connection.id })}
                    >
                      {testResult?.isPending ? t('connections.testing') : t('connections.test')}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setFormTarget(connection)}>
                      {t('common.edit')}
                    </Button>
                    <IconButton
                      label={t('common.delete')}
                      variant="destructive"
                      onClick={() => {
                        deleteConnection.reset();
                        setPendingDelete(connection);
                      }}
                    >
                      <Trash2 aria-hidden />
                    </IconButton>
                  </div>
                </div>
                {testResult && !testResult.isPending && (
                  <p
                    role="status"
                    className={cn(
                      'border-t edge-rule px-4 py-2 text-xs',
                      testResult.error ? 'text-danger' : 'text-ink-2',
                    )}
                  >
                    {testResult.error
                      ? t('connections.testFailed', { message: errorMessage(testResult.error) })
                      : t('imageGen.backends.testOk', {
                          ms: testResult.data?.latencyMs ?? 0,
                          total: testResult.data?.modelCount ?? 0,
                        })}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {list.length > 0 && settings.data && (
        <ImageGenSettingsPanel
          // 设置从外面变了（「改用它」、保存成功）就按新值重建表单；展开与「已保存」放在这里才不会跟着丢
          key={JSON.stringify(settings.data)}
          settings={settings.data}
          connections={list}
          open={panelOpen}
          onToggle={() => setPanelOpen((value) => !value)}
          saved={saved}
          onSaved={() => setSaved(true)}
        />
      )}

      {formTarget !== null && (
        <ImageBackendFormModal
          key={formTarget === 'new' ? 'new' : formTarget.id}
          connection={formTarget === 'new' ? null : formTarget}
          onClose={() => setFormTarget(null)}
          onCreated={(id) => {
            // 第一个生图后端：直接设为使用中
            if (!activeId && settings.data) {
              setSettings.mutate({ ...settings.data, connectionId: id });
            }
          }}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title={t('connections.deleteTitle')}
        description={t('connections.deleteMessage', { name: pendingDelete?.label ?? '' })}
        confirmLabel={t('common.delete')}
        pending={deleteConnection.isPending}
        error={errorMessage(deleteConnection.error)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          deleteConnection.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
        }}
      />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 设置面板                                                             */
/* ------------------------------------------------------------------ */

function numberField(value: string, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function ImageGenSettingsPanel({
  settings,
  connections,
  open,
  onToggle,
  saved,
  onSaved,
}: {
  settings: ImageGenSettings;
  connections: ImageConnectionSummary[];
  open: boolean;
  onToggle: () => void;
  saved: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const save = useSetImageGenSettings();
  const chatConnections = useConnections();
  const [connectionId, setConnectionId] = useState(settings.connectionId ?? '');
  const [model, setModel] = useState(settings.model ?? '');
  const [width, setWidth] = useState(String(settings.defaults.width));
  const [height, setHeight] = useState(String(settings.defaults.height));
  const [steps, setSteps] = useState(String(settings.defaults.steps));
  const [cfg, setCfg] = useState(String(settings.defaults.cfg));
  const [sampler, setSampler] = useState(settings.defaults.sampler);
  const [negative, setNegative] = useState(settings.defaults.negative);
  const [stylePrefix, setStylePrefix] = useState(settings.stylePrefix ?? '');
  const [writerId, setWriterId] = useState(settings.promptWriter?.connectionId ?? '');
  const [writerModel, setWriterModel] = useState(settings.promptWriter?.model ?? '');
  const [workflow, setWorkflow] = useState<Record<string, unknown> | undefined>(
    settings.comfyWorkflow,
  );
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selected = connections.find((row) => row.id === connectionId) ?? null;
  const models = useConnectionModels(selected ? selected.id : null);
  const importWorkflow = async (file: File) => {
    setWorkflowError(null);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      // API 格式：顶层是「节点 id → { class_type, inputs }」；UI 格式（有 nodes / links）不能直接排队
      const isApiFormat =
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        !('nodes' in parsed) &&
        Object.values(parsed).some(
          (node) => typeof node === 'object' && node !== null && 'class_type' in node,
        );
      if (!isApiFormat) throw new Error('format');
      setWorkflow(parsed as Record<string, unknown>);
    } catch {
      setWorkflowError(t('imageGen.settings.comfyInvalid'));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: ImageGenSettings = {
      connectionId: connectionId || null,
      ...(model ? { model } : {}),
      defaults: {
        width: numberField(width, settings.defaults.width, 64, 4096),
        height: numberField(height, settings.defaults.height, 64, 4096),
        steps: numberField(steps, settings.defaults.steps, 1, 200),
        cfg: numberField(cfg, settings.defaults.cfg, 0.1, 50),
        sampler: sampler.trim(),
        negative,
      },
      ...(writerId && writerModel.trim()
        ? { promptWriter: { connectionId: writerId, model: writerModel.trim() } }
        : {}),
      ...(workflow ? { comfyWorkflow: workflow } : {}),
      ...(stylePrefix.trim() ? { stylePrefix: stylePrefix.trim() } : {}),
    };
    save.mutate(next, { onSuccess: onSaved });
  };

  const nodeCount = workflow ? Object.keys(workflow).length : 0;

  return (
    <div data-part="image-gen-settings" className="rounded-card edge-rule mt-6 border">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm font-medium"
      >
        <ChevronDown aria-hidden className={cn('motion-transform size-4', !open && '-rotate-90')} />
        {t('imageGen.settings.title')}
      </button>
      {open && (
        <form
          id={formId}
          onSubmit={submit}
          className="edge-rule space-y-4 border-t px-4 pt-4 pb-4"
          noValidate
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor={`${formId}-backend`}>
                {t('imageGen.settings.backend')}
              </FieldLabel>
              <Select
                id={`${formId}-backend`}
                value={connectionId}
                onChange={(event) => {
                  setConnectionId(event.target.value);
                  setModel('');
                }}
              >
                <option value="">{t('imageGen.settings.none')}</option>
                {connections.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel htmlFor={`${formId}-model`}>{t('imageGen.settings.model')}</FieldLabel>
              <Select
                id={`${formId}-model`}
                value={model}
                disabled={!selected}
                onChange={(event) => setModel(event.target.value)}
              >
                <option value="">{t('imageGen.settings.modelDefault')}</option>
                {model && !(models.data?.models ?? []).some((row) => row.id === model) && (
                  <option value={model}>{model}</option>
                )}
                {(models.data?.models ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name && row.name !== row.id ? `${row.name}（${row.id}）` : row.id}
                  </option>
                ))}
              </Select>
              {models.error && (
                <p className="mt-1 text-xs text-danger">{errorMessage(models.error)}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {(
              [
                ['width', width, setWidth],
                ['height', height, setHeight],
                ['steps', steps, setSteps],
                ['cfg', cfg, setCfg],
              ] as const
            ).map(([key, value, setter]) => (
              <div key={key}>
                <FieldLabel htmlFor={`${formId}-${key}`}>
                  {t(`imageGen.settings.${key}`)}
                </FieldLabel>
                <Input
                  id={`${formId}-${key}`}
                  inputMode="decimal"
                  value={value}
                  onChange={(event) => setter(event.target.value.replace(/[^\d.]/g, ''))}
                  className="tabular-nums"
                />
              </div>
            ))}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor={`${formId}-sampler`}>
                {t('imageGen.settings.sampler')}
              </FieldLabel>
              <Input
                id={`${formId}-sampler`}
                value={sampler}
                spellCheck={false}
                placeholder={t('imageGen.settings.samplerPlaceholder')}
                onChange={(event) => setSampler(event.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <div>
              <FieldLabel htmlFor={`${formId}-style`}>
                {t('imageGen.settings.stylePrefix')}
              </FieldLabel>
              <Input
                id={`${formId}-style`}
                value={stylePrefix}
                spellCheck={false}
                placeholder={t('imageGen.settings.stylePrefixPlaceholder')}
                onChange={(event) => setStylePrefix(event.target.value)}
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div>
            <FieldLabel htmlFor={`${formId}-neg`}>{t('imageGen.settings.negative')}</FieldLabel>
            <Textarea
              id={`${formId}-neg`}
              value={negative}
              rows={2}
              spellCheck={false}
              onChange={(event) => setNegative(event.target.value)}
              className="font-mono text-xs"
            />
          </div>

          <div>
            <FieldLabel htmlFor={`${formId}-writer`}>{t('imageGen.settings.writer')}</FieldLabel>
            <div className="grid gap-2 sm:grid-cols-2">
              <Select
                id={`${formId}-writer`}
                value={writerId}
                onChange={(event) => setWriterId(event.target.value)}
              >
                <option value="">{t('imageGen.settings.writerDefault')}</option>
                {(chatConnections.data ?? []).map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label}
                  </option>
                ))}
              </Select>
              <Input
                value={writerModel}
                disabled={!writerId}
                spellCheck={false}
                aria-label={t('imageGen.settings.writerModel')}
                placeholder={t('imageGen.settings.writerModel')}
                onChange={(event) => setWriterModel(event.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <p className="mt-1 text-xs text-ink-2">{t('imageGen.settings.writerHint')}</p>
          </div>

          {selected?.provider === 'image-comfy' && (
            <div data-part="comfy-workflow">
              <FieldLabel>{t('imageGen.settings.comfyWorkflow')}</FieldLabel>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-ink-2">
                  {workflow
                    ? t('imageGen.settings.comfyLoaded', { count: nodeCount })
                    : t('imageGen.settings.comfyBuiltin')}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                >
                  {t('imageGen.settings.comfyImport')}
                </Button>
                {workflow && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setWorkflow(undefined)}
                  >
                    {t('imageGen.settings.comfyClear')}
                  </Button>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="application/json,.json"
                  className="hidden"
                  tabIndex={-1}
                  aria-hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importWorkflow(file);
                    event.target.value = '';
                  }}
                />
              </div>
              {workflowError && <p className="mt-1 text-xs text-danger">{workflowError}</p>}
              <p className="mt-1 text-xs text-ink-2">{t('imageGen.settings.comfyHint')}</p>
            </div>
          )}

          <div className="flex items-center justify-end gap-3">
            {save.error && <p className="text-xs text-danger">{errorMessage(save.error)}</p>}
            {saved && (
              <span role="status" className="flex items-center gap-1 text-xs text-ink-2">
                <Check aria-hidden className="size-3.5" />
                {t('imageGen.settings.saved')}
              </span>
            )}
            <Button type="submit" size="sm" disabled={save.isPending}>
              {save.isPending ? t('common.processing') : t('common.save')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 新建 / 编辑生图后端                                                   */
/* ------------------------------------------------------------------ */

function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of parseLines(text)) {
    const equals = line.indexOf('=');
    if (equals <= 0) continue;
    headers[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }
  return headers;
}

function ImageBackendFormModal({
  connection,
  onClose,
  onCreated,
}: {
  connection: ImageConnectionSummary | null;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const saveConnection = useSaveImageConnection();
  const [provider, setProvider] = useState<ImageBackendId>(connection?.provider ?? 'image-sd');
  const [label, setLabel] = useState(connection?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [keysText, setKeysText] = useState('');
  const [clearKeys, setClearKeys] = useState(false);
  const [headersText, setHeadersText] = useState(
    Object.entries(connection?.headers ?? {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
  );
  const [advanced, setAdvanced] = useState(false);
  const [labelError, setLabelError] = useState(false);
  const pending = saveConnection.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed === '') {
      setLabelError(true);
      return;
    }
    const keys = parseLines(keysText);
    saveConnection.mutate(
      {
        ...(connection ? { id: connection.id } : {}),
        provider,
        label: trimmed,
        baseUrl: baseUrl.trim() || IMAGE_DEFAULT_BASE_URLS[provider],
        headers: parseHeaders(headersText),
        ...(keys.length > 0 ? { apiKeys: keys } : clearKeys ? { apiKeys: [] } : {}),
      },
      {
        onSuccess: (data) => {
          if (!connection) onCreated(data.id);
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      dismissible={!pending}
      title={connection ? t('imageGen.backends.editTitle') : t('imageGen.backends.createTitle')}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={pending}>
            {pending ? t('common.processing') : t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <FieldLabel>{t('imageGen.backends.kind')}</FieldLabel>
          <div className="grid grid-cols-2 gap-2">
            {IMAGE_BACKEND_IDS.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={provider === id}
                onClick={() => setProvider(id)}
                className={cn(
                  'cursor-pointer rounded-control border px-3 py-2 text-left text-sm transition-colors focus-ring',
                  provider === id
                    ? 'border-ink font-medium text-ink'
                    : 'edge-rule text-ink-2 hover:text-ink',
                )}
              >
                <span className="flex items-center gap-1.5">
                  {provider === id && <Check aria-hidden className="size-3.5 text-accent" />}
                  {t(`connections.providers.${id}`)}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <FieldLabel htmlFor={`${formId}-label`}>{t('connections.label')}</FieldLabel>
          <Input
            id={`${formId}-label`}
            value={label}
            autoFocus
            maxLength={100}
            disabled={pending}
            aria-invalid={labelError}
            placeholder={t('imageGen.backends.labelPlaceholder')}
            onChange={(event) => {
              setLabel(event.target.value);
              if (labelError) setLabelError(false);
            }}
          />
          {labelError && (
            <p className="mt-1 text-xs text-danger">{t('connections.labelRequired')}</p>
          )}
        </div>

        <div>
          <FieldLabel htmlFor={`${formId}-baseurl`}>{t('connections.baseUrl')}</FieldLabel>
          <Input
            id={`${formId}-baseurl`}
            value={baseUrl}
            disabled={pending}
            spellCheck={false}
            placeholder={IMAGE_DEFAULT_BASE_URLS[provider]}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="font-mono text-xs"
          />
        </div>

        <div>
          <FieldLabel htmlFor={`${formId}-keys`}>{t('connections.apiKeys')}</FieldLabel>
          <Textarea
            id={`${formId}-keys`}
            value={keysText}
            rows={2}
            disabled={pending}
            spellCheck={false}
            placeholder={t(`imageGen.backends.keyPlaceholder.${provider}`)}
            onChange={(event) => setKeysText(event.target.value)}
            className="font-mono text-xs"
          />
          <p className="mt-1 text-xs text-ink-2">
            {connection
              ? t('connections.apiKeysKeepHint', { total: connection.keyCount })
              : t(`imageGen.backends.keyHint.${provider}`)}
          </p>
          {connection && connection.keyCount > 0 && (
            <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={clearKeys}
                disabled={pending || parseLines(keysText).length > 0}
                onChange={(event) => setClearKeys(event.target.checked)}
                className="size-3.5 cursor-pointer accent-[var(--primary)]"
              />
              {t('connections.clearKeys')}
            </label>
          )}
        </div>

        <div>
          <button
            type="button"
            onClick={() => setAdvanced((value) => !value)}
            className="flex cursor-pointer items-center gap-1 text-xs font-medium text-ink-2 hover:text-ink"
          >
            <ChevronDown
              aria-hidden
              className={cn('size-3.5 motion-transform', advanced && 'rotate-180')}
            />
            {t('connections.advanced')}
          </button>
          {advanced && (
            <div className="edge-rule mt-3 border-t pt-3">
              <FieldLabel htmlFor={`${formId}-headers`}>{t('connections.headers')}</FieldLabel>
              <Textarea
                id={`${formId}-headers`}
                value={headersText}
                rows={3}
                disabled={pending}
                spellCheck={false}
                onChange={(event) => setHeadersText(event.target.value)}
                className="font-mono text-xs"
              />
              <p className="mt-1 text-xs text-ink-2">{t('connections.headersHint')}</p>
            </div>
          )}
        </div>

        {saveConnection.error && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(saveConnection.error)}
          </p>
        )}
      </form>
    </Modal>
  );
}
