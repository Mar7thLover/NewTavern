import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

/** 也用于把 `<a>`（如导出下载链接）渲染成按钮外观 */
export const buttonVariants = cva(
  'focus-ring inline-flex cursor-pointer items-center justify-center gap-2 text-sm font-medium disabled:pointer-events-none',
  {
    variants: {
      // 形态全部来自 materials.css 的材质类，主题可整体替换
      variant: {
        default: 'action-primary',
        outline: 'action-quiet',
        ghost: 'action-ghost',
        destructive: 'action-danger-solid',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-9 px-4',
        lg: 'h-10 px-6',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
