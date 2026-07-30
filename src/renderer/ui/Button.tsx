import type { ComponentProps } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

const button = cva(
  'inline-flex items-center justify-center gap-1.5 rounded font-mono transition-colors ' +
    'disabled:pointer-events-none disabled:opacity-40 focus-visible:outline-none ' +
    'focus-visible:ring-1 focus-visible:ring-accent',
  {
    variants: {
      variant: {
        default: 'bg-border text-fg hover:bg-faint',
        ghost: 'bg-transparent text-muted hover:text-fg hover:bg-border',
      },
      size: {
        sm: 'h-6 px-2 text-[11px]',
        icon: 'h-6 w-6 text-sm',
      },
    },
    defaultVariants: { variant: 'default', size: 'sm' },
  },
)

export function Button({
  className,
  variant,
  size,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant, size }), className)} {...props} />
}
