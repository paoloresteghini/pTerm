import type { IssueSummary } from '../../shared/ipc'

/**
 * In a module of its own rather than inside `IssuesPanel`, for the reason
 * `historyAgo.ts` gives: `vitest.config.mts` runs `environment: 'node'`, so
 * nothing that lives inside a component is reachable from a unit test here.
 */

export type IssueSort = 'updated' | 'newest' | 'comments'

/**
 * Rows whose title, number or a label name contains `query`, case
 * insensitively. A leading `#` on the query is stripped before it is matched
 * against the number, so `#42` and `42` find the same row.
 */
export function filterIssues(rows: IssueSummary[], query: string): IssueSummary[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return rows
  const bare = needle.startsWith('#') ? needle.slice(1) : needle
  return rows.filter((row) => {
    if (row.title.toLowerCase().includes(needle)) return true
    if (String(row.number).includes(bare)) return true
    return row.labels.some((label) => label.name.toLowerCase().includes(needle))
  })
}

/**
 * `rows` sorted by `sort`, newest or most-active first. Returns a new array;
 * `rows` itself is never reordered, since the caller holds it as component
 * state and a sort that mutated it would look like a filter that lost rows.
 */
export function sortIssues(rows: IssueSummary[], sort: IssueSort): IssueSummary[] {
  const copy = [...rows]
  if (sort === 'newest') return copy.sort((a, b) => b.number - a.number)
  if (sort === 'comments') return copy.sort((a, b) => b.commentCount - a.commentCount)
  return copy.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** How long a focus-triggered refetch is throttled to, in milliseconds. */
export const FOCUS_REFETCH_THROTTLE_MS = 60_000

/**
 * Whether a window `focus` event landing at `now` is allowed to trigger a
 * refetch, given the last one ran at `lastFetchedAt`.
 *
 * Pure and given both clock readings rather than reading `Date.now()`
 * itself, so the throttle is testable here rather than only from e2e: the
 * component's `focus` listener is the only caller, and it supplies both.
 * `null` means no fetch has landed yet, which always lets the first one
 * through rather than making a component that has never fetched wait out a
 * window before its first `focus`.
 */
export function shouldRefetchOnFocus(lastFetchedAt: number | null, now: number): boolean {
  if (lastFetchedAt === null) return true
  return now - lastFetchedAt >= FOCUS_REFETCH_THROTTLE_MS
}
