import type { TabDescriptor, TabType } from '../../shared/ipc'
import type { TabState } from '../../shared/status'
import type { HookEventMessage } from '../hooks/protocol'
import { stateForExit, stateForHook, stateForOpen } from './machine'

export interface StatusTransition {
  tabId: string
  /** Null when the tab had no state at all — a shell nothing had run in. */
  from: TabState | null
  /** Null means the tab was forgotten — dismissed, or killed on purpose. */
  to: TabState | null
  /**
   * The tab this transition is about, when the caller already has it in hand.
   *
   * `applyExit` fires after `forgetTab` may already have deleted the saved
   * config row backing this id — the exit handler forgets the row before it
   * can stamp the exit, so by the time a listener tries to resolve the tab
   * from `tabId` alone, both the live manager entry and the saved row can be
   * gone. Carrying the record here, straight from the exit event that already
   * has it, sidesteps that race entirely instead of betting on the relative
   * timing of two independent config-file operations.
   */
  tab?: TabDescriptor
}

/**
 * What every tab is doing, in the main process.
 *
 * Main owns this rather than the renderer for two reasons: notifications,
 * sounds and the dock badge all live here and all need it, and a ⌘R must not
 * blank the board.
 *
 * A tab absent from the map has no state, which is not the same as `unknown`.
 * Absent means "draw no dot" — a shell nobody has run anything in. `unknown`
 * means "this should have a state and does not", which is what a `claude` tab
 * with a broken hook install looks like.
 */
export class StatusRegistry {
  private readonly states = new Map<string, TabState>()
  private readonly listeners = new Set<(transition: StatusTransition) => void>()

  private set(
    tabId: string,
    to: TabState,
    options: { silent?: boolean; tab?: TabDescriptor } = {},
  ): void {
    const from = this.states.get(tabId) ?? null
    // Claude re-fires Notification while a prompt sits unanswered. Emitting on
    // every repeat would be a toast a minute for a session you already know
    // about, so only changes are transitions.
    if (from === to) return
    this.states.set(tabId, to)
    // A spooled event replayed at launch describes a past, not a present —
    // the final state still has to be right (that is what stops a `waiting`
    // session coming back blank), but a hundred of them firing a toast apiece
    // in a tight loop at startup is not a notification, it is a re-narration
    // of the weekend. `silent` lets the caller apply the state without one.
    if (options.silent) return
    for (const listener of this.listeners) listener({ tabId, from, to, tab: options.tab })
  }

  /** A tab has been opened, or restarted under the same id. */
  applyOpen(tabId: string, type: TabType): void {
    const initial = stateForOpen(type)
    if (initial === null) {
      // A shell gets no dot until something in it speaks. Delete rather than
      // leave whatever it died as: restart reuses the id, and a stale
      // `crashed` would show red over a session running fine.
      this.forget(tabId)
      return
    }
    this.set(tabId, initial)
  }

  applyHook(message: HookEventMessage, options: { silent?: boolean } = {}): void {
    this.set(message.tabId, stateForHook(message.event), options)
  }

  /**
   * `tab` is optional so every other caller keeps working unchanged; only the
   * exit path has a record worth passing. See `StatusTransition.tab`.
   */
  applyExit(tabId: string, code: number, tab?: TabDescriptor): void {
    this.set(tabId, stateForExit(code), { tab })
  }

  /**
   * Drop the tab entirely — dismissed, or killed on purpose.
   *
   * Emits a transition to `null` when the tab had a state to lose, so a
   * listener can clear whatever it was showing: the renderer's dot, and the
   * dock badge, neither of which would otherwise ever hear that this id is
   * gone. A tab already unknown to the registry emits nothing — there is
   * nothing to correct, and a shell that never spoke would otherwise fire a
   * transition, and a badge refresh, on every ordinary close.
   */
  forget(tabId: string): void {
    const from = this.states.get(tabId)
    if (from === undefined) return
    this.states.delete(tabId)
    for (const listener of this.listeners) listener({ tabId, from, to: null })
  }

  get(tabId: string): TabState | null {
    return this.states.get(tabId) ?? null
  }

  /** A copy: a caller that mutated this would silently rewrite the truth. */
  snapshot(): Record<string, TabState> {
    return Object.fromEntries(this.states)
  }

  /** What the dock badge shows: the tabs that are blocking a human. */
  waitingCount(): number {
    let count = 0
    for (const state of this.states.values()) if (state === 'waiting') count += 1
    return count
  }

  onTransition(listener: (transition: StatusTransition) => void): void {
    this.listeners.add(listener)
  }
}
