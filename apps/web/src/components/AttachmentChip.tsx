import { RotateCw, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { extensionLabel, type AttachmentKind } from './AttachmentFiles';
import { cn } from '../lib/utils';

/**
 * 附件的共用小件（托盘、消息、编辑态都用）。
 *
 * 只用槽位与工具类：主题通过 `[data-part='attachment']`（带 `data-kind` / `data-status` / `data-context`）
 * 与下面几个子挂点改形态，组件不知道差别。
 */

/** 文档类型字：一枚小签，写扩展名（PDF / MD / CSV） */
export function ExtensionTile({
  name,
  kind,
  className,
}: {
  name: string | undefined;
  kind: AttachmentKind;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-part="attachment-ext"
      className={cn(
        'edge-rule-strong rounded-control grid h-9 w-9 shrink-0 place-items-center border font-mono text-[10px] leading-none font-semibold tracking-wider text-ink-2',
        className,
      )}
    >
      {extensionLabel(name, kind)}
    </span>
  );
}

/** 附件角上 / 行尾的小圆键（移除、重试）。可视 22px，点击区向外扩到 34px */
export function AttachmentIconButton({
  label,
  onClick,
  tone = 'remove',
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: 'remove' | 'retry';
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-part="attachment-button"
      data-tone={tone}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        'focus-ring relative inline-grid size-[22px] shrink-0 cursor-pointer place-items-center rounded-pill border',
        'edge-rule bg-raised text-ink-2 shadow-control transition-colors hover:text-ink',
        'after:absolute after:-inset-1.5 after:content-[""] [&_svg]:size-3',
        tone === 'retry' && 'text-danger hover:text-danger',
        className,
      )}
    >
      {children ?? (tone === 'retry' ? <RotateCw aria-hidden /> : <X aria-hidden />)}
    </button>
  );
}

/** 文档小片：类型字 + 名字 + 一行元信息；可以是链接（消息里点开原文件）也可以是静态块（托盘） */
export function AttachmentDocumentChip({
  name,
  kind,
  meta,
  metaTone = 'muted',
  href,
  context,
  status,
  progress,
  actions,
  className,
}: {
  name: string;
  kind: AttachmentKind;
  meta: ReactNode;
  metaTone?: 'muted' | 'danger';
  /** 提供时整片是一个新窗口打开的链接 */
  href?: string;
  context: 'tray' | 'message' | 'edit';
  status?: 'uploading' | 'done' | 'error';
  /** 0–1，上传中时画底部进度线 */
  progress?: number;
  actions?: ReactNode;
  className?: string;
}) {
  const body = (
    <>
      <ExtensionTile name={name} kind={kind} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] leading-snug text-ink">{name}</span>
        <span
          className={cn(
            'mt-0.5 block truncate text-[11px] leading-snug tabular-nums',
            metaTone === 'danger' ? 'text-danger' : 'text-ink-3',
          )}
        >
          {meta}
        </span>
      </span>
    </>
  );

  const shared = cn(
    'relative flex min-w-0 items-center gap-2.5 overflow-hidden rounded-control border bg-control py-2 ps-2 text-left',
    status === 'error' ? 'border-danger' : 'edge-rule',
    actions ? 'pe-2' : 'pe-3',
    className,
  );

  const progressLine =
    status === 'uploading' ? (
      <span
        aria-hidden
        data-part="attachment-progress"
        className="absolute inset-x-0 bottom-0 h-0.5 bg-edge"
      >
        <span
          className="block h-full bg-accent transition-[width]"
          style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
        />
      </span>
    ) : null;

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-part="attachment"
        data-kind={kind}
        data-context={context}
        className={cn(
          shared,
          'focus-ring cursor-pointer transition-colors hover:border-edge-strong',
        )}
      >
        {body}
        {actions}
      </a>
    );
  }

  return (
    <div
      data-part="attachment"
      data-kind={kind}
      data-context={context}
      data-status={status}
      className={shared}
    >
      {body}
      {actions && <span className="flex shrink-0 items-center gap-1.5">{actions}</span>}
      {progressLine}
    </div>
  );
}
