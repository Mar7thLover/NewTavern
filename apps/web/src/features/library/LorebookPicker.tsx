import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { QueryStatus } from './shared';
import { Badge } from '../../components/ui/badge';
import { useLorebooks } from '../../lib/api';
import { cn } from '../../lib/utils';

export interface LorebookPickerProps {
  /** 已选中的书 id（顺序即写回顺序） */
  selected: readonly string[];
  onChange: (bookIds: string[]) => void;
  disabled?: boolean;
  className?: string;
}

/** 世界书多选：全局书（设置页）与聊天书（会话面板）共用 */
export function LorebookPicker({ selected, onChange, disabled, className }: LorebookPickerProps) {
  const { t } = useTranslation();
  const books = useLorebooks();
  if (books.isPending || books.error) {
    return (
      <QueryStatus
        isPending={books.isPending}
        error={books.error}
        onRetry={() => void books.refetch()}
      />
    );
  }

  const list = books.data ?? [];
  if (list.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('worldInfo.noBooks')}{' '}
        <Link to="/lorebooks" className="text-primary underline underline-offset-2">
          {t('nav.lorebooks')}
        </Link>
      </p>
    );
  }

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  };

  return (
    <ul
      className={cn(
        'max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border bg-background',
        className,
      )}
    >
      {list.map((book) => {
        const checked = selected.includes(book.id);
        return (
          <li key={book.id}>
            <label
              className={cn(
                'flex cursor-pointer items-center gap-2.5 px-2.5 py-2 text-sm transition-colors hover:bg-accent/50',
                disabled && 'pointer-events-none opacity-50',
              )}
            >
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                checked={checked}
                disabled={disabled}
                onChange={() => toggle(book.id)}
              />
              <span className="min-w-0 flex-1 truncate">{book.name}</span>
              <Badge variant="outline">{t(`library.lorebooks.scopes.${book.scope}`)}</Badge>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {book.entryCount}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
