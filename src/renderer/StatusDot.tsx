import type { TabState } from '../shared/status'
import { cn } from './lib/cn'

/**
 * The only place a state becomes a colour.
 *
 * `unknown` is drawn hollow — a ring, not a fill — because it means "this
 * should have a state and does not", which is what a claude tab with a broken
 * hook install looks like. A tab with no state at all draws nothing, which is
 * why the caller passes null rather than a seventh colour.
 */
const STYLES: Record<TabState, string> = {
  crashed: 'bg-danger',
  waiting: 'bg-amber-400',
  thinking: 'bg-sky-400',
  running: 'bg-accent',
  idle: 'bg-muted',
  ended: 'bg-faint',
  unknown: 'border border-faint bg-transparent',
}

export function StatusDot({ state, testid }: { state: TabState | null; testid?: string }) {
  if (!state) return null
  return (
    <span
      data-testid={testid}
      data-state={state}
      aria-label={state}
      title={state}
      className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', STYLES[state])}
    />
  )
}
