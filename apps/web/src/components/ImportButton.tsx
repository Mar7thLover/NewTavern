import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, type ButtonProps } from './ui/button';
import { uploadFile } from '../lib/api';
import { cn } from '../lib/utils';

interface FileFailure {
  file: string;
  message: string;
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

  const handleFiles = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (inputRef.current) inputRef.current.value = '';
    if (files.length === 0) return;

    setFailures([]);
    const nextFailures: FileFailure[] = [];
    try {
      for (const [index, file] of files.entries()) {
        setProgress({ current: index + 1, total: files.length });
        try {
          await uploadFile(endpoint, file);
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
        {busy && (
          <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />
        )}
        {busy
          ? progress.total > 1
            ? t('common.importingProgress', progress)
            : t('common.importing')
          : (label ?? t('common.import'))}
      </Button>
      {failures.length > 0 && (
        <div
          role="alert"
          className="w-full max-w-md rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-left text-xs text-destructive"
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
