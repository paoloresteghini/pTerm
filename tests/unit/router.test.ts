import { describe, it, expect } from 'vitest'
import { mergeTab, NotificationRouter, type RouterDeps } from '../../src/main/notify/router'
import { DEFAULT_NOTIFICATIONS } from '../../src/main/state/store'
import type { NotificationConfig, TabDescriptor } from '../../src/shared/ipc'

const ID = '0123456789abcdef'

function tab(id = ID): TabDescriptor {
  return {
    id,
    projectSlug: 'lumio',
    cwd: '/tmp',
    tmuxSession: `pterm-lumio-${id}`,
    type: 'claude',
  }
}

// `Parameters<typeof NotificationRouter.prototype.constructor>[0]` does not
// typecheck under strict: `prototype.constructor` widens to the built-in
// `Function` interface, whose call signature is `(...args: any[]) => any`, so
// `Parameters<...>[0]` comes out `any` rather than `RouterDeps` — every
// override below would then go unchecked instead of catching a drifted
// field. `ConstructorParameters<typeof NotificationRouter>[0]` (equivalently,
// just naming `RouterDeps`) is the idiomatic form and actually types the
// overrides.
function build(overrides: Partial<RouterDeps> = {}) {
  const toasts: { title: string; body: string; tabId: string }[] = []
  const sounds: string[] = []
  const badges: (number | null)[] = []
  const router = new NotificationRouter({
    readConfig: async (): Promise<NotificationConfig> => DEFAULT_NOTIFICATIONS,
    findTab: async () => tab(),
    projectOf: async () => ({ id: 'lumio-id', name: 'Lumio' }),
    isAttended: () => false,
    showToast: (toast) => toasts.push(toast),
    playSound: (sound) => sounds.push(sound),
    setBadge: (count) => badges.push(count),
    waitingCount: () => 0,
    now: () => new Date('2026-07-30T14:00:00'),
    ...overrides,
  })
  return { router, toasts, sounds, badges }
}

describe('NotificationRouter', () => {
  it('shows a toast naming the project and the tab', async () => {
    const { router, toasts } = build()

    await router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })

    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.title).toContain('Lumio')
    expect(toasts[0]?.tabId).toBe(ID)
  })

  it('says nothing about a transition no rule covers', async () => {
    const { router, toasts, sounds } = build()

    await router.handle({ tabId: ID, from: 'idle', to: 'thinking' })

    expect(toasts).toEqual([])
    expect(sounds).toEqual([])
  })

  it('plays a sound only when a rule names one', async () => {
    const { router, sounds } = build({
      readConfig: async () => ({
        rules: [{ on: 'waiting', toast: false, sound: 'Funk' }],
        muteWhenFocused: true,
        quietHours: null,
      }),
    })

    await router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })

    expect(sounds).toEqual(['Funk'])
  })

  it('suppresses the toast for the tab being looked at', async () => {
    const { router, toasts } = build({ isAttended: () => true })

    await router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })

    expect(toasts).toEqual([])
  })

  it('updates the dock badge on every transition', async () => {
    const { router, badges } = build({ waitingCount: () => 3 })

    await router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })

    expect(badges).toEqual([3])
  })

  it('clears the badge rather than showing a zero', async () => {
    const { router, badges } = build({ waitingCount: () => 0 })

    await router.handle({ tabId: ID, from: 'waiting', to: 'idle' })

    // A dock badge reading "0" is worse than none: it is a red spot that
    // means nothing needs you.
    expect(badges).toEqual([null])
  })

  it('says nothing about a tab it can no longer find', async () => {
    const { router, toasts, badges } = build({ findTab: async () => null })

    await router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })

    // Resolved against the live tab set at fire time: the tab may have been
    // killed between the event and this.
    expect(toasts).toEqual([])
    // The badge still refreshes — the count is about every other tab too.
    expect(badges).toHaveLength(1)
  })

  it('names Unsorted rather than nothing for a stray', async () => {
    const { router, toasts } = build({
      projectOf: async () => null,
      readConfig: async () => ({
        rules: [{ on: 'crashed', toast: true }],
        muteWhenFocused: true,
        quietHours: null,
      }),
    })

    await router.handle({ tabId: ID, from: 'running', to: 'crashed' })

    expect(toasts[0]?.title).toContain('Unsorted')
  })

  // I4: the exit handler's `forgetTab` deletes a dying tab's saved config row
  // before the router ever gets a chance to look it up, which used to make
  // `findTab` resolve to null and make `crashed`/`ended` the only two states
  // that could never toast. Carrying the tab on the transition itself — as
  // `registry.applyExit` now does — sidesteps that lookup entirely, so the
  // toast fires even when `findTab` would find nothing at all.
  it('toasts from the transition\'s own tab when findTab can no longer find it', async () => {
    const dyingTab = tab()
    const { router, toasts } = build({
      findTab: async () => null,
      readConfig: async () => ({
        rules: [{ on: 'crashed', toast: true }],
        muteWhenFocused: true,
        quietHours: null,
      }),
    })

    await router.handle({ tabId: ID, from: 'running', to: 'crashed', tab: dyingTab })

    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.tabId).toBe(ID)
  })

  // I3: `forget` emits `to: null` so a listener can clear whatever it was
  // showing. That is not a state to describe in a toast — there is nothing
  // left to say about a tab that was just dismissed or killed on purpose —
  // but the badge still has to catch up, which `handle`'s `finally` already
  // guarantees runs regardless.
  it('says nothing about a forget, but still refreshes the badge', async () => {
    const { router, toasts, sounds, badges } = build({ waitingCount: () => 2 })

    await router.handle({ tabId: ID, from: 'waiting', to: null })

    expect(toasts).toEqual([])
    expect(sounds).toEqual([])
    expect(badges).toEqual([2])
  })

  // The default rules toast on `idle`, so an acknowledgement of a `waiting`
  // tab would fire a toast about the very thing the user just dismissed.
  it('says nothing about a quiet transition', async () => {
    const { router, toasts, sounds } = build()

    await router.handle({ tabId: ID, from: 'waiting', to: 'idle', quiet: true })

    expect(toasts).toEqual([])
    expect(sounds).toEqual([])
  })

  // The count is about every other tab as much as this one, and the badge is
  // the whole reason `quiet` is not `silent`.
  it('still refreshes the badge for a quiet transition', async () => {
    const { router, badges } = build({ waitingCount: () => 3 })

    await router.handle({ tabId: ID, from: 'waiting', to: 'idle', quiet: true })

    expect(badges).toEqual([3])
  })

  // The control: the same transition without the flag is a transition the
  // router does describe, so the test above cannot pass by the rule for
  // `idle` having been dropped.
  it('still describes the same transition without the flag', async () => {
    const { router, toasts } = build()

    await router.handle({ tabId: ID, from: 'waiting', to: 'idle' })

    expect(toasts).toHaveLength(1)
  })

  it('survives a failure to read config without taking the transition down', async () => {
    const { router, badges } = build({
      readConfig: async () => {
        throw new Error('disk gone')
      },
    })

    // A notification is the least important thing happening. It must never be
    // able to break the status pipeline behind it.
    await expect(router.handle({ tabId: ID, from: 'thinking', to: 'waiting' })).resolves
      .toBeUndefined()
    expect(badges).toHaveLength(1)
  })
})

describe('mergeTab', () => {
  // The wiring hazard this guards against: `SessionManager.get` only knows
  // about tabs with a client currently attached in this app, and a detach
  // deletes the entry. But detaching is how a session survives, not how it
  // ends — the tmux session, and Claude inside it, can keep running (and
  // firing hooks) with no client on it at all: window closed, a project move
  // mid-flight. A `findTab` wired straight to `manager.get(id) ?? null` would
  // silently drop every transition for such a tab, exactly when a closed
  // window makes the dock badge and a toast the only signal left. Detaching
  // never removes the tab's saved row, so falling back to it is what keeps
  // the transition routed.
  const saved = [tab()]

  it('prefers the live tab when there is one', () => {
    const liveTab = { ...tab(), cwd: '/live' }
    expect(mergeTab(liveTab, saved, ID)).toEqual(liveTab)
  })

  it('falls back to the saved row for a detached-but-alive tab', () => {
    expect(mergeTab(null, saved, ID)).toEqual(saved[0])
  })

  it('is null when neither the manager nor the saved config knows the tab', () => {
    expect(mergeTab(null, saved, 'nope')).toBeNull()
  })
})
