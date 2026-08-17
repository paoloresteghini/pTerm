import { describe, it, expect } from 'vitest'
import { withWallFollow, withWallPin } from '../../src/main/state/wallPin'
import type { PTermConfig } from '../../src/main/state/store'

/**
 * Which project a pin lands on.
 *
 * Pure, so it can be tested with no `ipcMain` and no tmux: the handler in
 * `register.ts` is three lines around this, matching how `setActiveBrowser`
 * resolves a pane's owner (`register.ts:1093`).
 *
 * Sabotage-checked (2026-08-17), each mutation applied and reverted by hand:
 * 1. resolved the owner by `project.id === paneId` instead of by
 *    `project.slug === pane.projectSlug`: reddened "pins a pane on the
 *    project that owns it" AND "clears a pin", not only the first as
 *    predicted. Both panes ('a', 'b') and both projects ('p1', 'p2') use
 *    disjoint id spaces in the fixture, so `id === paneId` never matches
 *    anything and the mutated function is a no-op for every call in this
 *    suite, catching both write paths rather than just one. No gap: the
 *    stronger result is still the right one, so nothing further to add.
 * 2. dropped the `pane === undefined` guard (kept compiling with a `pane!`
 *    assertion, since removing the guard outright is a type error): reddened
 *    exactly "is a no-op for a pane no project owns", as predicted, with a
 *    thrown `TypeError` rather than a failed assertion.
 * 3. mutated `owner.wallPin = pin` in place and returned `config` unchanged
 *    instead of building a new object: reddened exactly "does not mutate the
 *    config it was given", as predicted.
 * All three mutations were reverted and the suite confirmed green (diffed
 * byte-identical to the pre-mutation file) before implementation was
 * considered final.
 */

const CONFIG: PTermConfig = {
  version: 10,
  activeProjectId: 'p1',
  projects: [
    { id: 'p1', name: 'One', slug: 'one', cwd: '/tmp/one', presets: [], activeTabId: null, activeBrowserTabId: null, wallPin: null, wallFollowActive: false },
    { id: 'p2', name: 'Two', slug: 'two', cwd: '/tmp/two', presets: [], activeTabId: null, activeBrowserTabId: null, wallPin: 'old', wallFollowActive: false },
  ],
  panes: [
    { id: 'a', projectSlug: 'one', cwd: '/tmp/one', type: 'shell' },
    { id: 'b', projectSlug: 'two', cwd: '/tmp/two', type: 'shell' },
  ],
  tabs: [],
  notifications: { rules: [], muteWhenFocused: false, quietHours: null },
  theme: 'classic',
} as unknown as PTermConfig

describe('withWallPin', () => {
  it('pins a pane on the project that owns it', () => {
    expect(withWallPin(CONFIG, 'a', 'a').projects[0]?.wallPin).toBe('a')
  })

  it('leaves every other project alone', () => {
    expect(withWallPin(CONFIG, 'a', 'a').projects[1]?.wallPin).toBe('old')
  })

  it('clears a pin', () => {
    expect(withWallPin(CONFIG, 'b', null).projects[1]?.wallPin).toBeNull()
  })

  it('is a no-op for a pane no project owns', () => {
    expect(withWallPin(CONFIG, 'gone', 'gone')).toEqual(CONFIG)
  })

  it('does not mutate the config it was given', () => {
    withWallPin(CONFIG, 'a', 'a')
    expect(CONFIG.projects[0]?.wallPin).toBeNull()
  })
})

describe('withWallFollow', () => {
  it('sets the flag on the named project', () => {
    expect(withWallFollow(CONFIG, 'p1', true).projects[0]?.wallFollowActive).toBe(true)
  })

  it('is a no-op for an id no project answers to', () => {
    expect(withWallFollow(CONFIG, 'gone', true)).toEqual(CONFIG)
  })
})
