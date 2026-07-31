import { describe, it, expect } from 'vitest'
import { StatusRegistry, type StatusTransition } from '../../src/main/status/registry'

const ID = '0123456789abcdef'
const OTHER = 'fedcba9876543210'

function hook(tabId: string, event: 'Stop' | 'Notification' | 'UserPromptSubmit' | 'SessionEnd') {
  return { tabId, event, at: 1 } as const
}

describe('StatusRegistry', () => {
  it('has nothing to say about a tab it has not seen', () => {
    const registry = new StatusRegistry()
    expect(registry.get(ID)).toBeNull()
    expect(registry.snapshot()).toEqual({})
  })

  it('records the state a tab opens in', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'claude')
    expect(registry.get(ID)).toBe('unknown')
  })

  it('keeps a shell tab out of the map entirely until it says something', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'shell')

    expect(registry.snapshot()).toEqual({})

    // Typing `claude` into a shell tab is the common case, and the first hook
    // is what makes it a Claude tab. Nothing about its declared type may stop
    // that.
    registry.applyHook(hook(ID, 'Notification'))
    expect(registry.get(ID)).toBe('waiting')
  })

  it('moves through the states its events imply', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'claude')

    registry.applyHook(hook(ID, 'UserPromptSubmit'))
    expect(registry.get(ID)).toBe('thinking')
    registry.applyHook(hook(ID, 'Notification'))
    expect(registry.get(ID)).toBe('waiting')
    registry.applyHook(hook(ID, 'Stop'))
    expect(registry.get(ID)).toBe('idle')
  })

  it('emits a transition with what it came from', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))

    registry.applyOpen(ID, 'claude')
    registry.applyHook(hook(ID, 'Notification'))

    expect(seen).toEqual([
      { tabId: ID, from: null, to: 'unknown' },
      { tabId: ID, from: 'unknown', to: 'waiting' },
    ])
  })

  it('emits nothing when the state does not change', () => {
    const registry = new StatusRegistry()
    registry.applyHook(hook(ID, 'Notification'))
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))

    registry.applyHook(hook(ID, 'Notification'))

    // Claude re-fires Notification while a prompt sits unanswered. A toast per
    // repeat is a toast every sixty seconds for a session you already know
    // about.
    expect(seen).toEqual([])
    expect(registry.get(ID)).toBe('waiting')
  })

  it('records a death by its exit code', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')
    expect(registry.get(ID)).toBe('running')

    registry.applyExit(ID, 1)
    expect(registry.get(ID)).toBe('crashed')
  })

  it('records a clean exit as ended', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')
    registry.applyExit(ID, 0)
    expect(registry.get(ID)).toBe('ended')
  })

  it('forgets a tab entirely on dismiss', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')
    registry.applyExit(ID, 1)

    registry.forget(ID)

    expect(registry.get(ID)).toBeNull()
    // Or the dock badge would keep counting a tab that is no longer on screen.
    expect(registry.snapshot()).toEqual({})
  })

  it('counts only the tabs that are blocking a human', () => {
    const registry = new StatusRegistry()
    registry.applyHook(hook(ID, 'Notification'))
    registry.applyHook(hook(OTHER, 'UserPromptSubmit'))

    expect(registry.waitingCount()).toBe(1)

    registry.applyHook(hook(OTHER, 'Notification'))
    expect(registry.waitingCount()).toBe(2)

    registry.applyHook(hook(ID, 'Stop'))
    expect(registry.waitingCount()).toBe(1)
  })

  it('takes a dead tab out of the waiting count', () => {
    const registry = new StatusRegistry()
    registry.applyHook(hook(ID, 'Notification'))
    registry.applyExit(ID, 1)
    expect(registry.waitingCount()).toBe(0)
  })

  it('returns a snapshot that cannot be mutated from outside', () => {
    const registry = new StatusRegistry()
    registry.applyHook(hook(ID, 'Stop'))

    const snapshot = registry.snapshot()
    snapshot[ID] = 'crashed'

    expect(registry.get(ID)).toBe('idle')
  })

  it('reopening a tab replaces whatever it died as', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')
    registry.applyExit(ID, 1)

    registry.applyOpen(ID, 'preset')

    // Restart recreates the session under the same id; a stale `crashed` on it
    // would show a red dot over a session that is running fine.
    expect(registry.get(ID)).toBe('running')
  })

  // I3: `forget` used to delete the entry with no transition, so nothing —
  // not the renderer's dot, not the dock badge — ever heard the tab was gone.
  // A shell restarted after dying would show its stale `ended` dot forever,
  // and killing a `waiting` tab left the badge counting it until some other,
  // unrelated tab happened to transition.
  it('emits a transition to null when a known tab is forgotten', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.applyHook(hook(ID, 'Notification'))
    registry.onTransition((transition) => seen.push(transition))

    registry.forget(ID)

    expect(seen).toEqual([{ tabId: ID, from: 'waiting', to: null }])
  })

  it('emits nothing when forgetting a tab it never knew', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))

    registry.forget(ID)

    // No state to lose, and no badge refresh worth triggering on every
    // ordinary close of a shell nothing ever ran in.
    expect(seen).toEqual([])
  })

  // I4: the exit handler forgets a tab's saved config row before the
  // notification router gets a chance to resolve it from `tabId` alone, so
  // `crashed`/`ended` could never reach a toast. Carrying the tab directly on
  // the transition sidesteps that race instead of betting on read/write
  // ordering across two independent config-file operations.
  it('carries the tab on an exit transition when the caller has one in hand', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))
    const tab = {
      id: ID,
      projectSlug: 'lumio',
      cwd: '/tmp',
      tmuxSession: `prcli-lumio-${ID}`,
      type: 'preset' as const,
    }

    registry.applyExit(ID, 1, tab)

    expect(seen).toEqual([{ tabId: ID, from: null, to: 'crashed', tab }])
  })

  // Replay describes a past — the spool exists to restore the final state
  // (that is what stops a `waiting` session coming back blank), not to
  // re-narrate a weekend of events as live toasts the moment the app opens.
  it('applies a hook silently on request, with no transition emitted', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))

    registry.applyHook(hook(ID, 'Notification'), { silent: true })

    expect(seen).toEqual([])
    // The state itself still lands — silence is about the notification, not
    // about the truth the dot has to show.
    expect(registry.get(ID)).toBe('waiting')
  })
})
