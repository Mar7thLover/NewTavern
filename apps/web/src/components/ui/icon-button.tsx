import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../../lib/utils';

const iconButtonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      variant: {
        ghost: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        solid: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline:
          'border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        destructive: 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
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
