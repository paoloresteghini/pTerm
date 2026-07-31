import type { Rule } from '../shared/ipc'

/**
 * Whether a project has muted its own toasts.
 *
 * The shape is exact: `project` matching, `on` absent (so it applies to every
 * state) and `toast: false`. A per-state project rule — silencing just
 * `waiting`, say — is a different rule, written by the settings pane rather
 * than the sidebar, and this deliberately does not answer for it: only the
 * mute toggle reads and writes this one shape.
 */
export function projectMuted(rules: readonly Rule[], projectId: string): boolean {
  return rules.some(
    (rule) => rule.project === projectId && rule.on === undefined && rule.toast === false,
  )
}

/**
 * Flip a project's mute rule without disturbing any other rule in the array.
 *
 * A global rule has `project: undefined`, which never equals a specific
 * `projectId`, so it is never touched here. Unmuting removes every rule
 * matching the exact shape muting writes, rather than just the first — so a
 * config that somehow accumulated duplicates collapses back to none on a
 * single toggle instead of needing one click per duplicate, and toggling
 * twice is a no-op on the array's contents.
 */
export function toggleProjectMute(rules: readonly Rule[], projectId: string): Rule[] {
  if (projectMuted(rules, projectId)) {
    return rules.filter(
      (rule) => !(rule.project === projectId && rule.on === undefined && rule.toast === false),
    )
  }
  return [...rules, { project: projectId, toast: false }]
}
