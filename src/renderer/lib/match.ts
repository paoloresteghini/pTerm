/**
 * The one ranking rule in this codebase, shared by the skills panel and ⌘K.
 *
 * Two rules that drift is the failure mode this module exists to prevent, so
 * both surfaces import from here rather than sorting for themselves.
 *
 * Pure: no React, no DOM, no IPC. That is what makes it the only part of this
 * plan with unit tests, since this repo has no React rendering tests.
 */

/** Characters that begin a segment of a name: `superpowers:brainstorming`. */
const BOUNDARY = new Set([':', '-', '_', '/', '.', ' '])

const ADJACENT_BONUS = 10
const SEGMENT_BONUS = 8

/**
 * The most one query character can be charged for the distance it had to skip.
 *
 * **This cap is load-bearing and must not exceed `SEGMENT_BONUS`.** Uncapped,
 * the skip cost grows with position without limit while the segment bonus is
 * fixed, so a segment start late in a long name loses to a buried match in a
 * short one: `b` in `superpowers:brainstorming` scored -4 against `b` in
 * `aaab` at -3.
 *
 * The invariant, derived rather than guessed at: a buried single-character
 * match cannot skip fewer than one character (skipping zero would put it at
 * a boundary instead), so it scores at most `-1`. A boundary match at or
 * beyond the cap's distance scores at least `SEGMENT_BONUS - MAX_GAP_PENALTY`.
 * For the boundary to always win, `SEGMENT_BONUS - MAX_GAP_PENALTY` must
 * exceed `-1`, which holds exactly when `MAX_GAP_PENALTY` does not exceed
 * `SEGMENT_BONUS`. Raising it past `SEGMENT_BONUS` reintroduces the bug.
 */
const MAX_GAP_PENALTY = 4

/**
 * How well `query` matches `name`, or null when it does not match at all.
 *
 * A subsequence match: every query character must appear in `name`, in order,
 * not necessarily adjacent. Higher is better. An empty query scores 0 and
 * matches everything, which is what lets the panel render unfiltered.
 *
 * The walk is greedy, taking the earliest candidate for each query character
 * rather than searching for the best overall alignment. That is not optimal
 * scoring, and it is deliberate: it is linear, it is deterministic, and the
 * alternative buys nothing a user of a list this size would notice.
 */
/**
 * What a basename match is worth over the same match buried in a path.
 *
 * Large enough to outrank the segment-start bonuses a directory match collects
 * on the way (`src/`, `app/`, `nested/` each start a segment), because those
 * add up and would otherwise win.
 */
const BASENAME_BONUS = 100

export function scoreEntry(query: string, name: string): number | null {
  const needle = query.toLowerCase()
  const haystack = name.toLowerCase()
  if (needle.length === 0) return 0

  let score = 0
  let previous = -1

  for (const character of needle) {
    const found = haystack.indexOf(character, previous + 1)
    if (found === -1) return null

    // `previous` starts at -1, so this also fires for the first query
    // character when it matches at index 0: `brow` in `browse` beats
    // `b...r...o...w`, and it is also why two names that both start with the
    // query tie on this bonus.
    if (found === previous + 1) score += ADJACENT_BONUS
    // Starts a segment, or starts the name.
    if (found === 0 || BOUNDARY.has(haystack[found - 1] ?? '')) score += SEGMENT_BONUS
    // Skipping costs, so an earlier match ranks higher, but only up to the cap:
    // see MAX_GAP_PENALTY for why an uncapped version ranked a segment start
    // below a buried match.
    score -= Math.min(found - previous - 1, MAX_GAP_PENALTY)

    previous = found
  }

  return score
}

/**
 * Name order, case insensitive, falling back to the raw name so the order is
 * total and never depends on the input order.
 *
 * Plugin entries group under their prefix as a side effect, because the prefix
 * is part of the name. That is grouping for free, with no grouping mechanism.
 */
export function byName(a: { name: string }, b: { name: string }): number {
  const left = a.name.toLowerCase()
  const right = b.name.toLowerCase()
  if (left !== right) return left < right ? -1 : 1
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}

/**
 * The entries matching `query`, best first.
 *
 * With no query this is every entry in name order. With a query it is only the
 * matches, ranked, ties broken by name so the result never depends on the order
 * the caller happened to hold them in. Returns a new array; the input is not
 * mutated.
 */
export function filterEntries<T extends { name: string }>(query: string, entries: T[]): T[] {
  if (query.length === 0) return [...entries].sort(byName)

  const scored: { entry: T; score: number }[] = []
  for (const entry of entries) {
    const score = scoreEntry(query, entry.name)
    if (score === null) continue
    scored.push({ entry, score })
  }

  scored.sort((a, b) => (a.score !== b.score ? b.score - a.score : byName(a.entry, b.entry)))
  return scored.map((item) => item.entry)
}

/**
 * The sessions matching `query`, best first, ties broken worst-state-first.
 *
 * `severity` is an index into `SEVERITY` from `src/shared/status.ts`, so lower
 * is worse. Severity is a tie-break rather than an override: someone who typed
 * a name asked for that name, and a crashed session does not get to jump ahead
 * of it. With no query every score is equal, so severity is what orders the
 * list, which is the case that matters: ⌘K with an empty box should put what
 * needs a human at the top.
 *
 * Separate from `filterEntries` rather than a flag on it, because only
 * sessions have a state. Both go through the same `scoreEntry`, so the two
 * lists cannot rank the same string differently.
 */
export function rankSessions<T extends { name: string; severity: number }>(
  query: string,
  sessions: T[],
): T[] {
  const scored: { session: T; score: number }[] = []
  for (const session of sessions) {
    const score = scoreEntry(query, session.name)
    if (score === null) continue
    scored.push({ session, score })
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.session.severity !== b.session.severity) return a.session.severity - b.session.severity
    return byName(a.session, b.session)
  })
  return scored.map((item) => item.session)
}

/** One file offered by the palette: its path, and the basename shown first. */
export interface RankedFile {
  path: string
  name: string
}

/**
 * File paths matching `query`, best first.
 *
 * Scored TWICE, against the basename and against the whole path, and the better
 * of the two wins with the basename given a head start. A path is not a name:
 * without that head start, typing `app` ranks `src/app/nested/other.ts` above
 * `App.tsx`, because the buried match happens to score well on segment starts.
 * What you name is almost always the file, not a directory on the way to it.
 *
 * The whole-path score is kept rather than dropped so a directory can still be
 * typed: `nested` finds the file under `nested/` even though its basename
 * contains no such run.
 *
 * Ties break on path, which is total, so the list cannot reshuffle between two
 * keystrokes that did not change the query — `index.ts` under six directories
 * is ordinary, and an unstable order there is visible jitter.
 */
export function rankFiles(query: string, files: string[]): RankedFile[] {
  const entries = files.map((path) => ({ path, name: path.slice(path.lastIndexOf('/') + 1) }))
  if (query.length === 0) {
    return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  const scored: { entry: RankedFile; score: number }[] = []
  for (const entry of entries) {
    const onName = scoreEntry(query, entry.name)
    const onPath = scoreEntry(query, entry.path)
    if (onName === null && onPath === null) continue
    const best = Math.max(
      onName === null ? -Infinity : onName + BASENAME_BONUS,
      onPath === null ? -Infinity : onPath,
    )
    scored.push({ entry, score: best })
  }

  return scored
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0
    })
    .map(({ entry }) => entry)
}
