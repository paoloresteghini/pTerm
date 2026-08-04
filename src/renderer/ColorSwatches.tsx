import { PANE_COLORS, PANE_COLOR_DEFAULT, type PaneColor } from '../shared/paneColors'
import { cn } from './lib/cn'

/**
 * The row of backgrounds a pane can be set to.
 *
 * One component with two callers, which is the point: the pane's own
 * right-click menu and the tab's both offer this, and two hand-built rows are
 * two lists that can come to disagree about which colours exist. The list
 * itself lives in `shared/paneColors.ts`, where main validates against it.
 *
 * The first swatch is the default. It is drawn like the rest rather than
 * labelled "None", because what it does is what it looks like: it puts the
 * pane back to the background every other pane has.
 */
export function ColorSwatches({
  paneId,
  selected,
  onPick,
}: {
  paneId: string
  /** The pane's colour now, so the row can show which one is on. */
  selected: PaneColor
  /** Given `null` for the default, matching the IPC call's own signature. */
  onPick: (color: PaneColor | null) => void
}) {
  return (
    <div data-testid={`swatches-${paneId}`} className="flex gap-1 px-2.5 py-1">
      {PANE_COLORS.map((color) => (
        <button
          key={color}
          data-testid={`swatch-${paneId}-${color.slice(1)}`}
          // The colour's own value, not a name: these are six greys and any
          // name for them would be invented here and meaningless to a screen
          // reader. The selected one says so.
          aria-label={color === selected ? `${color}, current` : color}
          onClick={(event) => {
            event.stopPropagation()
            // Null for the default, so the store writes no colour rather than
            // writing `#09090b`. `paneColors.ts` says why there is only one
            // spelling of "no colour" on disk.
            onPick(color === PANE_COLOR_DEFAULT ? null : color)
          }}
          style={{ background: color }}
          className={cn(
            'h-4 w-4 cursor-default rounded-sm border',
            // The border does the work a background cannot: six dark greys on
            // a dark menu need an edge to be findable at all, and the selected
            // one needs to be the brighter edge rather than a tick drawn over
            // a 16px box.
            color === selected ? 'border-accent' : 'border-border hover:border-muted',
          )}
        />
      ))}
    </div>
  )
}
