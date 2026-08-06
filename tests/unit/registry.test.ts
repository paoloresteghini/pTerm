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

  // A dead pane's own status is the only trustworthy verdict on how a tab
  // died: the tmux client that follows it exits 0 no matter what happened,
  // measured three times. So `applyDead` outranks `applyExit`, in whichever
  // order the two arrive — the socket write is backgrounded and the kill is
  // not, so neither order can be relied on.
  it('records a dead pane by the status the pane itself reported', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')

    registry.applyDead(ID, { status: 3 })

    expect(registry.get(ID)).toBe('crashed')
  })

  it('records a dead pane that exited cleanly as ended', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')

    registry.applyDead(ID, { status: 0 })

    expect(registry.get(ID)).toBe('ended')
  })

  // A segfault or an OOM kill reports no status at all — tmux gives the
  // signal's name instead — so reading a missing status as 0 would paint the
  // crashes that matter most a calm grey.
  it('records a pane killed by a signal as crashed, though it reports no status', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')

    registry.applyDead(ID, { signal: 'kill' })

    expect(registry.get(ID)).toBe('crashed')
  })

  it('does not let the client exit that follows a crash downgrade it to ended', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')

    registry.applyDead(ID, { status: 3 })
    // tmux kills the session immediately after the pane dies, so the attached
    // client exits — with code 0, as it always does.
    registry.applyExit(ID, 0)

    expect(registry.get(ID)).toBe('crashed')
  })

  it('lets a crash correct an ended that beat it to the registry', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')

    registry.applyExit(ID, 0)
    registry.applyDead(ID, { status: 3 })

    expect(registry.get(ID)).toBe('crashed')
  })

  it('lets a restarted tab die cleanly after an earlier crash', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')
    registry.applyDead(ID, { status: 3 })

    // Restart reuses the id. The old verdict must not outrank the new life.
    registry.applyOpen(ID, 'preset')
    registry.applyExit(ID, 0)

    expect(registry.get(ID)).toBe('ended')
  })

  it('clears the verdict when the tab is forgotten', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')
    registry.applyDead(ID, { status: 3 })

    registry.forget(ID)
    registry.applyExit(ID, 0)

    expect(registry.get(ID)).toBe('ended')
  })

  it('announces a dead pane so a toast and the badge can react', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.applyOpen(ID, 'preset')
    registry.onTransition((transition) => seen.push(transition))

    registry.applyDead(ID, { status: 3 })

    expect(seen).toEqual([{ tabId: ID, from: 'running', to: 'crashed', tab: undefined }])
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

  // The dock badge's half of "neither `needsYou` nor the badge may count an
  // editor pane". `needsYou` needed a guard; this needed none, and this test
  // is here to say which of the two it is rather than to change anything.
  it('does not count an editor pane, which opens with no state to count', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'editor')
    registry.applyOpen(OTHER, 'claude')

    // The claude pane is in the registry and merely not waiting, so a zero
    // below is about the editor rather than about an empty registry.
    expect(registry.get(OTHER)).toBe('unknown')
    expect(registry.get(ID)).toBeNull()
    expect(registry.waitingCount()).toBe(0)
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

  it('acknowledging a waiting tab leaves it idle, and says so', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.applyHook(hook(ID, 'Notification'))
    registry.onTransition((transition) => seen.push(transition))

    registry.acknowledge(ID)

    expect(registry.get(ID)).toBe('idle')
    expect(seen).toEqual([{ tabId: ID, from: 'waiting', to: 'idle', quiet: true }])
  })

  it('acknowledging a crashed tab leaves it ended, not idle', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.applyDead(ID, { status: 3 })
    expect(registry.get(ID)).toBe('crashed')
    registry.onTransition((transition) => seen.push(transition))

    registry.acknowledge(ID)

    expect(registry.get(ID)).toBe('ended')
    expect(seen).toEqual([{ tabId: ID, from: 'crashed', to: 'ended', quiet: true }])
  })

  // The pane is still dead and a client exit that lands after it still says
  // nothing, so the verdict that death recorded has to outrank a late
  // `applyExit` exactly as it did before the acknowledgement.
  it('keeps a dead pane explained after its crash is acknowledged', () => {
    const registry = new StatusRegistry()
    registry.applyDead(ID, { status: 3 })
    registry.acknowledge(ID)

    registry.applyExit(ID, 0)

    expect(registry.get(ID)).toBe('ended')
  })

  it('acknowledging a tab that is not blocking anyone changes nothing', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.applyHook(hook(ID, 'UserPromptSubmit'))
    registry.onTransition((transition) => seen.push(transition))

    registry.acknowledge(ID)

    expect(registry.get(ID)).toBe('thinking')
    expect(seen).toEqual([])
  })

  it('acknowledging a tab it has never seen emits nothing', () => {
    const registry = new StatusRegistry()
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))

    registry.acknowledge(OTHER)

    expect(registry.get(OTHER)).toBeNull()
    expect(seen).toEqual([])
  })

  // Finding 1 of the whole-branch review: acknowledging disarms the
  // from===to dedupe above (it writes `idle`), so without this the next
  // Notification re-fire, roughly a minute later, was a real `idle ->
  // waiting` transition and came back loud for a prompt the user had already
  // read and deliberately left alone.
  it('ignores a re-fire behind an acknowledgement, staying idle and silent', () => {
    const registry = new StatusRegistry()
    registry.applyHook(hook(ID, 'Notification'))
    registry.acknowledge(ID)
    expect(registry.get(ID)).toBe('idle')
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))

    // Exactly what Claude's own re-fire looks like: the same event again,
    // with nothing else having happened in between.
    registry.applyHook(hook(ID, 'Notification'))

    expect(registry.get(ID)).toBe('idle')
    expect(seen).toEqual([])
  })

  it('lets a genuine new question through once real activity follows the tick', () => {
    const registry = new StatusRegistry()
    registry.applyHook(hook(ID, 'Notification'))
    registry.acknowledge(ID)
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))

    // The user typed something new into that session: real activity, so the
    // acknowledgement is released.
    registry.applyHook(hook(ID, 'UserPromptSubmit'))
    registry.applyHook(hook(ID, 'Notification'))

    expect(registry.get(ID)).toBe('waiting')
    expect(seen).toEqual([
      { tabId: ID, from: 'idle', to: 'thinking', tab: undefined, quiet: undefined },
      { tabId: ID, from: 'thinking', to: 'waiting', tab: undefined, quiet: undefined },
    ])
  })

  it('starts a restarted tab fresh, with no acknowledgement left over', () => {
    const registry = new StatusRegistry()
    registry.applyOpen(ID, 'preset')
    registry.applyExit(ID, 1)
    expect(registry.get(ID)).toBe('crashed')
    registry.acknowledge(ID)
    expect(registry.get(ID)).toBe('ended')

    // Restart reuses the id. The stale acknowledgement must not linger and
    // swallow this new life's first Notification.
    registry.applyOpen(ID, 'preset')
    registry.applyHook(hook(ID, 'Notification'))

    expect(registry.get(ID)).toBe('waiting')
  })

  it('forgetting an acknowledged tab drops the memo along with everything else', () => {
    const registry = new StatusRegistry()
    registry.applyHook(hook(ID, 'Notification'))
    registry.acknowledge(ID)

    registry.forget(ID)
    // A fresh open under the same id must not inherit an acknowledgement
    // from a tab that no longer exists.
    registry.applyOpen(ID, 'claude')
    registry.applyHook(hook(ID, 'Notification'))

    expect(registry.get(ID)).toBe('waiting')
  })

  it('still marks a crash explained after acknowledging it, with the memo in place', () => {
    const registry = new StatusRegistry()
    registry.applyDead(ID, { status: 3 })
    registry.acknowledge(ID)
    expect(registry.get(ID)).toBe('ended')

    // The late client exit that always follows a pane death still has
    // nothing to say, acknowledged or not.
    registry.applyExit(ID, 0)
    expect(registry.get(ID)).toBe('ended')

    // And the crash path's own re-fire guard still holds: nothing about the
    // crash case bypasses it.
    const seen: StatusTransition[] = []
    registry.onTransition((transition) => seen.push(transition))
    registry.applyHook(hook(ID, 'Notification'))
    expect(registry.get(ID)).toBe('ended')
    expect(seen).toEqual([])
  })
})
