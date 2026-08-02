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
      tabId: 'tab',
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
      tabId: 'tab',
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
      tabId: 'tab',
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
  // 1. `sum ≈ 1` cannot see whether it happened correctly.
  //    `sharesAroundClaims` forces the sum to 1 regardless of what it was
  //    handed, so a `carveRatio` that ignored the unclaimed sibling's share
  //    entirely would still pass a sum-only assertion.
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
      tabId: 'tab',
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

  // Paolo's ruling, in its smallest form: a REMEMBERED unclaimed sibling — one
  // main watched die, and whose share it kept — claims that share of the WHOLE
  // tab, and the saved-derived shares scale into what is left.
  //
  // The exact numbers are pinned, and they are the ones the integration test
  // measures on a real tmux tab. The rejected alternative was to inject the
  // remembered 0.3 alongside the saved shares and renormalise the lot; it gives
  // `[0.385, 0.385, 0.231]`, which sums to 1 and looks fine, so `sum ≈ 1` does
  // not separate them and neither does the relative-proportion check — `a` and
  // `new` are half of the same share under both. The share `b` itself comes
  // back at is the only thing that tells them apart, which is why it is pinned
  // exactly rather than as "positive".
  it('gives a remembered sibling the share it died at, and scales the rest into the rest', () => {
    const ratio = carveRatio({
      tabId: 'tab',
      kids: ['a', 'new', 'b'],
      sourcePaneId: 'a',
      newPaneId: 'new',
      siblings: ['a', 'b'],
      // The row `restartTab` leaves behind: `b`'s kid entry went with its pane
      // row, so `a` was rescaled to the whole tab on the way back in.
      savedKids: ['a'],
      savedRatio: [1],
      tombstones: new Map([['b', { tabId: 'tab', share: 0.3 }]]),
    })
    expect(ratio[0]).toBeCloseTo(0.35) // a: half of 1, scaled into the 0.7 left
    expect(ratio[1]).toBeCloseTo(0.35) // new: the other half
    expect(ratio[2]).toBeCloseTo(0.3) // b: exactly what it died at
    // By construction here, not by a rescale: 0.35 + 0.35 + 0.3 is 1 because
    // the two halves were scaled into `1 - 0.3` in the first place.
    expect(ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // The claim survives being halved. Splitting a pane that came back from the
  // dead divides ITS remembered share between it and the pane carved out of it
  // — the panes the user did not touch still scale into the rest — rather than
  // demoting both halves and letting them be renormalised against the saved
  // kids, which would bring the pair back narrower than the one pane they
  // replaced.
  it('halves a remembered pane between it and the pane split out of it', () => {
    const ratio = carveRatio({
      tabId: 'tab',
      kids: ['a', 'b', 'new'],
      sourcePaneId: 'b',
      newPaneId: 'new',
      siblings: ['a', 'b'],
      savedKids: ['a'],
      savedRatio: [1],
      tombstones: new Map([['b', { tabId: 'tab', share: 0.3 }]]),
    })
    expect(ratio[0]).toBeCloseTo(0.7) // a: all of what the claim leaves
    expect(ratio[1]).toBeCloseTo(0.15) // b: half its own remembered share
    expect(ratio[2]).toBeCloseTo(0.15) // new: the other half
    expect(ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // CT-2 on the split path, in the ordering the review traced: `b` is a
  // tombstone at 0.2, `c` died and came back claiming 0.3, the saved row knows
  // only `a`, and `a` is split.
  //
  // Whole tab: a 0.25, new 0.25, c 0.30, b 0.20. The three live kids hold 0.80
  // between them, so the row main writes divides that 0.80 among them —
  // 0.3125 / 0.3125 / 0.375. Before this task main emitted 0.35 / 0.35 / 0.30,
  // which the renderer then scaled by the 0.8 it reserves for `b`, drawing
  // `c` at 0.24 when nobody had touched it.
  it('holds back a tombstone’s share and emits what the live kids hold', () => {
    const ratio = carveRatio({
      tabId: 'tab',
      kids: ['a', 'new', 'c'],
      sourcePaneId: 'a',
      newPaneId: 'new',
      siblings: ['a', 'c'],
      savedKids: ['a'],
      savedRatio: [1],
      tombstones: new Map([
        ['b', { tabId: 'tab', share: 0.2 }],
        ['c', { tabId: 'tab', share: 0.3 }],
      ]),
    })
    expect(ratio[0]).toBeCloseTo(0.3125)
    expect(ratio[1]).toBeCloseTo(0.3125)
    expect(ratio[2]).toBeCloseTo(0.375)
    expect(ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // The mirror: `c` is the tombstone at 0.3 and `b` is the pane that came back
  // claiming 0.2. Whole tab: a 0.25, new 0.25, b 0.20, c 0.30; the live kids
  // hold 0.70, so 5/14, 5/14, 2/7. Both orderings are here because the
  // reviewer's rejected candidate was exact in one and inert in the other, and
  // one case cannot tell those apart.
  it('holds back a tombstone’s share when the restarted pane is the other one', () => {
    const ratio = carveRatio({
      tabId: 'tab',
      kids: ['a', 'new', 'b'],
      sourcePaneId: 'a',
      newPaneId: 'new',
      siblings: ['a', 'b'],
      savedKids: ['a'],
      savedRatio: [1],
      tombstones: new Map([
        ['b', { tabId: 'tab', share: 0.2 }],
        ['c', { tabId: 'tab', share: 0.3 }],
      ]),
    })
    expect(ratio[0]).toBeCloseTo(5 / 14)
    expect(ratio[1]).toBeCloseTo(5 / 14)
    expect(ratio[2]).toBeCloseTo(2 / 7)
    expect(ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  it('is unchanged by claims recorded against another tab', () => {
    const args = {
      tabId: 'tab',
      kids: ['a', 'new', 'c', 'b'],
      sourcePaneId: 'a',
      newPaneId: 'new',
      siblings: ['a', 'c', 'b'],
      savedKids: ['a', 'c'],
      savedRatio: [0.6, 0.4],
    }
    const without = carveRatio(args)
    expect(without).toHaveLength(4)
    expect(
      carveRatio({ ...args, tombstones: new Map([['far', { tabId: 'other', share: 0.9 }]]) }),
    ).toEqual(without)
  })
})
