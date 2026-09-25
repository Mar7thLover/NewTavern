import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { assetUrl, type StudioMarker } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useSignature, type AvatarRole, type EmptyIllustrationKind } from '../../themes/signature';

export function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function errorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

/** 库列表里工作台实体的小标：从库里复制来的是「工作台副本」，工作台里新建的是「工作台新建」 */
export function studioBadgeKey(studio: StudioMarker): 'library.studioCopy' | 'library.studioOwn' {
  return studio.sourceId !== null ? 'library.studioCopy' : 'library.studioOwn';
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
    <div data-part="page-header" className="mb-8 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-display text-[28px] leading-tight font-light tracking-tight">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-sm text-ink-2">{subtitle}</p>}
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
        className="rounded-card border-danger bg-danger-soft border p-4 text-sm text-danger"
      >
        <p>{t('common.loadFailed', { message: errorMessage(error) })}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="focus-ring mt-2 cursor-pointer font-medium underline-offset-2 hover:underline"
          >
            {t('common.retry')}
          </button>
        )}
      </div>
    );
  }
  if (isPending) {
    return <p className="py-8 text-center text-sm text-ink-3">{t('common.loading')}</p>;
  }
  return null;
}

/** 空列表引导：插画交给主题（素没有插画，只留一行大字） */
export function EmptyState({
  title,
  hint,
  action,
  kind = 'characters',
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  kind?: EmptyIllustrationKind;
}) {
  const { EmptyIllustration } = useSignature();
  return (
    <div
      data-part="empty-state"
      className="flex flex-col items-center gap-4 px-6 py-20 text-center"
    >
      <EmptyIllustration kind={kind} />
      <p className="font-display max-w-xl text-[28px] leading-snug font-light tracking-tight">
        {title}
      </p>
      {hint && <p className="max-w-md text-sm leading-relaxed text-ink-2">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** 头像：有资产用图片，否则首字占位；外框形状由主题的 AvatarFrame 决定 */
export function Avatar({
  name,
  assetId,
  role = 'character',
  className,
  textClassName,
}: {
  name: string;
  assetId: string | null;
  role?: AvatarRole;
  className?: string;
  textClassName?: string;
}) {
  const { AvatarFrame } = useSignature();
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? '?';
  return (
    <AvatarFrame role={role} className={cn('flex items-center justify-center', className)}>
      {assetId ? (
        <img src={assetUrl(assetId)} alt={name} loading="lazy" className="size-full object-cover" />
      ) : (
        <span aria-hidden className={cn('font-medium select-none', textClassName)}>
          {initial}
        </span>
      )}
    </AvatarFrame>
  );
}
