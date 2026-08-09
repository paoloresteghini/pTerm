import type { ColumnId } from '../../shared/ipc'
import type { PanelSide } from '../ui/Panel'

/**
 * The row's left-to-right order, and the two things that follow from it.
 *
 * Every entry in `App.tsx`'s flex row used to be a JSX sibling, so the order
 * was whatever order someone typed them in: nothing else read it, nothing
 * else could change it. This module gives that order a value, so a drag (or
 * a stored profile) can move a column instead of the source file. `projects`
 * and `terminal` are not `ColumnId`s (they carry no visibility or width
 * preference of their own) but they still occupy a place in the row, so
 * `ColumnSlot` widens `ColumnId` to include them.
 *
 * Pure and framework-free like `columnVisibility.ts` and `columnWidth.ts`:
 * `vitest.config.mts` runs `environment: 'node'`, so anything that has to
 * touch React or the DOM cannot be unit-tested here at all. The drag that
 * calls `moveColumn` and the render that reads `resizerSideFor` belong to a
 * component and an end-to-end spec still to come, not to this file.
 */
export type ColumnSlot = ColumnId | 'projects' | 'terminal'

/** The row as it stands today, left to right, before anyone drags anything. */
export const COLUMN_ORDER_DEFAULT: readonly ColumnSlot[] = [
  'files',
  'projects',
  'tabs',
  'terminal',
  'skills',
  'presets',
  'prompts',
  'git',
  'notes',
]

/**
 * What a stored order means. Anything that is not a clean, complete list of
 * known slots degrades to the default rather than throwing, the same rule
 * `widthFromStored` follows in `columnWidth.ts`: a hand-edited or
 * half-written entry should cost the user their preference, not their
 * window.
 *
 * Three kinds of drift get healed rather than rejected outright, because a
 * profile is not one write, it is however many versions of this app have
 * touched it:
 * - an id the running app does not recognise (an older profile, or one from
 *   a build with a column this one dropped) is dropped;
 * - a slot repeated in the stored list collapses to its first appearance;
 * - a slot the stored list never mentions (a newer column, or `projects` or
 *   `terminal` if an old write predates them) is appended at the end, in
 *   `COLUMN_ORDER_DEFAULT`'s order, so an upgrade adds the column instead of
 *   losing it.
 */
export function orderFromStored(raw: string | null): ColumnSlot[] {
  if (raw === null) return [...COLUMN_ORDER_DEFAULT]

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [...COLUMN_ORDER_DEFAULT]
  }
  if (!Array.isArray(parsed)) return [...COLUMN_ORDER_DEFAULT]

  const known: ReadonlySet<string> = new Set(COLUMN_ORDER_DEFAULT)
  const order: ColumnSlot[] = []
  const seen = new Set<ColumnSlot>()
  for (const entry of parsed) {
    if (typeof entry !== 'string' || !known.has(entry) || seen.has(entry as ColumnSlot)) continue
    seen.add(entry as ColumnSlot)
    order.push(entry as ColumnSlot)
  }
  for (const slot of COLUMN_ORDER_DEFAULT) {
    if (!seen.has(slot)) order.push(slot)
  }
  return order
}

/**
 * Move `id` to `toIndex`, clamped to the order's bounds, and hand back a new
 * array: the caller holds this in state, so mutating `order` in place would
 * leave a render reading the same reference it started with.
 *
 * `projects` refuses to move (the order is handed back unchanged) because the
 * project switcher is fixed beside the tab strip; that rule needs to live
 * here, where a test can reach it, rather than only in whether the render
 * gives it a drag handle. `terminal` has no such guard: it never gets a
 * handle to drag in the first place, so a refusal for it would have no
 * caller and no honest test.
 */
export function moveColumn(
  order: readonly ColumnSlot[],
  id: ColumnSlot,
  toIndex: number,
): ColumnSlot[] {
  if (id === 'projects') return [...order]
  const from = order.indexOf(id)
  if (from === -1) return [...order]

  const next = [...order]
  next.splice(from, 1)
  const bounded = Math.max(0, Math.min(next.length, toIndex))
  next.splice(bounded, 0, id)
  return next
}

/**
 * Which side of `id`'s column the resize handle belongs on.
 *
 * A column's resizer sits against the terminal, since that is the pane whose
 * width the drag is actually changing. Left of the terminal, the handle goes
 * on the column's right edge; right of it, on the left edge. Dragging a
 * column across the terminal (via `moveColumn`) has to flip which edge grows,
 * or the user is left dragging a strip that no longer touches the terminal at
 * all. An order missing either slot (a `moveColumn` no-op, or a caller
 * mid-update) reads as `'right'`, the same side an unmoved column starts on.
 */
export function resizerSideFor(order: readonly ColumnSlot[], id: ColumnId): PanelSide {
  const terminal = order.indexOf('terminal')
  const column = order.indexOf(id)
  if (terminal === -1 || column === -1) return 'right'
  return column < terminal ? 'left' : 'right'
}
