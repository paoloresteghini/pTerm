import { describe, it, expect } from 'vitest'
import { carveRatio } from '../../src/main/ipc/register'

/**
 * `carveRatio`'s own math, pinned without a real tmux session anywhere near
 * it — the reason it was pulled out of `splitPane`'s closure into a pure,
 * exported function in the first place. `tests/integration/persistence.test.ts`
 * still owns proving that the real "which sibling has no row entry" detection
 * feeds this correctly; this file owns the arithmetic once it has.
 */
describe('carveRatio', () => {
  it('splits a lone pane evenly, with no saved row to carve from', () => {
    // No saved row at all: `savedKids` falls back to `[paneId]` at the call
    // site, and `savedRatio` to `[]` — the first-split case.
    const ratio = carveRatio({
      kids: ['a', 'b'],
      sourcePaneId: 'a',
      newPaneId: 'b',
      siblings: ['a'],
      savedKids: ['a'],
      savedRatio: [],
    })
    expect(ratio).toEqual([0.5, 0.5])
  })

  it('carves half the source share for the new pane and leaves every other known kid alone', () => {
    // The tab's persistence.test.ts scenario: A=0.7, B=0.3, split B — B
    // keeps half its own share, the new pane gets the other half, A is
    // untouched.
    const ratio = carveRatio({
      kids: ['a', 'b', 'new'],
      sourcePaneId: 'b',
      newPaneId: 'new',
      siblings: ['a', 'b'],
      savedKids: ['a', 'b'],
      savedRatio: [0.7, 0.3],
    })
    expect(ratio[0]).toBeCloseTo(0.7)
    expect(ratio[1]).toBeCloseTo(0.15)
    expect(ratio[2]).toBeCloseTo(0.15)
  })

  it('inserts the new pane at its own kids-order index, not by iterating siblings', () => {
    // A regression the shape of the fix above could reintroduce: `shares` is
    // built by mapping over `kids`, not `siblings`, so the new pane's slot
    // must land wherever `kids` actually puts it rather than at the source
    // pane's old position.
    const ratio = carveRatio({
      kids: ['a', 'new', 'b'],
      sourcePaneId: 'a',
      newPaneId: 'new',
      siblings: ['a', 'b'],
      savedKids: ['a', 'b'],
      savedRatio: [0.6, 0.4],
    })
    expect(ratio[0]).toBeCloseTo(0.3) // a: half its own 0.6
    expect(ratio[1]).toBeCloseTo(0.3) // new: the other half
    expect(ratio[2]).toBeCloseTo(0.4) // b: untouched
  })

  // The Critical a review round found: an unclaimed sibling — a live pane
  // with no seat in `savedKids`, which today only happens to a pane that
  // died and was restarted after `forgetTab` dropped its row entry — gets a
  // SYNTHETIC share here (`shareOf`'s `at === -1` branch) on top of shares
  // that, among the known kids, already summed to 1. The normalisation this
  // forces is not a bug: three panes cannot occupy 0.6 + 0.4 + (anything
  // positive) without something moving.
  //
  // Two things are true about that movement, and this test asserts both,
  // because neither alone is sufficient:
  //
  // 1. `sum ≈ 1` cannot see whether it happened correctly. The
  //    `total > 0 ? shares.map(...) : ...` line forces the sum to 1
  //    regardless of what `shares` held going in, so a `carveRatio` that
  //    ignored the unclaimed sibling's share entirely would still pass a
  //    sum-only assertion.
  //
  // 2. The RELATIVE proportion between the two known kids (`a` and `c`) is
  //    unchanged — still 0.6:0.4 — which sounds like the fix, and IS a real,
  //    worth-having property. But it turns out not to be sensitive to this
  //    bug either, and this was found by actually running the A/B rather
  //    than assumed: `a`, `new` and `c`'s own raw shares never read `b`'s
  //    value at all, so whatever `b` contributes only changes the common
  //    total every share is divided by — and that total cancels out of a
  //    ratio taken between two kids that both divide by it. Zero out `b`'s
  //    share entirely and `a:c` still comes out 0.6:0.4, because the
  //    normalisation that used to dilute both by 1/1.333 now divides both by
  //    1/1 instead — same ratio, different scale. The assertion that
  //    actually catches an ignored (or double-counted) unclaimed sibling has
  //    to look at that sibling's OWN final share, not at anyone else's.
  //
  // Pinned as a ratio rather than at the exact values (0.225 / 0.225 / 0.3 /
  // 0.25) for the reason Task 8 gives: it changes how a remembered kid's
  // share is computed, and the relative invariant holds under both, while an
  // absolute pin would need rewriting the moment that lands. `b`'s own
  // share is asserted as "positive", not pinned exactly, for the same
  // reason.
  it('dilutes every known share evenly when an unclaimed sibling reclaims one, and preserves their relative sizes', () => {
    const ratio = carveRatio({
      kids: ['a', 'new', 'c', 'b'],
      sourcePaneId: 'a',
      newPaneId: 'new',
      // `siblings` is the saved row's kids UNIONED with the unclaimed live
      // pane `b` — exactly what `splitPane` builds before calling this.
      siblings: ['a', 'c', 'b'],
      savedKids: ['a', 'c'],
      savedRatio: [0.6, 0.4],
    })
    const [a, newShare, c, b] = ratio
    // The property worth having, and genuinely true — but see the comment
    // above: this assertion by itself does NOT fail when `b`'s share is
    // dropped to zero, because the common divisor cancels out of the ratio.
    expect(c / (a + newShare)).toBeCloseTo(0.4 / 0.6)
    // The one that actually catches it: the unclaimed sibling ends up with
    // SOME share of the axis, rather than none. A `carveRatio` that ignored
    // `b` entirely gives it exactly 0 here.
    expect(b).toBeGreaterThan(0)
    // Necessary, not sufficient on its own — see point 1 above.
    expect(ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })
})
