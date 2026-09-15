import { cva, type VariantProps } from 'class-variance-authority';
import { ChevronDown } from 'lucide-react';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

import { cn } from '../../lib/utils';

/** 表单控件的共同外观；单独导出供自定义元素（如自适应 textarea）复用 */
export const fieldVariants = cva('field w-full text-sm', {
  variants: {
    size: {
      sm: 'h-8 px-2.5 text-xs',
      md: 'h-9 px-3',
    },
  },
  defaultVariants: { size: 'md' },
});

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>, VariantProps<typeof fieldVariants> {}

export function Input({ className, size, ...props }: InputProps) {
  return <input className={cn(fieldVariants({ size }), className)} {...props} />;
}

export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <textarea
      className={cn(
        fieldVariants({ size: 'md' }),
        'h-auto resize-y py-2 leading-relaxed',
        className,
      )}
      {...props}
    />
  );
}

export interface SelectProps
  extends
    Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'>,
    VariantProps<typeof fieldVariants> {}

/**
 * 原生 select：自带键盘与移动端体验，只换外观。
 * 箭头是叠在上面的 lucide 图标（颜色跟 --ink-2 走）；data URI 里的 SVG 读不到 currentColor，黑模式会看不见。
 * className 作用在外层（宽度等），select 本身铺满。
 */
export function Select({ className, size, ...props }: SelectProps) {
  return (
    <span className={cn('relative block w-full', className)}>
      <select
        className={cn(fieldVariants({ size }), 'cursor-pointer appearance-none pr-7')}
        {...props}
      />
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-ink-2"
      />
    </span>
  );
}

/** 小节标题：会话面板与连接表单共用 */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-[11px] font-medium tracking-[0.08em] text-ink-3 uppercase"
    >
      {children}
    </label>
  );
}
