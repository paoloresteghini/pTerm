/**
 * Inactive projects, most recently closed first.
 *
 * The sidebar's Inactive section and the "Show N more" dialog draw the same
 * array, so ordering it here orders both: the dialog cannot show a different
 * eight from the ones the section hid.
 *
 * A project with no stamp has never had a pane close through this app: one
 * just added, or one whose sessions went away with the machine rather than
 * with a click. Those keep the manual "Move up"/"Move down" order at the
 * bottom, which is where they sat before this function existed. Ties hold
 * their manual order too, because `sort` is stable.
 */
export function byRecentlyClosed<T extends { project: { lastClosedAt?: number | null } }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort((a, b) => {
    const left = a.project.lastClosedAt ?? null
    const right = b.project.lastClosedAt ?? null
    if (left === right) return 0
    if (left === null) return 1
    if (right === null) return -1
    return right - left
  })
}
