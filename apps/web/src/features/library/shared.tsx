import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { assetUrl } from '../../lib/api';
import { cn } from '../../lib/utils';

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/** 库页面标题栏：标题 + 计数 + 右侧操作（窄屏换行） */
export function LibraryHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-start gap-2">{actions}</div>}
    </div>
  );
}

/** 列表查询的加载/失败状态；返回 null 表示可以渲染数据 */
export function QueryStatus({
  isPending,
  error,
  onRetry,
}: {
  isPending: boolean;
  error: unknown;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  if (error) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive"
      >
        <p>{t('common.loadFailed', { message: errorMessage(error) })}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 cursor-pointer font-medium underline-offset-2 hover:underline"
          >
            {t('common.retry')}
          </button>
        )}
      </div>
    );
  }
  if (isPending) {
    return <p className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>;
  }
  return null;
}

/** 空列表引导 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-14 text-center">
      <p className="text-lg font-semibold">{title}</p>
      {hint && <p className="max-w-md text-sm text-muted-foreground">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** 头像：有资产用图片，否则首字占位 */
export function Avatar({
  name,
  assetId,
  className,
  textClassName,
}: {
  name: string;
  assetId: string | null;
  className?: string;
  textClassName?: string;
}) {
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center overflow-hidden bg-muted text-muted-foreground',
        className,
      )}
    >
      {assetId ? (
        <img src={assetUrl(assetId)} alt={name} loading="lazy" className="size-full object-cover" />
      ) : (
        <span aria-hidden className={cn('font-semibold select-none', textClassName)}>
          {initial}
        </span>
      )}
    </div>
  );
}
