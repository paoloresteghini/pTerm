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
 *
 * Re-checked 2026-08-17 for the two cells-are-slots tests added with Task 7,
 * same method:
 * 6. sized the grid by the filled slots again (`cellRect(slot, visible.length,
 *    ...)`, which is what Task 3 shipped): reddened both "leaves an empty slot
 *    its cell rather than closing the gap" and "keeps the other cells where
 *    they are when a pin outlives its pane", and nothing else, because those
 *    are the only two WALL tests that assert a rect VALUE rather than group
 *    ids or rect presence. The one other test that asserts values, "orders
 *    the visible groups by slot, not by pane order", uses a separate,
 *    fully-filled two-slot wall, where the two numbering rules agree.
 * 7. numbered each entry by its position among the FILLED slots
 *    (`slot: filled.length`) rather than by its slot: reddened only "keeps the
 *    other cells where they are when a pin outlives its pane". The first test
 *    cannot see this one, because its empty slot is the LAST of the three and
 *    the two numberings agree on everything before it. Recorded rather than
 *    tidied away: it is why the second test puts the hole in the MIDDLE of the
 *    wall, and why one test would not have been enough.
 *
 * Sabotage-checked again 2026-08-17 for Task 8's `wallFollowActive` fix
 * (`wallPinFor`, applied and reverted by hand):
 * 8. made `wallPinFor` ignore `wallFollowActive` and always answer the pin
 *    (`return project.wallPin ?? null`): reddened exactly the two tests that
 *    exist to prove follow-active does anything ("shows the active pane, not
 *    the pin, when follow is on" and "draws an empty cell rather than falling
 *    back to the pin when the active pane is null"), and left "leaves a
 *    project with follow off unchanged" green, which is the correct result
 *    for that mutation: a project with follow off never reads
 *    `wallFollowActive` for anything other than "is it true", so removing the
 *    branch cannot touch it.
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

  // A cell belongs to a SLOT, not to a pane. An empty slot is still a cell,
  // because the renderer draws the placeholder and the pane picker in one, and
  // a slot with nothing to pick from would be a project on the wall that the
  // wall never shows. Sizing the grid by the filled slots instead would also
  // mean every surviving cell resized the moment one project's pin went away,
  // which is a tmux fit on sessions nobody touched.
  it('leaves an empty slot its cell rather than closing the gap', () => {
    const rects = paneGroups(STATE, 'terminal', WALL)
      .filter((group) => group.visible)
      .map((group) => group.rect)
    expect(rects).toEqual([
      { left: '0%', top: '0%', width: '33.3333%', height: '100%' },
      { left: '33.3333%', top: '0%', width: '33.3333%', height: '100%' },
    ])
  })

  // The same rule at the moment it matters most: a pinned session dying must
  // not reshuffle the two cells the user is still reading. The third slot keeps
  // its place on the right rather than sliding into the hole.
  it('keeps the other cells where they are when a pin outlives its pane', () => {
    const state = {
      ...STATE,
      projects: STATE.projects.map((entry) =>
        entry.id === 'p3' ? { ...entry, wallPin: 'c' } : entry,
      ),
      panes: [pane('a', 'one'), pane('c', 'three')],
    }
    const lefts = paneGroups(state, 'terminal', WALL)
      .filter((group) => group.visible)
      .map((group) => group.rect?.left)
    expect(lefts).toEqual(['0%', '66.6667%'])
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

// Task 8's added scope: `wallFollowActive` was written, persisted and
// labelled in the picker, and read by nothing (Task 7's review). A project
// following the active pane shows that pane in its cell instead of its pin.
describe('paneGroups with follow-active', () => {
  it('shows the active pane, not the pin, when follow is on', () => {
    const state = {
      ...STATE,
      projects: STATE.projects.map((entry) =>
        entry.id === 'p1' ? { ...entry, wallPin: 'a', activeTabId: 'd', wallFollowActive: true } : entry,
      ),
      panes: [...STATE.panes, pane('d', 'one')],
    }
    // Not an order assertion: `paneGroups`'s array order follows
    // `state.panes`, not the wall's slots (only `rect` reads slot order,
    // covered by "orders the visible groups by slot" above). The set of
    // visible ids is what follow-active changes.
    const ids = paneGroups(state, 'terminal', WALL)
      .filter((group) => group.visible)
      .map((group) => group.id)
    expect(new Set(ids)).toEqual(new Set(['d', 'b']))
  })

  // The whole point of the flag is that the slot tracks whatever is active
  // NOW. A null active pane is not a reason to fall back to the pin.
  it('draws an empty cell rather than falling back to the pin when the active pane is null', () => {
    const state = {
      ...STATE,
      projects: STATE.projects.map((entry) =>
        entry.id === 'p1' ? { ...entry, wallPin: 'a', activeTabId: null, wallFollowActive: true } : entry,
      ),
    }
    const visible = paneGroups(state, 'terminal', WALL).filter((group) => group.visible)
    expect(visible.map((group) => group.id)).toEqual(['b'])
    expect(visible.map((group) => group.id)).not.toContain('a')
  })

  it('leaves a project with follow off unchanged', () => {
    const state = {
      ...STATE,
      projects: STATE.projects.map((entry) =>
        entry.id === 'p1'
          ? { ...entry, wallPin: 'a', activeTabId: 'd', wallFollowActive: false }
          : entry,
      ),
      panes: [...STATE.panes, pane('d', 'one')],
    }
    const visible = paneGroups(state, 'terminal', WALL).filter((group) => group.visible)
    expect(visible.map((group) => group.id)).toEqual(['a', 'b'])
  })
})
