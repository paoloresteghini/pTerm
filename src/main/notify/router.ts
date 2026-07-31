import type { NotificationConfig, TabDescriptor } from '../../shared/ipc'
import type { StatusTransition } from '../status/registry'
import { resolve } from './rules'

export interface RouterToast {
  title: string
  body: string
  urgency: 'low' | 'high'
  /** Which tab a click should select. */
  tabId: string
}

/**
 * Every effect injected.
 *
 * Not for purity's sake: it means the unit test needs no Electron, no audio
 * device and no dock, and the thing being tested is the decision rather than
 * the plumbing.
 */
export interface RouterDeps {
  readConfig: () => Promise<NotificationConfig>
  findTab: (tabId: string) => Promise<TabDescriptor | null>
  projectOf: (tab: TabDescriptor) => Promise<{ id: string; name: string } | null>
  /** Window focused *and* this is the tab on screen. */
  isAttended: (tabId: string) => boolean
  showToast: (toast: RouterToast) => void
  playSound: (sound: string) => void
  /** Null clears it. */
  setBadge: (count: number | null) => void
  waitingCount: () => number
  now: () => Date
}

const LABELS: Record<string, string> = {
  waiting: 'needs you',
  crashed: 'crashed',
  idle: 'finished',
  ended: 'exited',
  thinking: 'working',
  running: 'running',
  unknown: 'unknown',
}

/**
 * A tab from the live manager when it has one, else from the persisted row
 * for the same id.
 *
 * `SessionManager.get` only knows about tabs with a client attached in this
 * app right now, and a detach deliberately removes the entry — but detaching
 * is how a session survives, not how it ends, so the tmux session (and
 * whatever is running inside it) can keep going with no client on it at all:
 * the window closed, a move to another project mid-flight. Hooks fire from
 * inside the session regardless of whether this app currently has a client
 * on it. Without this fallback, exactly the tabs a closed-window user most
 * needs the dock badge and a toast for — the ones running unattended — would
 * have their transitions resolve to "no such tab" and go silently unrouted.
 * Detaching never removes a tab's saved row (only a kill or a genuine exit
 * does), so the fallback is always there to fall back to.
 */
export function mergeTab(
  live: TabDescriptor | null,
  saved: readonly TabDescriptor[],
  tabId: string,
): TabDescriptor | null {
  return live ?? saved.find((candidate) => candidate.id === tabId) ?? null
}

export class NotificationRouter {
  constructor(private readonly deps: RouterDeps) {}

  /**
   * React to one transition.
   *
   * Never throws. A notification is the least important thing happening at any
   * given moment, and it must not be able to take down the status pipeline
   * behind it — so a failure to read config costs a toast, not a dot.
   */
  async handle(transition: StatusTransition): Promise<void> {
    try {
      await this.notify(transition)
    } catch {
      // Deliberately swallowed. See above.
    } finally {
      // Always, even when the rest failed: the count is about every other tab
      // as much as this one.
      this.refreshBadge()
    }
  }

  private async notify(transition: StatusTransition): Promise<void> {
    // `to: null` is a forget, not a state — dismissed, or killed on purpose.
    // There is nothing to describe in a toast; `handle`'s `finally` still
    // refreshes the badge for it.
    if (transition.to === null) return

    // The transition's own record first — carried straight from the exit
    // event for exactly the case where the saved config row may already be
    // gone by the time this runs (see `StatusTransition.tab`) — and only then
    // resolved against the live tab set at fire time, for every other
    // transition, where the tab may have been killed between the event
    // arriving and this running.
    const tab = transition.tab ?? (await this.deps.findTab(transition.tabId))
    if (!tab) return

    const project = await this.deps.projectOf(tab)
    const config = await this.deps.readConfig()
    const outcome = resolve(config, {
      state: transition.to,
      projectId: project?.id ?? null,
      attended: this.deps.isAttended(transition.tabId),
      now: this.deps.now(),
    })

    if (outcome.sound) this.deps.playSound(outcome.sound)
    if (!outcome.toast) return

    this.deps.showToast({
      // A stray still gets a name: "Unsorted" is where it is, and a toast that
      // named nothing would be a toast you cannot act on.
      title: `${project?.name ?? 'Unsorted'} · ${tab.id.slice(0, 6)}`,
      body: LABELS[transition.to] ?? transition.to,
      urgency: outcome.urgency,
      tabId: tab.id,
    })
  }

  /** A badge reading "0" is worse than none: a red spot meaning nothing. */
  refreshBadge(): void {
    const count = this.deps.waitingCount()
    this.deps.setBadge(count > 0 ? count : null)
  }
}
