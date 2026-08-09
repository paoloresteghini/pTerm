import { describe, it, expect } from 'vitest'
import type { TabDescriptor, TabRow } from '../../src/shared/ipc'
import { groupedTabs, tabTree } from '../../src/renderer/lib/tabGroups'

/**
 * The order the tab bar draws panes in, and which of them it frames together.
 *
 * Pure, and deliberately so: a split's new pane lands wherever `applyTabShape`
 * appends it in `state.panes` (`workspace.ts:875`), which need not be next to
 * the pane it split from. `groupedTabs` is the one place that reorders panes
 * back into groups, so both the bar and the `⌥1..9` handler read the same
 * array and cannot disagree about what tab N is. A `TabBar` that sorted
 * privately would make `⌥3` select something other than the third tab on
 * screen, and no test in this file could see that — that risk lives in Task
 * 2's wiring, and `tests/e2e/splits.spec.ts` is where it is checked.
 *
 * Measured (sabotage check, Step 5 of the task brief): each of the four
 * mutations below was applied to `src/renderer/lib/tabGroups.ts`, run against
 * this file, and reverted.
 * 1. `present.length > 1` -> `present.length > 0`: FAILED red as expected —
 *    "draws no frame for a row holding one pane" broke on `pos` being
 *    `'first'` instead of `null`. Also broke "skips a kid that is not in
 *    panes, and frames nothing when one survives" the same way, since that
 *    test asserts the same one-present-member case.
 * 2. `row.layout.kids.map(...)` -> `panes.filter((p) =>
 *    row.layout.kids.includes(p.id))`: FAILED red as expected, and only —
 *    "emits a three-pane row in kids order" broke on order (`panes` order,
 *    not `kids` order).
 * 3. Deleted the `if (emitted.has(pane.id)) continue` line: FAILED red as
 *    expected — "emits every pane exactly once" broke on length (6 entries
 *    for 4 panes). Also broke "handles two groups without letting one absorb
 *    the other" and two more, since every grouped pane is now emitted twice.
 * 4. Dropped the `.filter((member): member is TabDescriptor => ...)` and cast
 *    instead: FAILED red as expected, and only — "skips a kid that is not in
 *    panes" broke, throwing a `TypeError` when the `undefined` member's `.id`
 *    is read rather than reaching the entry list, which is still the correct
 *    test going red for the reason predicted.
 * All four mutations failed the test the brief named (sometimes alongside
 * others asserting the same behavior); none left the suite green.
 */

/** A pane with only the fields this module reads, plus the ones the type needs. */
const pane = (id: string): TabDescriptor => ({
  id,
  projectSlug: 'proj',
  cwd: '/tmp/proj',
  type: 'shell',
})

/** A row over `kids`, keyed by its founder — `kids[0]`, as main keys them. */
const row = (kids: string[]): TabRow => ({
  id: kids[0] ?? '',
  groupId: kids[0] ?? '',
  activePaneId: kids[0] ?? null,
  layout: { dir: 'row', ratio: kids.map(() => 1 / kids.length), kids },
})

/** Just the ids, in emitted order — what the bar draws left to right. */
const order = (entries: ReturnType<typeof groupedTabs>): string[] =>
  entries.map((entry) => entry.pane.id)

describe('groupedTabs', () => {
  it('leaves ungrouped panes in the order they came in', () => {
    const entries = groupedTabs([pane('a'), pane('b'), pane('c')], [])
    expect(order(entries)).toEqual(['a', 'b', 'c'])
    expect(entries.map((entry) => entry.groupId)).toEqual([null, null, null])
    expect(entries.map((entry) => entry.pos)).toEqual([null, null, null])
  })

  it('pulls a split sibling forward to its founder, leaving the rest in place', () => {
    // What `applyTabShape` actually produces: the new pane is appended to the
    // END of `state.panes` (workspace.ts:875), so splitting the FIRST of three
    // tabs puts its sibling last. This is the case the whole module exists for.
    const entries = groupedTabs(
      [pane('a'), pane('b'), pane('c'), pane('a2')],
      [row(['a', 'a2'])],
    )
    expect(order(entries)).toEqual(['a', 'a2', 'b', 'c'])
    expect(entries.map((entry) => entry.pos)).toEqual(['first', 'last', null, null])
    expect(entries.map((entry) => entry.groupId)).toEqual(['a', 'a', null, null])
  })

  it('emits a three-pane row in kids order, not in panes order', () => {
    // `kids` is the on-screen left-to-right order of a `row` tab; `panes` is
    // the order main happened to append them in. They disagree after a split
    // of anything but the last pane, and the bar has to follow the screen.
    const entries = groupedTabs(
      [pane('x'), pane('y'), pane('z')],
      [row(['z', 'x', 'y'])],
    )
    expect(order(entries)).toEqual(['z', 'x', 'y'])
    expect(entries.map((entry) => entry.pos)).toEqual(['first', 'middle', 'last'])
  })

  it('anchors the group where its earliest member already sat', () => {
    // The founder is `b` but `a2` is not involved; the group must appear at
    // b's position, not jump to the front or to the end.
    const entries = groupedTabs(
      [pane('a'), pane('b'), pane('c'), pane('b2')],
      [row(['b', 'b2'])],
    )
    expect(order(entries)).toEqual(['a', 'b', 'b2', 'c'])
  })

  it('draws no frame for a row holding one pane', () => {
    const entries = groupedTabs([pane('a'), pane('b')], [row(['a'])])
    expect(order(entries)).toEqual(['a', 'b'])
    // The group id is still reported — it is true — but `pos` is null, which
    // is what the renderer keys the strip off.
    expect(entries[0]?.groupId).toBe('a')
    expect(entries[0]?.pos).toBeNull()
  })

  it('skips a kid that is not in panes, and frames nothing when one survives', () => {
    // A row can name a pane this project's list does not hold: another
    // project's, or one main has dropped. `panesOfTab` skips those
    // (workspace.ts:286) and so does this.
    const entries = groupedTabs([pane('a'), pane('b')], [row(['a', 'gone'])])
    expect(order(entries)).toEqual(['a', 'b'])
    expect(entries[0]?.pos).toBeNull()
  })

  it('handles two groups without letting one absorb the other', () => {
    const entries = groupedTabs(
      [pane('a'), pane('b'), pane('a2'), pane('b2')],
      [row(['a', 'a2']), row(['b', 'b2'])],
    )
    expect(order(entries)).toEqual(['a', 'a2', 'b', 'b2'])
    expect(entries.map((entry) => entry.groupId)).toEqual(['a', 'a', 'b', 'b'])
    expect(entries.map((entry) => entry.pos)).toEqual(['first', 'last', 'first', 'last'])
  })

  it('emits every pane exactly once', () => {
    // The guard against the obvious bug in a walk that emits members
    // out-of-turn: a pane emitted with its group AND again at its own turn.
    const panes = [pane('a'), pane('b'), pane('a2'), pane('c')]
    const entries = groupedTabs(panes, [row(['a', 'a2'])])
    expect(entries).toHaveLength(panes.length)
    expect(new Set(order(entries)).size).toBe(panes.length)
  })
})

describe('tabTree', () => {
  // A minimal pane. The real TabDescriptor has many more fields; only `id` is
  // read by tabTree, and building the full shape here would tie these tests to
  // fields they say nothing about.
  const pane = (id: string): TabDescriptor => ({ id }) as TabDescriptor
  const row = (id: string, kids: string[]): TabRow =>
    ({ id, layout: { kids } }) as unknown as TabRow

  it('gives a pane in no row a node of its own with no children', () => {
    expect(tabTree([pane('a')], [])).toEqual([{ pane: pane('a'), children: [] }])
  })

  it('gives a row holding one pane no children, so a plain tab grows no twist', () => {
    expect(tabTree([pane('a')], [row('a', ['a'])])).toEqual([
      { pane: pane('a'), children: [] },
    ])
  })

  it('nests a row\'s other kids under its founding pane, in kids order', () => {
    const tree = tabTree(
      [pane('a'), pane('b'), pane('c')],
      [row('a', ['a', 'b', 'c'])],
    )
    expect(tree).toEqual([
      { pane: pane('a'), children: [pane('b'), pane('c')] },
    ])
  })

  it('anchors a group at its earliest member, not at the founding pane', () => {
    // `applyTabShape` appends new panes, so a split of the first of two tabs
    // puts its sibling last in `panes`. The group must still draw where its
    // earliest member sat.
    const tree = tabTree(
      [pane('a'), pane('z'), pane('b')],
      [row('a', ['a', 'b'])],
    )
    expect(tree.map((node) => node.pane.id)).toEqual(['a', 'z'])
    expect(tree[0].children.map((kid) => kid.id)).toEqual(['b'])
  })

  it('promotes the first present kid when the founding pane is gone', () => {
    // Reachable: the founding pane can be closed while its siblings live on.
    // `TabRow.id` is never rewritten, so it can name a pane that is no longer
    // in the tab.
    const tree = tabTree([pane('b'), pane('c')], [row('a', ['a', 'b', 'c'])])
    expect(tree).toEqual([{ pane: pane('b'), children: [pane('c')] }])
  })

  it('drops a kid that is not among the panes given', () => {
    // Another project's pane, or one main has since dropped.
    const tree = tabTree([pane('a')], [row('a', ['a', 'gone'])])
    expect(tree).toEqual([{ pane: pane('a'), children: [] }])
  })

  it('resolves a pane claimed by two rows to the first, matching groupedTabs, and never emits it twice', () => {
    // The rows overlap on `a` and differ in their other kid. Under first-wins,
    // `a` belongs to r1 and brings `b` with it; under last-wins it would belong
    // to r2 and bring `c`. Asserting the FULL tree, not just the first node, is
    // what pins that `a` is emitted exactly once: `r2` still gets a node for
    // `c`, but `c` stands alone rather than dragging `a` back in as a second
    // top-level node headed by a pane that already has one. Asserting only
    // that a node for `a` exists at index 0 passes either way and would not
    // notice `a` reappearing at index 1, which is how the previous version of
    // this test came to be one that could not fail.
    const tree = tabTree(
      [pane('a'), pane('b'), pane('c')],
      [row('r1', ['a', 'b']), row('r2', ['a', 'c'])],
    )
    expect(tree).toEqual([
      { pane: pane('a'), children: [pane('b')] },
      { pane: pane('c'), children: [] },
    ])
  })
})
