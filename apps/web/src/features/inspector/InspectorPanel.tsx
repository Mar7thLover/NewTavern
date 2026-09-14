import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { CompareView } from './CompareView';
import { RequestView } from './RequestView';
import { SegmentList } from './SegmentList';
import { WorldInfoView } from './WorldInfoView';
import { isInspectPlaceholder, type InspectData } from './types';
import { useInspect } from './useInspect';
import { Badge } from '../../components/ui/badge';
import { IconButton } from '../../components/ui/icon-button';
import {
  ApiError,
  useGenerationDefault,
  usePatchChat,
  type ChatDetail,
  type LayoutMode,
} from '../../lib/api';
import { cn } from '../../lib/utils';
import { QueryStatus } from '../library/shared';

const LAYOUT_MODES: LayoutMode[] = ['strict', 'cache-aware'];
const TABS = ['segments', 'worldInfo', 'request', 'compare'] as const;
type InspectorTab = (typeof TABS)[number];

export interface InspectorPanelProps {
  chat: ChatDetail;
  /** 生成中不刷新（契约 §7.1） */
  isGenerating: boolean;
}

export function InspectorPanel({ chat, isGenerating }: InspectorPanelProps) {
  const { t } = useTranslation();
  const patchChat = usePatchChat();
  const generationDefault = useGenerationDefault();
  const [tab, setTab] = useState<InspectorTab>('segments');
  const [view, setView] = useState<'current' | 'strict'>('current');
  const [focusId, setFocusId] = useState<string | null>(null);

  const layoutMode: LayoutMode = chat.overrides?.layoutMode ?? 'cache-aware';
  const connectionId = chat.overrides?.connectionId ?? generationDefault.data?.connectionId ?? null;
  const model = chat.overrides?.model ?? generationDefault.data?.model ?? null;

  const inspect = useInspect({
    chatId: chat.id,
    parentId: chat.headNodeId,
    layoutMode,
    connectionId,
    model,
    enabled: !isGenerating,
  });

  // 跳到原位：切到 strict 参照视图并把目标段滚进可视区
  useEffect(() => {
    if (focusId === null) return;
    const element = document.getElementById(`nt-segment-${focusId}`);
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const timer = window.setTimeout(() => setFocusId(null), 2400);
    return () => window.clearTimeout(timer);
  }, [focusId, view]);

  const data = inspect.data && !isInspectPlaceholder(inspect.data) ? inspect.data : null;
  const noConnection = inspect.error instanceof ApiError && inspect.error.code === 'no_connection';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 space-y-2.5 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex flex-1 gap-1 rounded-md bg-muted/60 p-0.5">
            {LAYOUT_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() =>
                  patchChat.mutate({
                    id: chat.id,
                    overrides: { ...(chat.overrides ?? {}), layoutMode: mode },
                  })
                }
                className={cn(
                  'flex-1 cursor-pointer rounded px-2 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  layoutMode === mode
                    ? 'bg-card font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`chat.panel.layout.${mode === 'cache-aware' ? 'cacheAware' : 'strict'}`)}
              </button>
            ))}
          </div>
          <IconButton
            label={t('inspector.refresh')}
            variant="outline"
            disabled={isGenerating || inspect.isFetching}
            onClick={() => void inspect.refetch()}
          >
            <RefreshCw aria-hidden className={cn(inspect.isFetching && 'animate-spin')} />
          </IconButton>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Badge variant="muted" className="max-w-40 truncate">
            {model ?? t('chat.panel.connectionUnset')}
          </Badge>
          <Stat label={t('inspector.tokenEstimate')} value={data?.tokenEstimate ?? null} />
          <Stat
            label={t('inspector.cacheablePrefix')}
            value={
              data && data.tokenEstimate > 0
                ? `${Math.round(
                    (data.layout.estimatedCacheablePrefixTokens / data.tokenEstimate) * 100,
                  )}%`
                : null
            }
          />
          <Stat label={t('inspector.lastCacheRead')} value={data?.lastUsage?.cacheRead ?? null} />
          <Stat label={t('inspector.lastCacheWrite')} value={data?.lastUsage?.cacheWrite ?? null} />
        </div>

        <nav className="flex gap-1 overflow-x-auto">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={cn(
                'cursor-pointer rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                tab === item
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`inspector.tabs.${item}`)}
            </button>
          ))}
        </nav>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isGenerating && (
          <p className="border-b border-border px-3 py-2 text-xs text-muted-foreground">
            {t('inspector.generatingHint')}
          </p>
        )}

        {noConnection ? (
          // 没有默认连接 / 模型时 inspect 直接 400，这里给出口而不是干巴巴的错误码
          <div className="m-3 rounded-lg border border-dashed border-border p-4 text-sm">
            <p>{t('errors.no_connection')}</p>
            <Link
              to="/connections"
              className="mt-2 inline-block text-primary underline underline-offset-2"
            >
              {t('chat.panel.addConnection')}
            </Link>
          </div>
        ) : inspect.isPending || inspect.error ? (
          <div className="p-3">
            <QueryStatus
              isPending={inspect.isPending && !isGenerating}
              error={inspect.error}
              onRetry={() => void inspect.refetch()}
            />
            {isGenerating && !inspect.data && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('inspector.noData')}
              </p>
            )}
          </div>
        ) : inspect.data && isInspectPlaceholder(inspect.data) ? (
          <PlaceholderCard
            rows={[
              ['chatId', inspect.data.chatId],
              ['parentId', inspect.data.parentId],
              ['connectionId', inspect.data.connectionId],
              ['model', inspect.data.model],
              ['layoutMode', inspect.data.layoutMode],
            ]}
          />
        ) : data ? (
          <InspectorBody
            data={data}
            tab={tab}
            view={view}
            focusId={focusId}
            chatId={chat.id}
            parentId={chat.headNodeId}
            connectionId={connectionId}
            model={model}
            onView={setView}
            onJump={(id) => {
              setView('strict');
              setFocusId(id);
            }}
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">{t('inspector.noData')}</p>
        )}
      </div>
    </div>
  );
}

function InspectorBody({
  data,
  tab,
  view,
  focusId,
  chatId,
  parentId,
  connectionId,
  model,
  onView,
  onJump,
}: {
  data: InspectData;
  tab: InspectorTab;
  view: 'current' | 'strict';
  focusId: string | null;
  chatId: string;
  parentId: string | null;
  connectionId: string | null;
  model: string | null;
  onView: (view: 'current' | 'strict') => void;
  onJump: (segmentId: string) => void;
}) {
  const { t } = useTranslation();
  const warnings = [...(data.warnings ?? []), ...(data.layout?.warnings ?? [])];

  if (tab === 'worldInfo') return <WorldInfoView wi={data.wi} />;
  if (tab === 'request') return <RequestView request={data.request} />;
  if (tab === 'compare') {
    return <CompareView target={{ chatId, parentId, connectionId, model }} />;
  }

  const strictIr = data.strictIr ?? null;
  const showing = view === 'strict' && strictIr ? strictIr : data.ir;

  return (
    <div>
      {warnings.length > 0 && (
        <ul className="space-y-1 border-b border-border bg-destructive/5 px-3 py-2">
          {warnings.map((warning, index) => (
            <li key={index} className="flex gap-1.5 text-[11px] leading-relaxed text-destructive">
              <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
              <span className="min-w-0">{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {strictIr && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="flex gap-1 rounded-md bg-muted/60 p-0.5">
            {(['current', 'strict'] as const).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => onView(item)}
                className={cn(
                  'cursor-pointer rounded px-2 py-0.5 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  view === item
                    ? 'bg-card font-medium text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`inspector.view.${item}`)}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-muted-foreground">
            {data.diff
              ? [
                  t('inspector.diff.moved', { total: data.diff.moved.length }),
                  t('inspector.diff.clamped', { total: data.diff.clamped.length }),
                  t('inspector.diff.unchanged', { total: data.diff.unchanged }),
                ].join(' · ')
              : t('inspector.diff.none')}
          </span>
        </div>
      )}

      <div className="px-3 pt-2 text-[11px] text-muted-foreground">
        {t('inspector.segments.count', { total: showing.segments.length })}
      </div>

      {view === 'strict' && strictIr ? (
        <SegmentList ir={strictIr} focusId={focusId} />
      ) : (
        <SegmentList
          ir={data.ir}
          breakpoints={data.layout?.breakpoints ?? []}
          moves={data.layout?.moves ?? []}
          focusId={focusId}
          {...(strictIr ? { onJump } : {})}
        />
      )}
    </div>
  );
}

/** inspect 端点尚未接入组装流水线时的占位态 */
function PlaceholderCard({ rows }: { rows: [string, string | null][] }) {
  const { t } = useTranslation();
  return (
    <div className="m-3 rounded-lg border border-dashed border-border p-4">
      <p className="text-sm font-medium">{t('inspector.todoTitle')}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {t('inspector.todoHint')}
      </p>
      <dl className="mt-3 space-y-1 font-mono text-[11px]">
        {rows.map(([key, value]) => (
          <div key={key} className="flex gap-2">
            <dt className="w-24 shrink-0 text-muted-foreground">{key}</dt>
            <dd className="min-w-0 break-all">{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</div>
      <div className="text-xs tabular-nums">
        {value === null ? '—' : typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}
