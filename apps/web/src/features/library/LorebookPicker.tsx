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
  /** 选中后不能取消的书（工作台 lorebook 测试会话里正在编辑的那本），附 `lockedHint` 说明 */
  lockedIds?: readonly string[];
  lockedHint?: string;
  className?: string;
}

/** 世界书多选：全局书（设置页）与聊天书（会话面板）共用 */
export function LorebookPicker({
  selected,
  onChange,
  disabled,
  lockedIds,
  lockedHint,
  className,
}: LorebookPickerProps) {
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
      <p className="text-xs text-ink-2">
        {t('worldInfo.noBooks')}{' '}
        <Link to="/lorebooks" className="text-accent underline underline-offset-2">
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
        'rounded-card edge-rule max-h-56 divide-y divide-edge overflow-y-auto border',
        className,
      )}
    >
      {list.map((book) => {
        const checked = selected.includes(book.id);
        const locked = checked && (lockedIds?.includes(book.id) ?? false);
        return (
          <li key={book.id}>
            <label
              title={locked ? lockedHint : undefined}
              className={cn(
                'flex cursor-pointer items-center gap-2.5 px-2.5 py-2 text-sm transition-colors hover:text-accent',
                disabled && 'pointer-events-none opacity-50',
                locked && 'cursor-default hover:text-ink',
              )}
            >
              <input
                type="checkbox"
                className="size-4 shrink-0 accent-primary"
                checked={checked}
                disabled={disabled || locked}
                onChange={() => toggle(book.id)}
              />
              <span className="min-w-0 flex-1 truncate">{book.name}</span>
              <Badge variant="outline">{t(`library.lorebooks.scopes.${book.scope}`)}</Badge>
              <span className="shrink-0 text-[11px] text-ink-2 tabular-nums">
                {book.entryCount}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
