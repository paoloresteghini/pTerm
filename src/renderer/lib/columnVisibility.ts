/**
 * Which side columns are collapsed, and the two operations the View menu's
 * hide-all item needs.
 *
 * The booleans are COLLAPSED rather than visible, matching the `*Collapsed`
 * state that `App.tsx` already holds and the `'0' means expanded` convention
 * the stored keys already use. Inverting the sense here would mean one file
 * disagreeing with five call sites about what `true` means.
 *
 * Pure and framework-free for the reason `mutationGuard.ts` and
 * `diffLines.ts` are: this repo's vitest runs `environment: 'node'` with no
 * DOM, so logic that lives inside a component cannot be unit-tested at all.
 */
export type ColumnId = 'files' | 'skills' | 'presets' | 'prompts' | 'notes' | 'git'

export type ColumnVisibility = Record<ColumnId, boolean>

/** Left to right as they appear on screen, which is the order the menu lists. */
export const COLUMN_IDS: readonly ColumnId[] = [
  'files',
  'skills',
  'presets',
  'prompts',
  'notes',
  'git',
]

export function anyOpen(state: ColumnVisibility): boolean {
  return COLUMN_IDS.some((id) => !state[id])
}

/**
 * Close every column, and report which were open so `restore` can put exactly
 * those back.
 *
 * The remembered list is built by walking `COLUMN_IDS`, so it is always in
 * on-screen order regardless of the order the user opened things in. Nothing
 * depends on that order today; it is done so that a remembered set compares
 * equal to itself across a round trip, which is what the test asserts.
 */
export function hideAll(state: ColumnVisibility): {
  next: ColumnVisibility
  remembered: ColumnId[]
} {
  const remembered = COLUMN_IDS.filter((id) => !state[id])
  const next = { ...state }
  for (const id of COLUMN_IDS) next[id] = true
  return { next, remembered }
}

/**
 * Reopen exactly `remembered`, leaving every other column as it is.
 *
 * An empty `remembered` changes nothing. That is the fresh-profile case, where
 * every column starts collapsed and there is no previous set: opening some
 * default there would take terminal width the user never asked for, which is
 * the rule every column in this app already follows.
 */
export function restore(state: ColumnVisibility, remembered: ColumnId[]): ColumnVisibility {
  const next = { ...state }
  for (const id of remembered) next[id] = false
  return next
}
