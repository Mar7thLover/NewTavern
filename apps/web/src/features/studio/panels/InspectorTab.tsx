import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Badge } from '../../../components/ui/badge';
import { IconButton } from '../../../components/ui/icon-button';
import { Segmented } from '../../../components/ui/segmented';
import {
  ApiError,
  queryKeys,
  useGenerationDefault,
  type ChatDetail,
  type LayoutMode,
} from '../../../lib/api';
import { inspectWithDraft, type StudioDraftBody } from '../../../lib/api-studio';
import { cn } from '../../../lib/utils';
import { RequestView } from '../../inspector/RequestView';
import { SegmentList } from '../../inspector/SegmentList';
import { isInspectPlaceholder, type InspectResponse } from '../../inspector/types';
import { WorldInfoView } from '../../inspector/WorldInfoView';
import { QueryStatus } from '../../library/shared';

const TABS = ['segments', 'worldInfo', 'request'] as const;
type Tab = (typeof TABS)[number];

/** 草稿停止变化这么久之后才重新组装 */
const DEBOUNCE_MS = 600;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * 工作台的检查器页签：测试会话按**当前草稿**组装（`POST /api/chats/:id/inspect` 带 draft），
 * 复用检查器的段列表 / 世界书 / 请求体视图。草稿一变（去抖后）就重新组装。
 */
export function InspectorTab({
  chat,
  revision,
  dirty,
  getDraft,
  isGenerating,
  active,
}: {
  chat: ChatDetail;
  /** 草稿版本号：变了就重取 */
  revision: number;
  dirty: boolean;
  getDraft: () => StudioDraftBody | undefined;
  isGenerating: boolean;
  /** 页签可见时才取数 */
  active: boolean;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('segments');
  const generationDefault = useGenerationDefault();
  const debouncedRevision = useDebounced(revision, DEBOUNCE_MS);

  const layoutMode: LayoutMode = chat.overrides?.layoutMode ?? 'strict';
  const connectionId = chat.overrides?.connectionId ?? generationDefault.data?.connectionId ?? null;
  const model = chat.overrides?.model ?? generationDefault.data?.model ?? null;
  const params = { chatId: chat.id, parentId: chat.headNodeId, layoutMode, connectionId, model };

  const inspect = useQuery({
    // [2] 仍是 'inspect'：保存后与各会话的检查器缓存一起失效
    queryKey: [
      ...queryKeys.chatInspect(chat.id, {
        parentId: chat.headNodeId,
        layoutMode,
        connectionId,
        model,
      }),
      { studioDraft: debouncedRevision },
    ],
    queryFn: () => inspectWithDraft<InspectResponse>(params, getDraft()),
    enabled: active && !isGenerating && generationDefault.isSuccess,
    refetchOnWindowFocus: false,
    retry: false,
    placeholderData: (previous) => previous,
  });

  const data = inspect.data && !isInspectPlaceholder(inspect.data) ? inspect.data : null;
  const noConnection = inspect.error instanceof ApiError && inspect.error.code === 'no_connection';
  const warnings = data ? [...(data.warnings ?? []), ...(data.layout?.warnings ?? [])] : [];

  return (
    <div data-part="inspector" className="flex h-full min-h-0 flex-col">
      <header className="edge-rule shrink-0 space-y-2.5 border-b px-3 py-2.5">
        <div className="flex items-center gap-2">
          <Badge variant={dirty ? 'default' : 'muted'}>
            {dirty ? t('studio.inspector.draft') : t('studio.inspector.saved')}
          </Badge>
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-3">
            {model ?? t('chat.panel.connectionUnset')}
          </span>
          <span className="text-xs tabular-nums">
            {data ? t('studio.inspector.tokens', { n: data.tokenEstimate.toLocaleString() }) : '—'}
          </span>
          <IconButton
            label={t('inspector.refresh')}
            variant="outline"
            disabled={isGenerating || inspect.isFetching}
            onClick={() => void inspect.refetch()}
          >
            <RefreshCw aria-hidden className={cn(inspect.isFetching && 'opacity-40')} />
          </IconButton>
        </div>
        <Segmented
          value={tab}
          onChange={setTab}
          items={TABS.map((item) => ({ value: item, label: t(`inspector.tabs.${item}`) }))}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isGenerating && (
          <p className="edge-rule border-b px-3 py-2 text-xs text-ink-2">
            {t('inspector.generatingHint')}
          </p>
        )}
        {noConnection ? (
          <div className="edge-rule m-3 border-t pt-4 text-sm">
            <p>{t('errors.no_connection')}</p>
            <Link
              to="/connections"
              className="mt-2 inline-block text-accent underline underline-offset-2"
            >
              {t('chat.panel.addConnection')}
            </Link>
          </div>
        ) : !data ? (
          <div className="p-3">
            <QueryStatus
              isPending={inspect.isPending && active}
              error={inspect.error}
              onRetry={() => void inspect.refetch()}
            />
          </div>
        ) : (
          <>
            {warnings.length > 0 && (
              <ul className="edge-rule space-y-1 border-b bg-danger-soft px-3 py-2">
                {warnings.map((warning, index) => (
                  <li key={index} className="flex gap-1.5 text-[11px] leading-relaxed text-danger">
                    <AlertTriangle aria-hidden className="mt-0.5 size-3 shrink-0" />
                    <span className="min-w-0">{warning}</span>
                  </li>
                ))}
              </ul>
            )}
            {tab === 'segments' && (
              <SegmentList
                ir={data.ir}
                breakpoints={data.layout?.breakpoints ?? []}
                moves={data.layout?.moves ?? []}
              />
            )}
            {tab === 'worldInfo' && <WorldInfoView wi={data.wi} />}
            {tab === 'request' && <RequestView request={data.request} />}
          </>
        )}
      </div>
    </div>
  );
}
