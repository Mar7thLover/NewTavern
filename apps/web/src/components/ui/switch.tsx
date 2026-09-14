import { cn } from '../../lib/utils';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** 无障碍名称；与外部 label 配合时传 labelledBy */
  label?: string;
  labelledBy?: string;
  disabled?: boolean;
  className?: string;
}

/** 开关：原生 button + role="switch"，键盘与读屏可用 */
export function Switch({
  checked,
  onChange,
  label,
  labelledBy,
  disabled = false,
  className,
}: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5 transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:pointer-events-none disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-muted border-border',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-4 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}

/** 一行式开关：左侧标题 + 说明，右侧开关 */
export function SwitchRow({
  title,
  hint,
  checked,
  onChange,
  disabled,
}: {
  title: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <div className="text-sm">{title}</div>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        label={title}
        {...(disabled === undefined ? {} : { disabled })}
      />
    </div>
  );
}
