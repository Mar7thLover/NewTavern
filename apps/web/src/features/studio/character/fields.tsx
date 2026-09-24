import { estimateTokens } from '@newtavern/core';
import { ChevronRight } from 'lucide-react';
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { useTranslation } from 'react-i18next';

import { FieldLabel, fieldVariants } from '../../../components/ui/field';
import { cn } from '../../../lib/utils';

/** 自适应高度的上限（超过后框内滚动） */
const MAX_AUTO_HEIGHT = 560;

export interface AutoTextareaProps extends Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange'
> {
  value: string;
  onChange: (value: string) => void;
  /** 最少几行高 */
  minRows?: number;
}

/** 随内容长高的文本框（到上限后框内滚动）；外观同 `.field` */
export function AutoTextarea({
  value,
  onChange,
  minRows = 3,
  className,
  ...props
}: AutoTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    const border = element.offsetHeight - element.clientHeight;
    element.style.height = `${Math.min(element.scrollHeight + border, MAX_AUTO_HEIGHT)}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      rows={minRows}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        fieldVariants({ size: 'md' }),
        'h-auto resize-y py-2 leading-relaxed',
        className,
      )}
      {...props}
    />
  );
}

/** 长文本字段：标签 + 自适应文本框 + token 估算 */
export function LongTextField({
  label,
  hint,
  value,
  onChange,
  minRows,
  placeholder,
  actions,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  minRows?: number;
  placeholder?: string;
  /** 标签行右侧的小操作 */
  actions?: ReactNode;
}) {
  const { t } = useTranslation();
  const id = useId();
  const tokens = useMemo(() => estimateTokens(value), [value]);
  return (
    <div>
      <div className="flex items-end justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        {actions}
      </div>
      <AutoTextarea
        id={id}
        value={value}
        onChange={onChange}
        minRows={minRows}
        placeholder={placeholder}
      />
      <div className="mt-1 flex items-start justify-between gap-3 text-[11px] text-ink-3">
        <span className="min-w-0">{hint}</span>
        <span className="shrink-0 tabular-nums">{t('studio.tokens', { n: tokens })}</span>
      </div>
    </div>
  );
}

/** 编辑器的一个分区；可折叠 */
export function EditorSection({
  title,
  children,
  collapsible = false,
  defaultOpen = true,
  note,
}: {
  title: string;
  children: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** 标题右侧的附注（如计数） */
  note?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const shown = !collapsible || open;
  return (
    <section className="edge-rule border-t pt-4 pb-6 first:border-t-0 first:pt-0">
      {collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
          className="focus-ring rounded-control mb-3 flex w-full cursor-pointer items-center gap-1.5 text-left"
        >
          <ChevronRight
            aria-hidden
            className={cn('motion-transform size-3.5 text-ink-3', open && 'rotate-90')}
          />
          <h2 className="font-display text-sm font-medium">{title}</h2>
          {note && <span className="ms-auto text-[11px] text-ink-3">{note}</span>}
        </button>
      ) : (
        <div className="mb-3 flex items-baseline gap-2">
          <h2 className="font-display text-sm font-medium">{title}</h2>
          {note && <span className="ms-auto text-[11px] text-ink-3">{note}</span>}
        </div>
      )}
      {shown && (
        <div id={bodyId} className="space-y-4">
          {children}
        </div>
      )}
    </section>
  );
}
