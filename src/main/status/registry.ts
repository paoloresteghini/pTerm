import type { TabDescriptor, TabType } from '../../shared/ipc'
import type { TabState } from '../../shared/status'
import type { HookEventMessage } from '../hooks/protocol'
import { stateForDeath, stateForExit, stateForHook, stateForOpen, type PaneDeath } from './machine'

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
  /**
   * Emit this transition, but do not announce it.
   *
   * Distinct from `set`'s `silent`, which emits nothing at all: a silent
   * change never reaches the renderer or the dock badge, which is right for a
   * spool replay and wrong for a user action. `quiet` is for a change the user
   * asked for, where the dot and the badge must move and a toast about it
   * would be noise.
   */
  quiet?: boolean
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
  /**
   * When each tab entered the state it is in, epoch ms.
   *
   * For the vitals label: "thinking 4m" needs a start, and neither the state
   * map nor the wire carried one. Written only on a REAL transition — `set`
   * returns early on `from === to`, so Claude's minute-by-minute `Notification`
   * re-fires do not keep resetting the clock on a prompt that has been sitting
   * unanswered for an hour, which is exactly the session the label is for.
   *
   * Not persisted. A relaunch re-establishes every state from scratch and the
   * clock restarts with it; a timestamp read off disk would claim knowledge of
   * what a session did while the app was closed.
   */
  private readonly since = new Map<string, number>()
  private readonly listeners = new Set<(transition: StatusTransition) => void>()
  /**
   * Tabs whose death has been explained by the pane that died.
   *
   * A tmux client exits 0 whether its session was killed, its command crashed
   * or the user typed `exit` — measured three times, and the reason `crashed`
   * was unreachable for M3's whole life. The only place the truth exists is on
   * the dead pane — `#{pane_dead_status}`, or `#{pane_dead_signal}` when
   * something killed it — which arrives here through `applyDead`. Once it has,
   * the code-0 client exit that tmux's own
   * `pane-died` hook triggers a moment later carries no information at all,
   * and must not be allowed to overwrite the answer with `ended`.
   */
  private readonly explained = new Set<string>()

  /**
   * Injected so tests can assert on `since` without sleeping. Defaults to the
   * real clock, so nothing outside a test passes one.
   */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Tabs whose Needs You row has been ticked off and has not yet had a
   * reason to come back.
   *
   * `acknowledge` writes `idle` (or `ended`), which disarms the `from === to`
   * dedupe below: Claude re-fires `Notification` roughly once a minute while
   * a prompt sits unanswered, so about a minute after a tick the next re-fire
   * is a real `idle -> waiting` transition, not a repeat, and would come back
   * loud for a prompt the user already read and deliberately left alone. This
   * memo is what `set` checks instead: while a tab's id is in here, a
   * transition *to* `waiting` is dropped outright rather than merely
   * deduped. Membership is cleared by any other transition for that tab:
   * thinking, idling, dying, restarting, forgetting. All of those are real
   * activity, and a genuine new question that follows real activity has to
   * be heard.
   */
  private readonly acknowledged = new Set<string>()

  private set(
    tabId: string,
    to: TabState,
    options: { silent?: boolean; tab?: TabDescriptor; quiet?: boolean } = {},
  ): void {
    const from = this.states.get(tabId) ?? null
    if (to === 'waiting') {
      // See `acknowledged`: a re-fire behind a tick must not resurrect the
      // row, and the tab stays exactly where the tick left it.
      if (this.acknowledged.has(tabId)) return
    } else {
      // Any other state is real activity, which releases the tab: it may ask
      // a genuine new question next, and that has to come back into the
      // list.
      this.acknowledged.delete(tabId)
    }
    // Claude re-fires Notification while a prompt sits unanswered. Emitting on
    // every repeat would be a toast a minute for a session you already know
    // about, so only changes are transitions.
    if (from === to) return
    this.states.set(tabId, to)
    // After the `from === to` return above, so a repeat does not restart it.
    this.since.set(tabId, this.now())
    // A spooled event replayed at launch describes a past, not a present —
    // the final state still has to be right (that is what stops a `waiting`
    // session coming back blank), but a hundred of them firing a toast apiece
    // in a tight loop at startup is not a notification, it is a re-narration
    // of the weekend. `silent` lets the caller apply the state without one.
    if (options.silent) return
    for (const listener of this.listeners)
      listener({ tabId, from, to, tab: options.tab, quiet: options.quiet })
  }

  /** A tab has been opened, or restarted under the same id. */
  applyOpen(tabId: string, type: TabType): void {
    // Restart reuses the id, so a verdict on the previous life must not
    // outrank how this one ends.
    this.explained.delete(tabId)
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
    // The dead pane already said how this tab died, and it is the only party
    // that knows. See `explained`.
    if (this.explained.has(tabId)) return
    this.set(tabId, stateForExit(code), { tab })
  }

  /**
   * A pane died, reporting the status it exited with or the signal that
   * killed it.
   *
   * Outranks `applyExit` from here until the tab is reopened or forgotten,
   * because the client exit that follows a pane death is always 0 regardless
   * of what happened. The two race — tmux's `pane-died` hook backgrounds its
   * socket write and then kills the session — so this has to win in whichever
   * order they land: it overwrites an `ended` that beat it here, and blocks an
   * `ended` that arrives after.
   */
  applyDead(
    tabId: string,
    death: PaneDeath,
    options: { silent?: boolean; tab?: TabDescriptor } = {},
  ): void {
    this.explained.add(tabId)
    this.set(tabId, stateForDeath(death), options)
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
    this.explained.delete(tabId)
    this.acknowledged.delete(tabId)
    const from = this.states.get(tabId)
    if (from === undefined) return
    this.states.delete(tabId)
    this.since.delete(tabId)
    for (const listener of this.listeners) listener({ tabId, from, to: null })
  }

  /**
   * The user has dealt with this tab, without the session having said so.
   *
   * `waiting` becomes `idle` (alive, not blocking you) and `crashed` becomes
   * `ended` (dead, and `idle` would be a lie about it). Every other state is
   * left alone: an acknowledgement that raced a real state change must not
   * invent one.
   *
   * `explained` is deliberately untouched. A crash that has been acknowledged
   * is still a crash, so the late client exit that always follows a pane death
   * still has nothing to say.
   */
  acknowledge(tabId: string): void {
    const from = this.states.get(tabId)
    if (from !== 'waiting' && from !== 'crashed') return
    this.set(tabId, from === 'crashed' ? 'ended' : 'idle', { quiet: true })
    // After `set`, not before: `set` clears `acknowledged` for any non-waiting
    // `to`, including the `idle`/`ended` this call just wrote, so the memo
    // this acknowledgement is creating must be added once that call returns.
    this.acknowledged.add(tabId)
  }

  get(tabId: string): TabState | null {
    return this.states.get(tabId) ?? null
  }

  /** When `tabId` entered its current state, or null if it has no state. */
  sinceOf(tabId: string): number | null {
    return this.since.get(tabId) ?? null
  }

  /** A copy: a caller that mutated this would silently rewrite the truth. */
  snapshot(): Record<string, TabState> {
    return Object.fromEntries(this.states)
  }

  /**
   * Every tab's `since`, as a copy, for the restore payload.
   *
   * Separate from `snapshot` rather than folded into it: `snapshot`'s shape is
   * what `CHANNELS.status` and the restore result already carry, and widening
   * it would touch every reader of a state map for the sake of one label.
   */
  sinceSnapshot(): Record<string, number> {
    return Object.fromEntries(this.since)
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
