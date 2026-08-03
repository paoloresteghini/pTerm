import type { TabDescriptor, TabState } from '../shared/ipc'
import { StatusDot } from './StatusDot'
import { labelOfPane } from './workspace'

/**
 * The chrome over a pane whose session has died: a dot, a Restart and a
 * Dismiss.
 *
 * `TabBar`'s two buttons for a dead tab, at pane level and deliberately not a
 * second idiom — same glyphs, same wiring, same aria pattern. What the tab bar
 * cannot do is say *which box* died: it lists panes by id, and in a split the
 * user is looking at the panes, not at the bar. Both stay on offer; a dead
 * pane's Restart is reachable from either.
 *
 * The dot's colour comes from `state.status` and never from the tombstone's
 * exit code, which is the attach client's rather than the user's process's —
 * see `PaneBox.dead`. So red here is exactly a `crashed`, which is what tmux
 * reported through `pane_dead_status`, and a clean exit keeps `ended`'s faint
 * dot: that is the distinction `stateForExit` exists to draw, and a second
 * red-for-every-death rule invented here would flatten it.
 *
 * Absolutely positioned, so it takes no space in the pane's box. A strip that
 * took height would shrink the box, the pane's still-mounted `Terminal` would
 * fit itself to the smaller container, and the reflow would rewrite the very
 * scrollback this whole affordance exists to keep readable. Same reason the
 * active pane is marked with an inset ring rather than a border.
 */
export function DeadPane({
  pane,
  state,
  onRestart,
  onDismiss,
}: {
  pane: TabDescriptor
  state: TabState | null
  onRestart: (pane: TabDescriptor) => void
  onDismiss: (id: string) => void
}) {
  return (
    <div
      data-testid={`dead-${pane.id}`}
      // `pointer-events-none` on the strip and `auto` on the buttons: the
      // scrollback underneath is what a user came to read, and it is still
      // selectable everywhere the two glyphs are not.
      className="pointer-events-none absolute right-1 top-1 z-20 flex items-center gap-1.5 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted"
    >
      <StatusDot state={state} testid={`pane-dot-${pane.id}`} />
      {/* Recreates the session under the same id, cwd, command and type, and
          back into this pane's own tab — main owns that mapping, so nothing
          here names a tab. */}
      <button
        data-testid={`pane-restart-${pane.id}`}
        aria-label={`Restart ${labelOfPane(pane)}`}
        onClick={() => onRestart(pane)}
        className="pointer-events-auto cursor-default border-none bg-transparent p-0 text-[10px] text-muted hover:text-fg"
      >
        ↻
      </button>
      {/* Drops the pane. Its config row went when it died and its share is
          redistributed by the renormalise in `boxesOfRow`; this is what takes
          it off the screen. No `onClose`: there is no session left to kill. */}
      <button
        data-testid={`pane-dismiss-${pane.id}`}
        aria-label={`Dismiss ${labelOfPane(pane)}`}
        onClick={() => onDismiss(pane.id)}
        className="pointer-events-auto cursor-default border-none bg-transparent p-0 text-xs leading-none text-muted hover:text-fg"
      >
        ×
      </button>
    </div>
  )
}
