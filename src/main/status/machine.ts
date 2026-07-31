import type { TabType } from '../../shared/ipc'
import type { TabState } from '../../shared/status'

/**
 * The Claude Code hook events PRCLI subscribes to.
 *
 * Each one is registered as its own entry in settings.json and passes its own
 * name as the hook script's argument, so the script never parses a payload.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SessionEnd',
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

/**
 * The state an event implies — regardless of the state the tab was in.
 *
 * The parent spec draws this as a graph, but it resolves to a lookup: every
 * event names the state it means. `Stop` is idle whether the tab was thinking
 * or waiting; `UserPromptSubmit` is thinking whether it was idle or waiting.
 * That is exactly the spec's rule that any event other than `Notification`
 * returns a waiting tab to `thinking` — no non-Notification event maps to
 * `waiting`, so the property holds by construction rather than by a branch.
 *
 * `Notification` fires both for a permission prompt and after roughly sixty
 * seconds idle at the input. Both genuinely mean *you are the blocker*, so
 * both are correctly `waiting`. This looks like a bug the first time it is
 * read, which is why it is written down.
 *
 * `SessionEnd` returns the tab to `unknown` rather than `idle`: Claude is gone
 * and the tab is a shell again, and claiming to know its state would be a
 * guess. The next `claude` in that tab starts the cycle over.
 */
export function stateForHook(event: HookEvent): TabState {
  switch (event) {
    case 'SessionStart':
    case 'Stop':
      return 'idle'
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
      return 'thinking'
    case 'Notification':
      return 'waiting'
    case 'SessionEnd':
      return 'unknown'
  }
}

/** A dead session's parting word. Non-zero is a crash worth a red dot. */
export function stateForExit(code: number): TabState {
  return code === 0 ? 'ended' : 'crashed'
}

/** How a pane died, as tmux reports it. Never both halves at once. */
export interface PaneDeath {
  /** `#{pane_dead_status}` — absent when a signal killed the pane. */
  status?: number
  /** `#{pane_dead_signal}` — tmux gives the *name*: "kill", "segv", "term". */
  signal?: string
}

/**
 * What a dead pane's own report means.
 *
 * tmux fills in exactly one of the two: a status with no signal, or a signal
 * name with no status — measured on 3.7b. So a segfault or an OOM kill has no
 * status at all, and reading a missing one as 0 would paint exactly the
 * crashes that matter most a calm grey.
 *
 * A death reporting neither is a crash too. Nothing should produce one — the
 * parser refuses a line with neither half — but guessing `ended` for a death
 * nobody can explain is the failure this whole path exists to remove.
 */
export function stateForDeath(death: PaneDeath): TabState {
  if (death.signal) return 'crashed'
  if (death.status === undefined) return 'crashed'
  return stateForExit(death.status)
}

/**
 * The state a freshly opened tab starts in, or null for no dot at all.
 *
 * A `claude` tab starts `unknown` so that a broken hook install shows as a
 * hollow dot rather than as nothing. A `shell` starts with no state, because a
 * dot on every shell is a row of hollow dots that trains you to ignore the
 * affordance this milestone needs you to trust — it gets one the moment
 * something in it speaks.
 */
export function stateForOpen(type: TabType): TabState | null {
  switch (type) {
    case 'claude':
      return 'unknown'
    case 'preset':
      return 'running'
    case 'shell':
      return null
  }
}
