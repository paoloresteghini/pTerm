import { byRecentlyClosed } from './inactiveOrder'

/** How many dormant projects the sidebar lists before "Show N more". */
export const MAX_VISIBLE_INACTIVE_PROJECTS = 5

/**
 * How many projects can carry a `⌘1..9` badge, which is every digit the
 * keydown handler's `/^Digit([1-9])$/` can match. Both halves read this so
 * widening one cannot leave a badge on a row no key reaches.
 */
export const MAX_PROJECT_SHORTCUTS = 9

export interface ProjectGroups<T> {
  /** Projects with at least one open pane, in stored order. */
  live: T[]
  /** Every project with no open pane, most recently closed first. */
  dormant: T[]
  /**
   * The rows the sidebar actually draws, top to bottom: the live group, then
   * as much of the dormant group as fits above "Show N more". This is the
   * array `⌘1..9` indexes, so the badge on a row and the key that selects it
   * are the same number by construction.
   */
  visible: T[]
}

/**
 * The sidebar's project list, split the way it is drawn.
 *
 * Read by two consumers that must not disagree: `Sidebar.tsx` draws these
 * groups and badges each visible row with its position, and `App.tsx`'s Digit
 * branch selects `visible[n - 1]`. Before this function they derived the
 * order separately, and did not: the badge came off the project's index in
 * the stored array while the row came off the live/dormant grouping, so a
 * sidebar reading `⌘2, ⌘4, ⌘5` down three consecutive rows was the normal
 * state of the app rather than a bug anybody had introduced.
 *
 * `hasTabs` is passed rather than read off `T` because the two callers hold
 * different shapes: the sidebar has already grouped each project's panes into
 * a tree, and `App.tsx` has only the flat pane array to filter.
 */
export function groupProjects<T extends { project: { lastClosedAt?: number | null } }>(
  rows: readonly T[],
  hasTabs: (row: T) => boolean,
): ProjectGroups<T> {
  const live = rows.filter((row) => hasTabs(row))
  const dormant = byRecentlyClosed(rows.filter((row) => !hasTabs(row)))
  return { live, dormant, visible: [...live, ...dormant.slice(0, MAX_VISIBLE_INACTIVE_PROJECTS)] }
}
