/**
 * Where each wall cell sits inside the terminal column.
 *
 * Percentages on the group's existing absolute box, not a CSS grid: a group is
 * already `absolute inset-0` (`App.tsx:2064`) and every pane inside it is laid
 * out by flex bases off `paneGroups`. Replacing `inset-0` with four percentages
 * is the smallest change that puts a group somewhere other than the whole
 * column, and it leaves the arrangement INSIDE a group exactly as it was.
 *
 * Pure and framework-free like `columnOrder.ts` and `columnVisibility.ts`:
 * `vitest.config.mts` runs `environment: 'node'`, so anything that has to touch
 * React or the DOM cannot be unit-tested here at all.
 */
export interface CellRect {
  left: string
  top: string
  width: string
  height: string
}

/**
 * Four places, the same rounding `workspace.ts`'s own `percent` uses, so `1/3`
 * lands on a stable string rather than `33.33333333333333%`.
 *
 * Lossy on purpose, and the loss is bounded: a rounded row of three cells
 * covers 99.9999% of the column rather than 100%, which is a thousandth of a
 * pixel on any window this app can be opened at. `workspace.ts:559-561` accepts
 * the same give-away for a pane's flex basis, and a wall cell holding a
 * different rule would leave two halves of one layout rounding differently.
 */
function percent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(4))}%`
}

/**
 * The rect for the cell at `index`, in a wall of `count` cells at `columns` per
 * row.
 *
 * The final row STRETCHES: five cells at three columns is three then two, each
 * of the two taking half the width rather than a third and leaving a hole. The
 * hole is the obvious implementation and it is dead space in the one view whose
 * purpose is fitting terminals on screen.
 *
 * `columns` is clamped rather than trusted. It arrives from `localStorage` by
 * way of `wallSlots.ts`, which validates it, but a zero here would divide by
 * zero and hand `Terminal.tsx` a box it refuses to fit, which is a blank pane
 * with no error to go with it.
 */
export function cellRect(index: number, count: number, columns: number): CellRect {
  const total = Math.max(1, count)
  const perRow = Math.max(1, Math.min(Math.floor(columns), total))
  const rows = Math.ceil(total / perRow)
  const row = Math.floor(index / perRow)
  // The last row holds the remainder, which is `perRow` when it divides evenly.
  const inThisRow = row === rows - 1 ? total - row * perRow : perRow
  const column = index - row * perRow
  return {
    left: percent(column / inThisRow),
    top: percent(row / rows),
    width: percent(1 / inThisRow),
    height: percent(1 / rows),
  }
}
