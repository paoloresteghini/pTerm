import { useCallback, useEffect, useRef } from 'react'

/**
 * The grabbable strip between two panes.
 *
 * Absolutely positioned, so it takes no space in the layout it sits over. That
 * is load-bearing rather than tidy: `App.tsx`'s panes size themselves from
 * `flexBasis` values that sum to the whole container, and a divider in the flow
 * would change the geometry it exists to adjust.
 *
 * Owns exactly one piece of knowledge — how many pixels make a ratio — and
 * nothing else. It reports the movement so far and lets the caller decide what
 * that means: the clamping and the floors are `resizeKids`' and `minRatioFor`'s,
 * and live in `workspace.ts` where they are tested.
 *
 * **The movement reported is CUMULATIVE, measured from the pointerdown**, not
 * the step since the last frame. The caller must therefore apply it to the
 * ratio it captured at `onGrab`, not to whatever the last frame left behind —
 * see `dragPane` in App.tsx, which says what each of the two shapes does when
 * the drag runs into a floor.
 */
export function PaneDivider({
  dir,
  offset,
  onGrab,
  onDrag,
  onCommit,
}: {
  dir: 'row' | 'col'
  /** Cumulative share to the left of (or above) this divider, 0-1. */
  offset: number
  /** Called at pointerdown, before any movement, so the caller can take a copy
   * of what it is about to move. */
  onGrab: () => void
  /** Called with the movement SINCE the pointerdown, in ratio units, on every
   * pointer move. */
  onDrag: (deltaRatio: number) => void
  /** Called once when the pointer is released. */
  onCommit: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Gesture facts, captured at pointerdown. A ref rather than state because
  // none of it affects what is rendered, and putting it in state would
  // re-render the whole tab on every frame for no visible difference. Null
  // whenever no drag is in progress, which is what the window listeners below
  // test to know whether an event is any of their business.
  const from = useRef<{ start: number; span: number } | null>(null)

  // The callbacks, held where the effect below cannot see them change. App
  // rebuilds them on every render and this component re-renders on every frame
  // of its own drag, so with them in the effect's dependencies the window
  // listeners were torn down and re-added at pointer-event rate, per divider.
  // Nothing here reads a callback at any moment other than "now", so a ref is
  // the whole fix and the effect depends on `dir` alone. Written in an effect
  // rather than during render because a render may be thrown away, and no
  // pointer event can be delivered between a commit and the effect that follows
  // it.
  const handlers = useRef({ onGrab, onDrag, onCommit })
  useEffect(() => {
    handlers.current = { onGrab, onDrag, onCommit }
  })

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // The overlay App wraps these in, which is inset to match the group
      // container's padding and so measures the same box the panes are laid out
      // in. Measuring the padded container itself instead overstates the axis by
      // twice its padding, which makes every drag run slow by that fraction and
      // the strip drift further from the cursor the longer the drag goes on.
      const container = ref.current?.parentElement
      if (!container) return
      const span = dir === 'row' ? container.offsetWidth : container.offsetHeight
      // An unmeasured container would make every delta Infinity.
      if (span <= 0) return
      // Not for the pane's sake — the strip sits in an overlay beside the pane
      // boxes rather than inside one, so no event from it was ever going to
      // bubble into a pane's own mousedown. It stops the browser doing what a
      // press-and-drag normally does: starting a text selection that then
      // extends across every pane the pointer crosses.
      event.preventDefault()
      from.current = { start: dir === 'row' ? event.clientX : event.clientY, span }
      handlers.current.onGrab()
    },
    [dir],
  )

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const started = from.current
      if (!started) return
      const at = dir === 'row' ? event.clientX : event.clientY
      handlers.current.onDrag((at - started.start) / started.span)
    }
    const up = (): void => {
      if (!from.current) return
      from.current = null
      handlers.current.onCommit()
    }
    // On the window, not on the strip: a pointer that leaves 7 pixels mid-drag
    // must not end the drag, and a release outside the window must still commit
    // rather than leaving the gesture live for ever. `pointercancel` for the
    // same reason — the OS taking the pointer away is the one other way a
    // gesture ends, and without it `from` would stay set and the next stray
    // pointermove would move a divider nobody was holding.
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [dir])

  return (
    <div
      ref={ref}
      data-testid="pane-divider"
      onPointerDown={onPointerDown}
      // `pointer-events-auto` to opt back in: the overlay this sits in is
      // `pointer-events-none` so that everywhere the strip is not, clicks reach
      // the pane underneath.
      className={
        dir === 'row'
          ? 'pointer-events-auto absolute top-0 bottom-0 z-20 w-[7px] -translate-x-1/2 cursor-col-resize'
          : 'pointer-events-auto absolute right-0 left-0 z-20 h-[7px] -translate-y-1/2 cursor-row-resize'
      }
      // The seam is at `offset` of the axis, and the strip is centred on it by
      // the translate above. Off by whatever share of the `gap-px` hairline
      // falls to this side of it — under a pixel on any tab this app can open,
      // against a 7px target.
      style={dir === 'row' ? { left: `${offset * 100}%` } : { top: `${offset * 100}%` }}
    />
  )
}
