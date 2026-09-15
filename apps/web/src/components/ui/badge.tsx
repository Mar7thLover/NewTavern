import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/utils';

const badgeVariants = cva(
  'inline-flex shrink-0 items-center px-2 py-0.5 text-[11px] font-medium leading-none whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'chip-accent',
        muted: 'chip',
        outline: 'chip-outline',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
