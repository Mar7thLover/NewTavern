import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from './ConfirmDialog';
import { Button, type ButtonProps } from './ui/button';
import { uploadFile, useSetRegexOwnerEnabled, type RegexOwnerInput } from '../lib/api';
import { cn } from '../lib/utils';

interface FileFailure {
  file: string;
  message: string;
}

/**
 * 导入接口在「这个文件自带正则」时回的摘要。脚本已经收进正则库但**还没启用**，
 * 由这里问一句再开（M3 契约 §3.2 修正：默认导入、询问是否加载）。
 */
interface EmbeddedRegex {
  scope: RegexOwnerInput['scope'];
  ownerId: string;
  ownerName: string;
  count: number;
}

function readEmbeddedRegex(result: unknown): EmbeddedRegex | null {
  const value = (result as { embeddedRegex?: unknown } | null)?.embeddedRegex;
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.ownerId !== 'string' || typeof record.count !== 'number') return null;
  if (record.scope !== 'character' && record.scope !== 'preset' && record.scope !== 'book') {
    return null;
  }
  return {
    scope: record.scope,
    ownerId: record.ownerId,
    ownerName: typeof record.ownerName === 'string' ? record.ownerName : '',
    count: record.count,
  };
}

export interface ImportButtonProps {
  /** multipart 上传端点（字段名 `file`） */
  endpoint: string;
  /** input accept，如 `.png,.charx,.json` */
  accept: string;
  multiple?: boolean;
  /** 导入结束后 invalidate 的查询 */
  invalidateKey: QueryKey;
  label?: string;
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  className?: string;
  /** 错误列表的对齐方式 */
  align?: 'start' | 'end' | 'center';
}

/** 统一的文件导入按钮：隐藏 file input，多文件逐个上传，失败时展示服务端 message */
export function ImportButton({
  endpoint,
  accept,
  multiple = true,
  invalidateKey,
  label,
  size = 'sm',
  variant = 'default',
  className,
  align = 'end',
}: ImportButtonProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [failures, setFailures] = useState<FileFailure[]>([]);
  /** 这批文件自带的正则：导入完统一问一次「要不要现在启用」 */
  const [pendingRegex, setPendingRegex] = useState<EmbeddedRegex[]>([]);
  const setOwnerEnabled = useSetRegexOwnerEnabled();

  const handleFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (inputRef.current) inputRef.current.value = '';
    if (files.length === 0) return;

    setFailures([]);
    setPendingRegex([]);
    const nextFailures: FileFailure[] = [];
    const embedded: EmbeddedRegex[] = [];
    try {
      for (const [index, file] of files.entries()) {
        setProgress({ current: index + 1, total: files.length });
        try {
          const result = await uploadFile(endpoint, file);
          const regex = readEmbeddedRegex(result);
          if (regex) embedded.push(regex);
        } catch (error) {
          nextFailures.push({
            file: file.name,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      setProgress(null);
      setFailures(nextFailures);
      setPendingRegex(embedded);
      if (nextFailures.length < files.length) {
        await queryClient.invalidateQueries({ queryKey: invalidateKey });
      }
    }
  };

  const busy = progress !== null;

  return (
    <div
      className={cn(
        'flex flex-col gap-2',
        align === 'end' && 'items-end',
        align === 'start' && 'items-start',
        align === 'center' && 'items-center',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(event) => void handleFiles(event.target.files)}
      />
      <Button
        type="button"
        size={size}
        variant={variant}
        className={className}
        disabled={busy}
        aria-busy={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy
          ? progress.total > 1
            ? t('common.importingProgress', progress)
            : t('common.importing')
          : (label ?? t('common.import'))}
      </Button>
      <ConfirmDialog
        open={pendingRegex.length > 0}
        title={t('regex.embedded.askTitle')}
        description={t('regex.embedded.askBody', {
          count: pendingRegex.reduce((total, item) => total + item.count, 0),
          names: pendingRegex.map((item) => item.ownerName).join('、'),
        })}
        confirmLabel={t('regex.embedded.enable')}
        cancelLabel={t('regex.embedded.later')}
        pending={setOwnerEnabled.isPending}
        onCancel={() => setPendingRegex([])}
        onConfirm={() => {
          const targets = pendingRegex;
          setPendingRegex([]);
          for (const item of targets) {
            setOwnerEnabled.mutate({ scope: item.scope, ownerId: item.ownerId, enabled: true });
          }
        }}
      />

      {failures.length > 0 && (
        <div
          role="alert"
          className="rounded-card border-danger bg-danger-soft w-full max-w-md border px-3 py-2 text-left text-xs text-danger"
        >
          <div className="mb-1 flex items-center justify-between gap-2 font-medium">
            <span>{t('common.importFailed')}</span>
            <button
              type="button"
              className="cursor-pointer underline-offset-2 hover:underline"
              onClick={() => setFailures([])}
            >
              {t('common.dismiss')}
            </button>
          </div>
          <ul className="space-y-0.5">
            {failures.map((failure, index) => (
              <li key={`${failure.file}-${index}`} className="break-words">
                <span className="font-medium">{failure.file}</span>: {failure.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
