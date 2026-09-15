import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../../lib/utils';

const iconButtonVariants = cva(
  'focus-ring inline-flex shrink-0 cursor-pointer items-center justify-center disabled:pointer-events-none',
  {
    variants: {
      variant: {
        ghost: 'action-ghost',
        solid: 'action-primary',
        outline: 'action-quiet',
        destructive: 'action-danger',
      },
      size: {
        xs: 'size-6 [&_svg]:size-3.5',
        sm: 'size-7 [&_svg]:size-4',
        md: 'size-9 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'sm' },
  },
);

export interface IconButtonProps
  extends
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'size'>,
    VariantProps<typeof iconButtonVariants> {
  /** 无障碍名称，同时作为原生 tooltip */
  label: string;
  children: ReactNode;
}

/** 纯图标按钮：始终带 aria-label + title，避免操作条出现无名按钮 */
export function IconButton({ className, variant, size, label, ...props }: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...props}
    />
  );
}
