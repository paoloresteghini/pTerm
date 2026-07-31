import type { Rule, TabState } from '../shared/ipc'

/**
 * The global rule for one state — `on` matching and `project` absent.
 *
 * "Global" is the operative word: a per-project override for the same state
 * has `project` set, and this deliberately does not answer for it. The
 * settings pane only ever edits the global row; project-scoped rules are
 * written solely by the sidebar's mute toggle, in mute.ts.
 */
export function globalRuleOf(rules: readonly Rule[], state: TabState): Rule | undefined {
  return rules.find((rule) => rule.on === state && rule.project === undefined)
}

/**
 * Rewrite the global rule for `state`, replacing it in place when one
 * already exists and appending one when it does not — so editing a row never
 * reorders the array or disturbs any other rule, project-scoped ones
 * included.
 */
export function setGlobalRule(rules: readonly Rule[], state: TabState, patch: Partial<Rule>): Rule[] {
  const index = rules.findIndex((rule) => rule.on === state && rule.project === undefined)
  if (index === -1) {
    return [...rules, { ...patch, on: state, project: undefined }]
  }
  return rules.map((rule, i) =>
    i === index ? { ...rule, ...patch, on: state, project: undefined } : rule,
  )
}
