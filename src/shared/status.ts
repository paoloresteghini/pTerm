/**
 * What a tab is doing.
 *
 * Claude tabs move between `unknown`, `idle`, `thinking` and `waiting` from
 * hook events. Everything else moves between `running`, `ended` and `crashed`
 * from its exit code. `waiting` is the only state that means *you* are the
 * blocker; the rest are informational.
 *
 * Shared between processes deliberately: main fires notifications off these
 * and the renderer draws them, and a second copy of the order below is a copy
 * that can disagree with the one the dock badge counts.
 */
export type TabState =
  | 'crashed'
  | 'waiting'
  | 'thinking'
  | 'running'
  | 'idle'
  | 'ended'
  | 'unknown'

/** Worst first. A project row takes the worst state among its tabs. */
export const SEVERITY: readonly TabState[] = [
  'crashed',
  'waiting',
  'thinking',
  'running',
  'idle',
  'ended',
  'unknown',
]

/**
 * The most severe state present, or null when there is none to report — an
 * empty project, or one whose tabs are all shells nothing has been run in.
 * Null means "draw no dot", which is different from `unknown`, which means
 * "this should have a state and does not".
 */
export function worst(states: readonly TabState[]): TabState | null {
  for (const candidate of SEVERITY) {
    if (states.includes(candidate)) return candidate
  }
  return null
}
