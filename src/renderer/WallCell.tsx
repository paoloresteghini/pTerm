import type { ReactElement } from 'react'
import type { ProjectDescriptor, TabDescriptor, TabState } from '../shared/ipc'
import { cn } from './lib/cn'
import { StatusDot } from './StatusDot'
import { elapsedLabel } from './lib/elapsed'
import { tabLabel } from './lib/tabLabel'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Check, ChevronDown, Trash2 } from 'lucide-react'

/**
 * One wall cell's chrome: the header that names what the cell is showing, and
 * the picker that changes it.
 *
 * Drawn OVER the pane group rather than around it. A group is a flex container
 * whose items are its panes, dividing the axis by `paneGroups`'s shares, and a
 * header among them would be one more item taking a share of an axis it is not
 * part of. The header is absolutely positioned at the top of the same rect
 * instead.
 *
 * It is opaque, so the group has to leave room for it, and **`p-2` is not that
 * room**: this comment said it was until Task 7 put the two on screen together
 * and measured 8px of padding against a 32px header, with the top two rows of
 * every wall terminal behind it. `App.tsx` gives a group with a rect `pt-9`,
 * which is this header's height plus the waiting strip above it. A change to
 * either height has to move with the other.
 */
export function WallCell({
  slotId,
  project,
  pinned,
  choices,
  status,
  since,
  now,
  focused,
  onFocus,
  onPin,
  onToggleFollow,
  onRemove,
}: {
  slotId: string
  project: ProjectDescriptor
  /** The pinned pane, or undefined for an empty cell. */
  pinned: TabDescriptor | undefined
  /** This project's terminal panes, for the picker. */
  choices: TabDescriptor[]
  status: Record<string, TabState>
  since: Record<string, number>
  now: number
  focused: boolean
  onFocus: () => void
  onPin: (paneId: string | null) => void
  onToggleFollow: () => void
  onRemove: () => void
}): ReactElement {
  const state = pinned ? (status[pinned.id] ?? null) : null
  const entered = pinned ? since[pinned.id] : undefined

  return (
    <div
      data-testid={`wall-cell-${slotId}`}
      data-focused={focused ? 'true' : 'false'}
      className="wall-cell pointer-events-none absolute inset-0 z-20"
    >
      {/* The state that means YOU are the blocker, promoted to something
          readable from across a desk. The dot says the same thing at 6px, and
          reading three of those at a glance is the problem this view exists
          to solve. */}
      {/* `bg-warn`, not a bare amber value: every theme sets `--color-warn` to
          the same hex `amber-400` resolves to today, which is exactly why the
          token has to be the one written here. A theme that later changes
          warn should carry this strip with it, and a literal wouldn't. */}
      {state === 'waiting' ? <div className="h-0.5 w-full bg-warn" /> : null}
      <div
        onMouseDown={onFocus}
        className={cn(
          'wall-cell-header pointer-events-auto flex h-8 items-center gap-2 overflow-hidden border-b border-border px-3 text-[13px] whitespace-nowrap',
          focused ? 'bg-raised text-fg' : 'bg-surface text-muted',
        )}
      >
        <span className={cn('shrink-0 font-medium', focused ? 'text-accent' : 'text-label')}>
          {project.name}
        </span>
        <span className="text-faint">/</span>
        <span className={cn('min-w-0 flex-1 truncate', pinned ? '' : 'text-faint')}>
          {pinned ? tabLabel(pinned) : 'choose a pane'}
        </span>
        <StatusDot state={state} testid={`wall-dot-${project.id}`} />
        {/* Elapsed-in-state, on the same idle/null gate `TabBar` uses: an idle
            or stateless pane is not one anyone is waiting on, and a duration
            on every cell is a row of numbers rather than a signal. */}
        {state === null || state === 'idle' ? null : (() => {
          const label = elapsedLabel(entered ?? null, now)
          return label === null ? null : (
            <span className="ml-auto shrink-0 font-mono text-[9.5px] text-faint">{label}</span>
          )
        })()}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="xs"
              aria-label="Select tab for this wall cell"
              onClick={(event) => event.stopPropagation()}
            >
              Select tab
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            data-testid={`wall-picker-${slotId}`}
            align="end"
            className="w-[250px]"
          >
            <DropdownMenuLabel>Project tabs</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {choices.length === 0 ? (
              <DropdownMenuItem disabled>No terminals in this project</DropdownMenuItem>
            ) : (
              choices.map((choice) => {
                const isPinned = choice.id === pinned?.id
                return (
                  <DropdownMenuItem
                    key={choice.id}
                    aria-pressed={isPinned}
                    onSelect={() => onPin(isPinned ? null : choice.id)}
                  >
                    <StatusDot state={status[choice.id] ?? null} />
                    <span className="min-w-0 flex-1 truncate">{tabLabel(choice)}</span>
                    {isPinned ? <Check className="text-accent" /> : null}
                  </DropdownMenuItem>
                )
              })
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onToggleFollow}>
              Follow active pane
              <span className="ml-auto text-xs text-faint">
                {project.wallFollowActive === true ? 'on' : 'off'}
              </span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 />
              Remove this wall cell
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
