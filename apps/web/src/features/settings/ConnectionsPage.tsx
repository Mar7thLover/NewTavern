import { Check, ChevronDown, Star, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { FieldLabel, Input, Select, Textarea } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import {
  PROVIDER_IDS,
  useConnectionModels,
  useConnections,
  useCreateConnection,
  useDeleteConnection,
  useGenerationDefault,
  useRefreshConnectionModels,
  useSetGenerationDefault,
  useTestConnection,
  useUpdateConnection,
  type ConnectionInput,
  type ConnectionSummary,
  type ProviderId,
} from '../../lib/api';
import { cn } from '../../lib/utils';
import { ImageBackendsSection } from '../imagine/ImageBackendsSection';
import {
  EmptyState,
  LibraryHeader,
  QueryStatus,
  errorMessage,
  formatDate,
} from '../library/shared';

const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
};

/** 常见 OpenAI 兼容端点的一键填充 */
const ENDPOINT_PRESETS: { name: string; baseUrl: string }[] = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  { name: 'LM Studio', baseUrl: 'http://localhost:1234/v1' },
];

const QUIRK_KEYS = [
  'developerRole',
  'reasoningContent',
  'prefill',
  'streamUsage',
  'reasoningEffort',
  'thinkingToggle',
] as const;

type FormTarget = null | 'new' | ConnectionSummary;

export function ConnectionsPage() {
  const { t } = useTranslation();
  const connections = useConnections();
  const generationDefault = useGenerationDefault();
  const deleteConnection = useDeleteConnection();
  const testConnection = useTestConnection();
  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [pendingDelete, setPendingDelete] = useState<ConnectionSummary | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const list = connections.data ?? [];
  const defaultConnectionId = generationDefault.data?.connectionId ?? null;

  return (
    <div className="mx-auto max-w-4xl">
      <LibraryHeader
        title={t('nav.connections')}
        subtitle={connections.data ? t('connections.count', { total: list.length }) : null}
        actions={
          list.length > 0 ? (
            <Button size="sm" onClick={() => setFormTarget('new')}>
              {t('connections.create')}
            </Button>
          ) : null
        }
      />

      <QueryStatus
        isPending={connections.isPending}
        error={connections.error}
        onRetry={() => void connections.refetch()}
      />

      {connections.data &&
        (list.length === 0 ? (
          <EmptyState
            kind="connections"
            title={t('connections.emptyTitle')}
            hint={t('connections.emptyHint')}
            action={
              <Button size="lg" onClick={() => setFormTarget('new')}>
                {t('connections.create')}
              </Button>
            }
          />
        ) : (
          <ul className="space-y-3">
            {list.map((connection) => {
              const testResult =
                testConnection.variables?.id === connection.id ? testConnection : null;
              return (
                <li
                  key={connection.id}
                  data-part="connection-card"
                  className="rounded-card edge-rule border text-ink"
                >
                  <div className="flex flex-wrap items-start gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{connection.label}</span>
                        <Badge variant="muted">
                          {t(`connections.providers.${connection.provider}`)}
                        </Badge>
                        {defaultConnectionId === connection.id && (
                          <Badge>{t('connections.isDefault')}</Badge>
                        )}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-ink-2">
                        {connection.baseUrl ?? DEFAULT_BASE_URLS[connection.provider]}
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
                    {/* 窄屏时操作条整行换下去，别把连接名和 Base URL 挤没 */}
                    <div className="flex basis-full flex-wrap items-center gap-2 sm:basis-auto sm:shrink-0">
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
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1"
                        onClick={() =>
                          setExpandedId((current) =>
                            current === connection.id ? null : connection.id,
                          )
                        }
                      >
                        {t('connections.models')}
                        <ChevronDown
                          aria-hidden
                          className={cn(
                            'motion-transform size-3.5',
                            expandedId === connection.id && 'rotate-180',
                          )}
                        />
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
                        : t('connections.testOk', { ms: testResult.data?.latencyMs ?? 0 })}
                    </p>
                  )}

                  {expandedId === connection.id && (
                    <ModelsSection
                      connectionId={connection.id}
                      defaultModel={
                        defaultConnectionId === connection.id
                          ? (generationDefault.data?.model ?? null)
                          : null
                      }
                    />
                  )}
                </li>
              );
            })}
          </ul>
        ))}

      {/* 外接生图后端（M4（二）§D.3）：独立分组，不进对话连接的下拉 */}
      <ImageBackendsSection />

      {formTarget !== null && (
        <ConnectionFormModal
          key={formTarget === 'new' ? 'new' : formTarget.id}
          connection={formTarget === 'new' ? null : formTarget}
          onClose={() => setFormTarget(null)}
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
    </div>
  );
}

/** 模型列表：可搜索、可刷新、点选设为生成默认 */
function ModelsSection({
  connectionId,
  defaultModel,
}: {
  connectionId: string;
  defaultModel: string | null;
}) {
  const { t, i18n } = useTranslation();
  const models = useConnectionModels(connectionId);
  const refresh = useRefreshConnectionModels();
  const setDefault = useSetGenerationDefault();
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const list = (models.data?.models ?? []).filter(
    (model) => needle === '' || model.id.toLowerCase().includes(needle),
  );

  return (
    <div className="border-t edge-rule p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          size="sm"
          value={query}
          placeholder={t('connections.searchModels')}
          aria-label={t('connections.searchModels')}
          onChange={(event) => setQuery(event.target.value)}
          className="w-full sm:w-64"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate(connectionId)}
        >
          {refresh.isPending ? t('common.processing') : t('connections.refreshModels')}
        </Button>
        {models.data?.fetchedAt && (
          <span className="text-xs text-ink-2">
            {t('connections.fetchedAt', { time: formatDate(models.data.fetchedAt) })}
          </span>
        )}
      </div>

      <QueryStatus
        isPending={models.isPending}
        error={models.error ?? refresh.error}
        onRetry={() => void models.refetch()}
      />

      {models.data &&
        (list.length === 0 ? (
          <p className="py-4 text-center text-sm text-ink-2">{t('connections.noModels')}</p>
        ) : (
          <ul className="mt-3 max-h-72 space-y-0.5 overflow-y-auto">
            {list.map((model) => {
              const isDefault = model.id === defaultModel;
              return (
                <li key={model.id}>
                  <button
                    type="button"
                    disabled={setDefault.isPending}
                    onClick={() => setDefault.mutate({ connectionId, model: model.id })}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 text-left text-sm transition-colors hover:text-ink disabled:opacity-50',
                      isDefault ? 'text-ink' : 'text-ink-2',
                    )}
                    title={t('connections.setDefault')}
                  >
                    {isDefault ? (
                      <Star aria-hidden className="size-3.5 shrink-0 fill-current text-accent" />
                    ) : (
                      <Star aria-hidden className="size-3.5 shrink-0 text-ink-3" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{model.id}</span>
                    {model.contextLength !== undefined && (
                      <span className="shrink-0 text-[11px] text-ink-2 tabular-nums">
                        {new Intl.NumberFormat(i18n.language, {
                          notation: 'compact',
                        }).format(model.contextLength)}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 新建 / 编辑                                                          */
/* ------------------------------------------------------------------ */

function parseKeys(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 一行一个 `k=v` */
function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;
    headers[trimmed.slice(0, equals).trim()] = trimmed.slice(equals + 1).trim();
  }
  return headers;
}

function formatHeaders(headers: Record<string, string> | undefined): string {
  return Object.entries(headers ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

function ConnectionFormModal({
  connection,
  onClose,
}: {
  connection: ConnectionSummary | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const createConnection = useCreateConnection();
  const updateConnection = useUpdateConnection();

  const [provider, setProvider] = useState<ProviderId>(connection?.provider ?? 'openai-chat');
  const [label, setLabel] = useState(connection?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? '');
  const [keysText, setKeysText] = useState('');
  const [clearKeys, setClearKeys] = useState(false);
  const [headersText, setHeadersText] = useState(formatHeaders(connection?.headers));
  const [quirks, setQuirks] = useState<Record<string, boolean>>(connection?.quirks ?? {});
  const [advanced, setAdvanced] = useState(false);
  const [labelError, setLabelError] = useState(false);

  const mutation = connection ? updateConnection : createConnection;
  const pending = mutation.isPending;

  const applyPreset = (presetBaseUrl: string, name: string) => {
    setProvider('openai-chat');
    setBaseUrl(presetBaseUrl);
    if (label.trim() === '') setLabel(name);
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedLabel = label.trim();
    if (trimmedLabel === '') {
      setLabelError(true);
      return;
    }
    const keys = parseKeys(keysText);
    const input: ConnectionInput = {
      provider,
      label: trimmedLabel,
      baseUrl: baseUrl.trim() === '' ? DEFAULT_BASE_URLS[provider] : baseUrl.trim(),
      headers: parseHeaders(headersText),
      quirks,
      ...(keys.length > 0 ? { apiKeys: keys } : clearKeys ? { apiKeys: [] } : {}),
    };
    if (connection) {
      updateConnection.mutate({ id: connection.id, ...input }, { onSuccess: onClose });
    } else {
      createConnection.mutate(input, { onSuccess: onClose });
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      dismissible={!pending}
      title={connection ? t('connections.editTitle') : t('connections.createTitle')}
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
      <form id={formId} onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <FieldLabel>{t('connections.provider')}</FieldLabel>
          <div className="grid grid-cols-2 gap-2">
            {PROVIDER_IDS.map((id) => (
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
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-ink-2">{t('connections.endpoints')}</span>
            {ENDPOINT_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                onClick={() => applyPreset(preset.baseUrl, preset.name)}
                className="rounded-pill edge-rule cursor-pointer border px-2 py-0.5 text-[11px] text-ink-2 transition-colors hover:border-ink hover:text-ink"
              >
                {preset.name}
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
            placeholder={t('connections.labelPlaceholder')}
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
            placeholder={DEFAULT_BASE_URLS[provider]}
            onChange={(event) => setBaseUrl(event.target.value)}
            className="font-mono text-xs"
          />
        </div>

        <div>
          <FieldLabel htmlFor={`${formId}-keys`}>{t('connections.apiKeys')}</FieldLabel>
          <Textarea
            id={`${formId}-keys`}
            value={keysText}
            rows={3}
            disabled={pending}
            spellCheck={false}
            placeholder={t('connections.apiKeysPlaceholder')}
            onChange={(event) => setKeysText(event.target.value)}
            className="font-mono text-xs"
          />
          <p className="mt-1 text-xs text-ink-2">
            {connection
              ? t('connections.apiKeysKeepHint', { total: connection.keyCount })
              : t('connections.apiKeysHint')}
          </p>
          {connection && connection.keyCount > 0 && (
            <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={clearKeys}
                disabled={pending || parseKeys(keysText).length > 0}
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
            <div className="edge-rule mt-3 space-y-4 border-t pt-3">
              <div>
                <FieldLabel htmlFor={`${formId}-headers`}>{t('connections.headers')}</FieldLabel>
                <Textarea
                  id={`${formId}-headers`}
                  value={headersText}
                  rows={3}
                  disabled={pending}
                  spellCheck={false}
                  placeholder={'HTTP-Referer=https://example.com'}
                  onChange={(event) => setHeadersText(event.target.value)}
                  className="font-mono text-xs"
                />
                <p className="mt-1 text-xs text-ink-2">{t('connections.headersHint')}</p>
              </div>
              <div>
                <FieldLabel>{t('connections.quirks')}</FieldLabel>
                <div className="space-y-1.5">
                  {QUIRK_KEYS.map((key) => (
                    <div key={key} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {t(`connections.quirkNames.${key}`)}
                      </span>
                      <Select
                        size="sm"
                        className="w-28"
                        disabled={pending}
                        value={key in quirks ? String(quirks[key]) : ''}
                        onChange={(event) =>
                          setQuirks((current) => {
                            const next = { ...current };
                            if (event.target.value === '') delete next[key];
                            else next[key] = event.target.value === 'true';
                            return next;
                          })
                        }
                      >
                        <option value="">{t('connections.quirkAuto')}</option>
                        <option value="true">{t('connections.quirkOn')}</option>
                        <option value="false">{t('connections.quirkOff')}</option>
                      </Select>
                    </div>
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-ink-2">{t('connections.quirksHint')}</p>
              </div>
            </div>
          )}
        </div>

        {mutation.error && (
          <p role="alert" className="text-sm text-danger">
            {errorMessage(mutation.error)}
          </p>
        )}
      </form>
    </Modal>
  );
}
