import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { cn } from '../lib/cn'

/**
 * The chrome every side column shares: the vertical label it collapses to, the
 * heading it collapses from, and the strip its width is dragged by.
 *
 * A column has three states, not two. HIDDEN is the View menu's doing and
 * renders nothing at all, which is what that menu item is for. COLLAPSED is
 * the heading's doing and renders the strip below, which is one click from
 * open — setting a column aside is a different intent from not wanting it,
 * and they were the same gesture for about an hour.
 *
 * One file rather than a copy per column because they are the same three
 * controls with a different word in them, and the label colour is a thing this
 * app has already got wrong once by having it written out per call site.
 *
 * **`side` is which edge of the window the column is pinned to**, not which
 * side the border or handle goes on. Both of those are the INNER edge, which
 * is the opposite one, and getting it from a single prop is what stops a left
 * column drawing a seam against the window frame where nothing can see it.
 */
export type PanelSide = 'left' | 'right'

/** The collapsed form of a column: a vertical label, clicked to bring it back. */

export function PanelStrip({
  testid,
  label,
  side = 'right',
  onClick,
  onDragStart,
}: {
  testid: string
  label: string
  side?: PanelSide
  onClick: () => void
  /** Grabbed as a drag handle when given. `draggable` follows its presence,
   *  so a caller with nothing to reorder need not pass `draggable={false}`
   *  on top of it. */
  onDragStart?: () => void
}) {
  return (
    <button
      data-testid={testid}
      onClick={onClick}
      draggable={onDragStart !== undefined}
      onDragStart={onDragStart}
      title={`Show ${label.toLowerCase()}`}
      // `flex items-center justify-center` centres the word in the strip's
      // full height: in a vertical writing mode the flex axes rotate with the
      // text, so `justify-*` is the vertical one here. `py-3` alone (what this
      // replaced) pinned every label to the top of its column.
      className={cn(
        'flex w-6 shrink-0 cursor-default items-center justify-center border-y-0 border-solid border-border bg-surface py-3 font-mono text-[10px] uppercase tracking-wider text-label hover:text-fg',
        // The seam faces the terminal either way. A left column drawing
        // `border-l` puts its only border against the window frame, which is
        // how the Files strip shipped with no visible edge at all.
        side === 'left' ? 'border-l-0 border-r' : 'border-l border-r-0',
      )}
      style={{ writingMode: 'vertical-rl' }}
    >
      {label}
    </button>
  )
}

/** The expanded column's heading, which collapses it again when clicked. */
export function PanelHeading({
  testid,
  label,
  onClick,
  onDragStart,
  action,
}: {
  testid: string
  label: string
  onClick: () => void
  /** Same drag handle `PanelStrip` takes; see its doc comment. */
  onDragStart?: () => void
  /**
   * A control to sit at the right of the heading, or nothing.
   *
   * A sibling of the heading button rather than something inside it, because
   * the heading IS a button (pressing it hides the column) and a button
   * inside a button is invalid HTML that browsers resolve by dropping the
   * inner one. A column with no action passes nothing and draws exactly what
   * it drew before: the row is `flex`, the heading is its only child, and it
   * takes the full width it used to have.
   */
  action?: ReactNode
}) {
  return (
    <div className="flex items-center">
      <button
        data-testid={testid}
        onClick={onClick}
        draggable={onDragStart !== undefined}
        onDragStart={onDragStart}
        title={`Hide ${label.toLowerCase()}`}
        className="min-w-0 flex-1 cursor-default border-none bg-transparent px-2.5 pb-1 pt-3 text-left text-[10px] uppercase tracking-wider text-label hover:text-fg"
      >
        {label}
      </button>
      {action}
    </div>
  )
}

/**
 * The grabbable strip that sets a column's width.
 *
 * Same gesture shape as `PaneDivider`, and for the same reasons: the movement
 * is measured CUMULATIVELY from the pointerdown and applied to the width
 * captured there, so a drag that runs into the clamp and comes back does not
 * lose the pixels it spent at the bound; the listeners are on the window, so a
 * pointer that leaves the 7px strip mid-drag does not end the gesture and a
 * release outside the window still commits.
 *
 * Unlike `PaneDivider` this one is NOT in an overlay: it is absolutely
 * positioned inside the column itself, hanging half over the border. The
 * column must therefore be `relative`. It takes no space in the flex row
 * either way.
 */
export function ColumnResizer({
  testid,
  side,
  width,
  onResize,
  onCommit,
}: {
  testid: string
  /** Which edge of the window the column is pinned to. The handle goes opposite. */
  side: PanelSide
  /** The column's width now, read at pointerdown as the base for the drag. */
  width: number
  /** The width this drag has reached, on every pointer move. Caller clamps. */
  onResize: (px: number) => void
  /** Called once on release, for the caller to persist what it ended on. */
  onCommit: () => void
}) {
  const from = useRef<{ start: number; base: number } | null>(null)

  // Held in a ref for `PaneDivider`'s reason: the parent rebuilds these on
  // every render and re-renders on every frame of its own drag, so listing
  // them as effect dependencies would tear the window listeners down and
  // re-add them at pointer-event rate.
  const handlers = useRef({ onResize, onCommit })
  useEffect(() => {
    handlers.current = { onResize, onCommit }
  })

  // `width` too: the effect below must read the width captured at pointerdown,
  // and the pointerdown handler is the only thing that reads this.
  const latestWidth = useRef(width)
  useEffect(() => {
    latestWidth.current = width
  })

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // Stops the browser starting a text selection that then drags across every
    // column the pointer crosses.
    event.preventDefault()
    from.current = { start: event.clientX, base: latestWidth.current }
  }, [])

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const started = from.current
      if (!started) return
      const delta = event.clientX - started.start
      // A left column grows when the pointer moves right; a right column grows
      // when it moves left. This sign is the whole difference between the two.
      handlers.current.onResize(started.base + (side === 'left' ? delta : -delta))
    }
    const up = (): void => {
      if (!from.current) return
      from.current = null
      handlers.current.onCommit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [side])

  return (
    <div
      data-testid={testid}
      onPointerDown={onPointerDown}
      aria-hidden
      className={cn(
        'absolute top-0 bottom-0 z-20 w-[7px] cursor-col-resize',
        // Centred on the column's own border, which is why it is offset by
        // half its width rather than sitting flush inside the column.
        side === 'left' ? '-right-[3px]' : '-left-[3px]',
      )}
    />
  )
}
