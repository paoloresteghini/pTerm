import type { ComponentProps } from 'react'
import { Button as ShadcnButton } from '@/components/ui/button'
import { cn } from '../lib/cn'

type LegacyButtonProps = Omit<ComponentProps<typeof ShadcnButton>, 'variant' | 'size'> & {
  variant?: 'default' | 'ghost'
  size?: 'sm' | 'icon'
}

/**
 * Compatibility layer for the app's existing controls. New code can import
 * shadcn directly, while established dialogs and toolbars get the same
 * primitives without a behavior-changing rewrite.
 */
export function Button({
  className,
  variant = 'default',
  size = 'sm',
  ...props
}: LegacyButtonProps) {
  return (
    <ShadcnButton
      variant={variant === 'ghost' ? 'ghost' : 'secondary'}
      size={size === 'icon' ? 'icon-xs' : 'xs'}
      className={cn('font-mono text-[11px]', className)}
      {...props}
    />
  )
}
