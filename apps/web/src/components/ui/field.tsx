import { cva, type VariantProps } from 'class-variance-authority';
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

import { cn } from '../../lib/utils';

/** 表单控件的共同外观；单独导出供自定义元素（如自适应 textarea）复用 */
export const fieldVariants = cva(
  'w-full rounded-md border border-input bg-background text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive',
  {
    variants: {
      size: {
        sm: 'h-8 px-2.5 text-xs',
        md: 'h-9 px-3',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

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

/** 原生 select：自带键盘与移动端体验，只换外观 */
export function Select({ className, size, ...props }: SelectProps) {
  return (
    <select
      className={cn(fieldVariants({ size }), 'cursor-pointer appearance-none pr-7', className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' d='M3 4.5 6 7.5 9 4.5'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'right 0.5rem center',
        backgroundSize: '0.85rem',
      }}
      {...props}
    />
  );
}

/** 小节标题：会话面板与连接表单共用 */
export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="mb-1.5 block text-xs font-medium tracking-wide text-muted-foreground uppercase"
    >
      {children}
    </label>
  );
}
