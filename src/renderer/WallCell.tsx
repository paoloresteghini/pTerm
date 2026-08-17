import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { ProjectDescriptor, TabDescriptor, TabState } from '../shared/ipc'
import { cn } from './lib/cn'
import { StatusDot } from './StatusDot'
import { elapsedLabel } from './lib/elapsed'
import { tabLabel } from './lib/tabLabel'

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
 * and measured 8px of padding against a 22px header, with the top two rows of
 * every wall terminal behind it. `App.tsx` gives a group with a rect `pt-6`,
 * which is this header's height plus the waiting strip above it. A change to
 * either height has to move with the other.
 */
export function WallCell({
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
}: {
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
}): ReactElement {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // Closes the picker on a click anywhere outside, like `TabBar`'s and
  // `App.tsx`'s `paneMenu`: this codebase closes a popover with a plain
  // `document.addEventListener`/`removeEventListener` pair torn down in the
  // effect's cleanup, not an `AbortController` (grepped for one across
  // `src/`: there isn't a single use in this codebase to match).
  //
  // The `box.current?.contains` check is this component's own addition, not
  // copied from those neighbours, because it needs to answer a question they
  // don't have to: the caret that opens the picker lives inside the same
  // `box` the picker itself renders into (Task 7 positions both as one
  // header), rather than a separate element (`TabBar`'s row, `App.tsx`'s
  // right-clicked pane). Without the check, the caret's own mousedown would
  // bubble to this listener before its `onClick` toggle runs, closing the
  // picker a beat before the toggle reopened it, so a click on the caret
  // while open could never close it.
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const state = pinned ? (status[pinned.id] ?? null) : null
  const entered = pinned ? since[pinned.id] : undefined

  return (
    <div
      ref={box}
      data-testid={`wall-cell-${project.id}`}
      data-focused={focused ? 'true' : 'false'}
      className="pointer-events-none absolute inset-x-0 top-0 z-20"
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
          'pointer-events-auto flex h-[22px] items-center gap-1.5 overflow-hidden border-b border-border px-2 text-[10.5px] whitespace-nowrap',
          focused ? 'bg-raised text-fg' : 'bg-surface text-muted',
        )}
      >
        <span className={cn('font-semibold', focused ? 'text-accent' : 'text-label')}>
          {project.name}
        </span>
        <span className="text-faint">/</span>
        <span className={cn('truncate', pinned ? '' : 'text-faint')}>
          {pinned ? tabLabel(pinned) : 'choose a pane'}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-label="Pin to this slot"
          onClick={(event) => {
            event.stopPropagation()
            setOpen((was) => !was)
          }}
          className="shrink-0 px-0.5 text-[9px] text-faint hover:text-fg focus-visible:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
        >
          ▾
        </button>
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
      </div>

      {open ? (
        <div
          data-testid={`wall-picker-${project.id}`}
          className="pointer-events-auto w-[250px] border border-border-strong bg-overlay py-0.5 text-[11px]"
        >
          {choices.length === 0 ? (
            <div className="px-2 py-1 text-faint">No terminals in this project</div>
          ) : (
            choices.map((choice) => {
              const isPinned = choice.id === pinned?.id
              return (
                <button
                  key={choice.id}
                  type="button"
                  // The pinned row is a toggle, not just a marker: the empty
                  // cell the spec draws is a real state (a project on the
                  // wall with nothing chosen yet), not a mistake to route
                  // around, so there has to be a way back to it that doesn't
                  // mean pulling the whole project off the wall. Every other
                  // row only ever pins, since choosing a different pane never
                  // needs to ask which pane it is replacing.
                  aria-pressed={isPinned}
                  title={isPinned ? 'Unpin this pane' : undefined}
                  onClick={() => {
                    onPin(isPinned ? null : choice.id)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-1.5 px-2 py-0.5 text-left',
                    isPinned ? 'bg-raised text-fg' : 'text-muted hover:bg-raised hover:text-fg',
                  )}
                >
                  <StatusDot state={status[choice.id] ?? null} />
                  <span className="truncate">{tabLabel(choice)}</span>
                  {isPinned ? <span className="ml-auto text-accent">✓</span> : null}
                </button>
              )
            })
          )}
          <button
            type="button"
            onClick={() => {
              onToggleFollow()
              setOpen(false)
            }}
            className="mt-0.5 flex w-full items-center gap-1.5 border-t border-border px-2 py-1 text-left text-[10px] text-faint hover:text-fg"
          >
            Follow active pane
            {/* `=== true`: `wallFollowActive` is optional, and its own doc
                comment requires the absence be read this way rather than by
                truthiness. */}
            <span className="ml-auto">{project.wallFollowActive === true ? 'on' : 'off'}</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
