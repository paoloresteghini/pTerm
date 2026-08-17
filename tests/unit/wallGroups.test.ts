import { describe, it, expect } from 'vitest'
import { INITIAL_WORKSPACE_STATE, paneGroups, type WallView } from '../../src/renderer/workspace'
import type { ProjectDescriptor, TabDescriptor } from '../../src/shared/ipc'

/**
 * Which groups are on screen, and where.
 *
 * `paneGroups` has always returned a group per tab across the whole workspace
 * and marked exactly one visible; wall mode is the same function marking one
 * per filled slot. These tests exist to hold that "exactly one" is now a
 * property of the NORMAL branch rather than of the function.
 *
 * Sabotage-checked (2026-08-17), each mutation applied and reverted by hand.
 * Recording what actually happened, not what was predicted going in:
 * 1. `visibleGroupIds` ignoring `wall` (always the normal branch): reddened
 *    THREE tests, not one: "marks one group visible per filled slot",
 *    "skips a pin naming a pane that is gone" and "orders the visible groups
 *    by slot, not by pane order" all failed. All three read `STATE`, whose
 *    single active project (`p1`, tab `a`) is what the normal branch falls
 *    back to, so losing the wall branch entirely shows up everywhere the wall
 *    was supposed to add a SECOND visible group.
 * 2. dropped the `pane === undefined` guard, replaced with `pane !==
 *    undefined && ...` so the short-circuit still protects `regionOf`: NO
 *    test reddened. `paneGroups` filters on `state.panes` regardless, so a
 *    pin naming a gone pane produces no group either way; the guard's
 *    behaviour is masked downstream by that filter. Re-tried as the more
 *    literal mutation, calling `regionOf(pane)` with no narrowing at all: this
 *    reddened exactly "skips a pin naming a pane that is gone", via an
 *    uncaught `TypeError` reading `.type` off `undefined` rather than a
 *    mismatched assertion. Recorded as the true result for this line: the
 *    guard's job is crash prevention, not the value the test's title implies.
 * 3. built `slotOf` from `groups`/pane-encounter order instead of `visible`
 *    (wall-slot) order: reddened "orders the visible groups by slot, not by
 *    pane order", as expected.
 * 4. gave hidden groups a rect too: reddened "gives every visible group a
 *    rect and every hidden group none", as expected.
 * 5. dropped the `region !== 'terminal'` guard in `visibleGroupIds` (kept
 *    only `wall === null`): did NOT redden "ignores the wall in the browser
 *    region". `STATE` has no browser-region pane at all, so `paneGroups`
 *    never walks one and the assertion holds vacuously whether or not the
 *    guard exists. This was a real gap, not a passing mutation: it meant the
 *    stated invariant ("wall mode is terminal-region only... must never give
 *    a browser group a rect") had no witness. Two changes followed. First, a
 *    witness test below, an actual browser pane, named as both its
 *    project's active browser tab and that project's wall pin, that a
 *    broken guard actually disturbs. Second, `paneGroups`'s own rect
 *    condition now repeats `region === 'terminal'` rather than trusting
 *    `visibleGroupIds` alone to keep a browser id out of `visible`; see its
 *    comment. With both in place, this mutation reddens the witness (the
 *    browser group's `visible` flips to `false`, because the mutated wall
 *    branch's inner pane-region check is hardcoded to `'terminal'` and now
 *    misroutes `p2`'s terminal-pane pin into `visible` instead of `p1`'s
 *    browser pin), a different assertion than the rect one, but proof the
 *    guard is load-bearing.
 */

const project = (id: string, slug: string, extra: Partial<ProjectDescriptor> = {}): ProjectDescriptor => ({
  id,
  name: id,
  slug,
  cwd: `/tmp/${slug}`,
  presets: [],
  activeTabId: null,
  available: true,
  wallPin: null,
  wallFollowActive: false,
  ...extra,
})

const pane = (id: string, slug: string): TabDescriptor => ({
  id,
  projectSlug: slug,
  cwd: `/tmp/${slug}`,
  type: 'shell',
})

const STATE = {
  ...INITIAL_WORKSPACE_STATE,
  projects: [
    project('p1', 'one', { activeTabId: 'a', wallPin: 'a' }),
    project('p2', 'two', { activeTabId: 'b', wallPin: 'b' }),
    project('p3', 'three', { activeTabId: 'c', wallPin: null }),
  ],
  panes: [pane('a', 'one'), pane('b', 'two'), pane('c', 'three')],
  activeProjectId: 'p1',
}

const WALL: WallView = { slots: ['p1', 'p2', 'p3'], columns: 3 }

describe('paneGroups without a wall', () => {
  it('marks exactly one group visible', () => {
    const visible = paneGroups(STATE).filter((group) => group.visible)
    expect(visible.map((group) => group.id)).toEqual(['a'])
  })

  it('gives that group no rect, so it keeps inset-0', () => {
    expect(paneGroups(STATE)[0]?.rect).toBeUndefined()
  })
})

describe('paneGroups with a wall', () => {
  it('marks one group visible per filled slot', () => {
    const visible = paneGroups(STATE, 'terminal', WALL).filter((group) => group.visible)
    expect(visible.map((group) => group.id)).toEqual(['a', 'b'])
  })

  // A project on the wall with no pin is an empty CELL, drawn by the renderer.
  // It contributes no group, because there is no pane to put in one.
  it('skips a slot with no pin', () => {
    const ids = paneGroups(STATE, 'terminal', WALL)
      .filter((group) => group.visible)
      .map((group) => group.id)
    expect(ids).not.toContain('c')
  })

  it('skips a pin naming a pane that is gone', () => {
    const state = { ...STATE, panes: [pane('b', 'two')] }
    const visible = paneGroups(state, 'terminal', WALL).filter((group) => group.visible)
    expect(visible.map((group) => group.id)).toEqual(['b'])
  })

  it('orders the visible groups by slot, not by pane order', () => {
    const wall: WallView = { slots: ['p2', 'p1'], columns: 2 }
    const rects = paneGroups(STATE, 'terminal', wall)
      .filter((group) => group.visible)
      .map((group) => ({ id: group.id, left: group.rect?.left }))
    expect(rects).toEqual([
      { id: 'a', left: '50%' },
      { id: 'b', left: '0%' },
    ])
  })

  it('gives every visible group a rect and every hidden group none', () => {
    for (const group of paneGroups(STATE, 'terminal', WALL)) {
      expect(group.rect === undefined).toBe(!group.visible)
    }
  })

  // The browser column is not what the wall is a mode of.
  it('ignores the wall in the browser region', () => {
    const groups = paneGroups(STATE, 'browser', WALL)
    expect(groups.every((group) => group.rect === undefined)).toBe(true)
  })

  // STATE has no browser pane at all, so the check above is vacuous: it would
  // pass even if the region guard were dropped, because `paneGroups` never
  // walks a browser pane to find out. This is the witness: an actual browser
  // pane, named as its project's active browser tab AND as that project's wall
  // pin, so a broken guard would both route it through the wall branch and, in
  // `paneGroups`, hand it a rect.
  it('never gives the active browser tab a rect, even when it is also the wall pin', () => {
    const state = {
      ...STATE,
      projects: STATE.projects.map((entry) =>
        entry.id === 'p1' ? { ...entry, activeBrowserTabId: 'z', wallPin: 'z' } : entry,
      ),
      panes: [...STATE.panes, { id: 'z', projectSlug: 'one', cwd: '/tmp/one', type: 'browser' as const }],
    }
    const group = paneGroups(state, 'browser', WALL).find((entry) => entry.id === 'z')
    expect(group?.visible).toBe(true)
    expect(group?.rect).toBeUndefined()
  })

  it('leaves flexDirection alone', () => {
    const group = paneGroups(STATE, 'terminal', WALL).find((entry) => entry.id === 'a')
    expect(group?.style).toEqual({ flexDirection: 'row' })
  })
})
