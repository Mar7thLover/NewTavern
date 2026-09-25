import { cn } from '../../lib/utils';

export interface SegmentedItem<T extends string> {
  value: T;
  label: string;
  /** 右侧附注（如计数） */
  note?: string;
}

export interface SegmentedProps<T extends string> {
  items: readonly SegmentedItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** 无障碍名称（用在 role="tablist" 上） */
  label?: string;
  size?: 'sm' | 'md';
  /** 每项等宽铺满 */
  stretch?: boolean;
  className?: string;
}

/**
 * 分段控件 / 页签：当前项用 2px 强调色下划线标记，**不填底**。
 * 形态由 `--accent` 与 `--edge` 决定，需要方块/胶囊形态的主题覆盖 `.segmented-item` 即可。
 */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  size = 'md',
  stretch = false,
  className,
}: SegmentedProps<T>) {
  return (
    <div
      role="tablist"
      data-part="tabs"
      aria-label={label}
      // overflow-x:auto 会连带让 y 也变成 auto：选中项的 -mb-px 下划线多出 1px，Windows 上就冒出纵向滚动条
      className={cn(
        'edge-rule flex min-w-0 gap-4 overflow-x-auto overflow-y-hidden border-b',
        className,
      )}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            data-part="tab"
            data-active={active}
            aria-selected={active}
            onClick={() => onChange(item.value)}
            className={cn(
              'segmented-item focus-ring-inset -mb-px cursor-pointer border-b-2 whitespace-nowrap transition-colors',
              size === 'sm' ? 'pb-1.5 text-[11px]' : 'pb-2 text-xs',
              stretch && 'flex-1',
              active
                ? 'border-accent font-medium text-ink'
                : 'border-transparent text-ink-2 hover:text-ink',
            )}
          >
            {item.label}
            {item.note !== undefined && (
              <span className="ms-1.5 text-ink-3 tabular-nums">{item.note}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
