import type { ColumnId } from '../../shared/ipc'
import type { PanelSide } from '../ui/Panel'

/**
 * The row's left-to-right order, and the two things that follow from it.
 *
 * Every entry in `App.tsx`'s flex row used to be a JSX sibling, so the order
 * was whatever order someone typed them in: nothing else read it, nothing
 * else could change it. This module gives that order a value, so a drag (or
 * a stored profile) can move a column instead of the source file. `projects`
 * and `terminal` are not `ColumnId`s (they carry no visibility preference of
 * their own, and `terminal` has no width preference either, though
 * `projects` does, under its own key, `pterm:sidebarWidth`) but they still
 * occupy a place in the row, so `ColumnSlot` widens `ColumnId` to include
 * them.
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
  'browser',
  'skills',
  'presets',
  'prompts',
  'git',
  'issues',
  'notes',
  'todos',
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
 *   `terminal` if an old write predates them) is put back where
 *   `COLUMN_ORDER_DEFAULT` says it belongs, immediately right of whichever
 *   slot precedes it there, so an upgrade adds the column beside the columns
 *   it was designed to sit between instead of at the far right of the row.
 *
 * That last rule replaced a plain append (changed 2026-08-12). Appending was
 * a fallback rather than a decision about where a new column belongs, and it
 * only ever looked harmless because no shipped column had exercised it: the
 * browser column ships next to the terminal, and every profile that had once
 * dragged anything would have received it past notes and todos. The choice
 * generalises, which is why the rule changed rather than this one slot: a
 * column's default position is the one statement this app makes about where
 * it belongs, and an upgrade is the moment to honour it.
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
  // Walking `COLUMN_ORDER_DEFAULT` left to right is what makes the insertion
  // point a single `indexOf`: by the time a missing slot comes up, the slot
  // that precedes it in the default order is already in `order`, either
  // because the profile stored it or because an earlier turn of this loop put
  // it back. So "where it belongs relative to what is present" is always the
  // place right after that one neighbour, and two missing slots that are
  // neighbours by default stay neighbours here. The leftmost slot has no
  // predecessor and goes to the front, which is also what the `-1` from an
  // `indexOf` that somehow found nothing would produce.
  for (const [index, slot] of COLUMN_ORDER_DEFAULT.entries()) {
    if (seen.has(slot)) continue
    const previous = index === 0 ? -1 : order.indexOf(COLUMN_ORDER_DEFAULT[index - 1])
    order.splice(previous + 1, 0, slot)
  }
  return order
}

/**
 * Move `id` to `toIndex`, clamped to the order's bounds, and hand back a new
 * array: the caller holds this in state, so mutating `order` in place would
 * leave a render reading the same reference it started with.
 *
 * `toIndex` lives in PRE-REMOVAL index space: it is the insertion point the
 * caller read off the row before `id` came out of it (`App.tsx`'s `gap(k)`
 * is the sliver immediately before whatever occupies index `k` right now).
 * Once `id` is spliced out, every slot to its right has shifted left by one,
 * so a `toIndex` that named a position to the right of `from` now names the
 * position one past where the user actually pointed. `toIndex <= from` is
 * unaffected, because the removal happened at or after the insertion point
 * and nothing between them moved. Compensating by one only in the rightward
 * case is what keeps a drop on a column's own right-hand sliver a no-op
 * instead of a one-place shift.
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
  const target = toIndex > from ? toIndex - 1 : toIndex
  const bounded = Math.max(0, Math.min(next.length, target))
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
 * all. An order missing either slot reads as `'right'`, the same side an
 * unmoved column starts on. `moveColumn` can never produce that: it neither
 * drops nor duplicates a slot for any input. The guard exists for a
 * hand-built array (a test, or a caller mid-update) rather than anything
 * `moveColumn` itself can hand back.
 */
export function resizerSideFor(order: readonly ColumnSlot[], id: ColumnId): PanelSide {
  const terminal = order.indexOf('terminal')
  const column = order.indexOf(id)
  if (terminal === -1 || column === -1) return 'right'
  return column < terminal ? 'left' : 'right'
}
