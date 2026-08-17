/**
 * Which projects hold a wall slot, in which order, and how many cells go in a
 * row.
 *
 * In `localStorage` rather than in the config, which is the split the codebase
 * already makes: `pterm:columnOrder` and the `*Collapsed` keys are facts about
 * how THIS window is arranged, and a project's wall pin (which pane it shows)
 * is a fact about the project and goes in `ProjectRecord`. Membership is a
 * layout fact, so it belongs here.
 *
 * Pure and framework-free like `columnOrder.ts`, and for the same reason: this
 * repo's vitest runs `environment: 'node'`, so logic living inside a component
 * cannot be unit-tested at all.
 */

/** Three cells reads comfortably on a 27 inch display; four is the ceiling. */
export const WALL_COLUMNS_DEFAULT = 3
const WALL_COLUMNS_MAX = 4

/**
 * `WALL_COLUMNS_MAX` bounds columns, not the WebGL budget `claimRenderer`
 * enforces per pane on screen (`WEBGL_PANE_BUDGET_DEFAULT`, twelve, against a
 * measured Chromium cap of 16 live contexts per renderer process; see
 * `wall.spec.ts`'s header). Measured: four projects at two columns, each cell
 * holding a split tab, put eight of eight panes on screen and all eight kept a
 * context, comfortably under budget.
 *
 * What that measurement does not cover, and what no test or cap enforces
 * today: the real ceiling is `slots.length` times panes per slot, not column
 * count. Eight slots at two panes each is sixteen on-screen panes whatever the
 * column count, past the budget, and a pane past the budget falls to the DOM
 * renderer, where Claude Code's block characters draw as slivers. Nothing
 * here caps `slots.length` (a slot is one project, and there is no ceiling on
 * how many projects can hold one); that was ruled out deliberately, on the
 * grounds that the measured case sits well inside budget and a cap is scope
 * this plan never asked for. Recording it here rather than leaving it to be
 * rediscovered: raising `WALL_COLUMNS_MAX` is not what would trip this, more
 * projects on the wall is.
 */

/**
 * The stored slot list, resolved against the projects that exist.
 *
 * Degrades rather than throwing, the rule `orderFromStored` follows: junk,
 * duplicates and ids naming a project that is gone are dropped, and anything
 * that is not a list at all reads as an empty wall. Resolving against the live
 * project list is also what makes removing a project take it off the wall with
 * no second write.
 */
export function slotsFromStored(
  raw: string | null,
  projects: readonly { id: string }[],
): string[] {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const known = new Set(projects.map((project) => project.id))
  const slots: string[] = []
  const seen = new Set<string>()
  for (const entry of parsed) {
    if (typeof entry !== 'string' || !known.has(entry) || seen.has(entry)) continue
    seen.add(entry)
    slots.push(entry)
  }
  return slots
}

/** The stored column count, clamped to a range where a cell is still readable. */
export function columnsFromStored(raw: string | null): number {
  if (raw === null) return WALL_COLUMNS_DEFAULT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || raw.trim() === '') return WALL_COLUMNS_DEFAULT
  return Math.max(1, Math.min(WALL_COLUMNS_MAX, Math.floor(parsed)))
}

/**
 * Put `projectId` on the wall, or take it off.
 *
 * Appends rather than inserting at a default position: a slot list has no
 * canonical order to restore something to, unlike `COLUMN_ORDER_DEFAULT`, so
 * the honest place for a newly added project is the end.
 */
export function toggleSlot(slots: readonly string[], projectId: string): string[] {
  return slots.includes(projectId)
    ? slots.filter((id) => id !== projectId)
    : [...slots, projectId]
}
