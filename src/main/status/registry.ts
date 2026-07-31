import type { TabType } from '../../shared/ipc'
import type { TabState } from '../../shared/status'
import type { HookEventMessage } from '../hooks/protocol'
import { stateForExit, stateForHook, stateForOpen } from './machine'

export interface StatusTransition {
  tabId: string
  /** Null when the tab had no state at all — a shell nothing had run in. */
  from: TabState | null
  to: TabState
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

  private set(tabId: string, to: TabState): void {
    const from = this.states.get(tabId) ?? null
    // Claude re-fires Notification while a prompt sits unanswered. Emitting on
    // every repeat would be a toast a minute for a session you already know
    // about, so only changes are transitions.
    if (from === to) return
    this.states.set(tabId, to)
    for (const listener of this.listeners) listener({ tabId, from, to })
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

  applyHook(message: HookEventMessage): void {
    this.set(message.tabId, stateForHook(message.event))
  }

  applyExit(tabId: string, code: number): void {
    this.set(tabId, stateForExit(code))
  }

  /** Drop the tab entirely — dismissed, or killed on purpose. */
  forget(tabId: string): void {
    this.states.delete(tabId)
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
