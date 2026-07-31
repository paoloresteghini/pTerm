import type { NotificationConfig, Rule } from '../../shared/ipc'
import type { TabState } from '../../shared/status'

export interface NotificationOutcome {
  toast: boolean
  /** A macOS system sound name, or null for silence. */
  sound: string | null
  urgency: 'low' | 'high'
}

export interface ResolveInput {
  state: TabState
  /** Null for a tab under Unsorted, which has no project row to be scoped by. */
  projectId: string | null
  /** Window focused *and* this is the tab being looked at. */
  attended: boolean
  /** Passed in rather than read, so quiet hours are testable at any hour. */
  now: Date
}

const SILENT: NotificationOutcome = { toast: false, sound: null, urgency: 'low' }

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function minutesOf(value: string): number | null {
  const match = TIME_RE.exec(value)
  if (!match) return null
  return Number(match[1]) * 60 + Number(match[2])
}

/**
 * Inclusive of the start, exclusive of the end, and correct across midnight.
 *
 * A window it cannot parse is no window at all: a hand-edited config must not
 * be able to mute the app permanently in a way nothing explains. The same
 * formula also makes `from === to` an empty window rather than a 24-hour one —
 * a degenerate config fails open, not closed.
 */
export function inQuietHours(
  quietHours: { from: string; to: string } | null,
  now: Date,
): boolean {
  if (!quietHours) return false
  const from = minutesOf(quietHours.from)
  const to = minutesOf(quietHours.to)
  if (from === null || to === null) return false

  const minutes = now.getHours() * 60 + now.getMinutes()
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to
}

function matches(rule: Rule, input: ResolveInput): boolean {
  // A rule with no `on` matches every state, per the parent spec.
  if (rule.on !== undefined && rule.on !== input.state) return false
  if (rule.project !== undefined && rule.project !== input.projectId) return false
  return true
}

function apply(outcome: NotificationOutcome, rule: Rule): NotificationOutcome {
  return {
    // Each field is overridden only by a rule that states it, so a later rule
    // turning a toast off does not also silence the sound an earlier one set.
    toast: rule.toast ?? outcome.toast,
    // `??` would be wrong here: sound is meaningfully `null` (explicit
    // silence) as well as `undefined` (unstated), and only the explicit
    // undefined check tells those two apart. toast/urgency have no such
    // third state, so `??` is exact for them.
    sound: rule.sound !== undefined ? rule.sound : outcome.sound,
    urgency: rule.urgency ?? outcome.urgency,
  }
}

/**
 * What to do about a transition.
 *
 * Two orderings from the parent spec are in play, and they interact: *later
 * rules override earlier*, and *project-scoped beats global*. Both hold
 * because globals are folded first, in array order, and project-scoped rules
 * second, also in array order. A project rule therefore wins wherever it sits
 * in the file, and two project rules still resolve later-wins between
 * themselves.
 *
 * Pure, and passed its own clock: quiet hours are testable at any hour.
 */
export function resolve(config: NotificationConfig, input: ResolveInput): NotificationOutcome {
  if (inQuietHours(config.quietHours, input.now)) return SILENT

  const relevant = config.rules.filter((rule) => matches(rule, input))
  const global = relevant.filter((rule) => rule.project === undefined)
  const scoped = relevant.filter((rule) => rule.project !== undefined)

  let outcome = SILENT
  for (const rule of [...global, ...scoped]) outcome = apply(outcome, rule)

  // The single largest noise reduction at twelve live sessions: no popup for
  // the pane already in front of you. The sound stays — a chime for the tab
  // you are looking at is the cheapest possible signal, and it is the popup
  // that is redundant. Applied last so no rule, project-scoped or not, can
  // survive it: the mute is a blanket policy, not something a rule opts out of.
  if (config.muteWhenFocused && input.attended) outcome = { ...outcome, toast: false }

  return outcome
}
