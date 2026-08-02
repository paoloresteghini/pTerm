import { describe, it, expect } from 'vitest'
import { sharesAroundClaims, claimFor, tombstonesOf, inLiveFrame } from '../../src/main/ipc/shares'
import { tabRowFor } from '../../src/main/ipc/restore'
import type { TabRow } from '../../src/main/state/store'

/**
 * The other half of the ruling's arithmetic, pinned without a tmux session.
 *
 * `carveRatio.test.ts` owns the split path. This owns the close path —
 * `tabRowFor`, which `register.ts`'s `closePane` rebuilds a tab's row through —
 * and the shared helper both of them scale their shares with.
 *
 * `tests/integration/persistence.test.ts` proves the WIRING: that a pane which
 * really died is really detected as unclaimed, and that the map really reaches
 * both call sites. Neither file stands in for the other, and this one costs no
 * ptys, which is why the cases that are only about numbers live here.
 */
const row = (kids: string[], ratio: number[]): TabRow => ({
  id: 'tab',
  groupId: 'tab',
  activePaneId: kids[0],
  layout: { dir: 'row', ratio, kids },
})

describe('inLiveFrame', () => {
  it('re-expresses the live kids’ shares as shares of what they hold', () => {
    // Half of a whole-tab vector belongs to a pane this row will not name, so
    // the two that are named hold 0.5 between them and take 0.5 each of it.
    expect(inLiveFrame([0.25, 0.25, 0.5], ['a', 'b', 'c'], ['a', 'b'])).toEqual([0.5, 0.5])
  })

  it('is the identity when the live kids hold the whole tab', () => {
    // The control that stops this being satisfied by an implementation that
    // ignores its inputs: with no tombstone the conversion changes nothing,
    // which is what makes this change a strict superset of today's behaviour.
    expect(
      inLiveFrame([0.25, 0.25, 0.3, 0.2], ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd']),
    ).toEqual([0.25, 0.25, 0.3, 0.2])
  })

  it('splits evenly when the live kids hold nothing at all', () => {
    expect(inLiveFrame([0, 0, 1], ['a', 'b', 'c'], ['a', 'b'])).toEqual([0.5, 0.5])
  })

  // The ruling this file's addendum settled: selection is by id, not by
  // position, so the function depends on no contract about where the live
  // ids sit inside `whole`.
  it('selects the live kids by id, not by position', () => {
    // The tombstone is FIRST here, so a prefix slice would take `dead`'s 0.3
    // and `a`'s 0.5 and call them the live pair. Selecting by id takes `a` and
    // `b` — 0.5 and 0.2 of the whole tab, 0.7 between them — wherever they sit.
    // Nothing in production appends a tombstone first today; this test is what
    // stops that being a silent contract instead of an argument.
    expect(inLiveFrame([0.3, 0.5, 0.2], ['dead', 'a', 'b'], ['a', 'b'])).toEqual([0.5 / 0.7, 0.2 / 0.7])
  })
})

describe('tabRowFor with a remembered pane', () => {
  // The close path's own form of the ruling, and the case
  // `persistence.test.ts` measures on a real tab: A alone in the row at 1.0
  // after C's close, B live and claimed by nothing, remembered at 0.2.
  it('gives a remembered kid the share it died at and scales the saved kids into the rest', () => {
    const built = tabRowFor(
      { id: 'tab', groupId: 'tab' },
      ['a', 'b'],
      row(['a'], [1]),
      new Map([['b', { tabId: 'tab', share: 0.2 }]]),
    )
    expect(built.layout.kids).toEqual(['a', 'b'])
    expect(built.layout.ratio[0]).toBeCloseTo(0.8)
    expect(built.layout.ratio[1]).toBeCloseTo(0.2)
    expect(built.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // Two remembered kids at once — the state two deaths in one tab leave, and
  // the reason `forgetTab` has to record a whole-tab fraction rather than the
  // row's own number. Both claims are honoured in full and the saved kid takes
  // what is left, rather than all three being renormalised together.
  it('honours every remembered kid and leaves the saved kids the remainder', () => {
    const built = tabRowFor(
      { id: 'tab', groupId: 'tab' },
      ['a', 'b', 'c'],
      row(['a'], [1]),
      new Map([
        ['b', { tabId: 'tab', share: 0.2 }],
        ['c', { tabId: 'tab', share: 0.3 }],
      ]),
    )
    const at = (id: string): number => built.layout.ratio[built.layout.kids.indexOf(id)]
    expect(built.layout.kids).toHaveLength(3)
    expect(at('b')).toBeCloseTo(0.2)
    expect(at('c')).toBeCloseTo(0.3)
    expect(at('a')).toBeCloseTo(0.5)
    expect(built.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // The saved row outranks the map. Once a split or a close has written a
  // restarted pane back into the row, the row is the authority and the stale
  // claim is never read — which is why nothing deletes the entry at restart.
  it('prefers the saved row over a remembered share for a kid it knows', () => {
    const built = tabRowFor(
      { id: 'tab', groupId: 'tab' },
      ['a', 'b'],
      row(['a', 'b'], [0.6, 0.4]),
      new Map([['b', { tabId: 'tab', share: 0.9 }]]),
    )
    expect(built.layout.ratio[0]).toBeCloseTo(0.6)
    expect(built.layout.ratio[1]).toBeCloseTo(0.4)
  })

  // The no-op, on this side: restore calls this with three arguments, and a
  // kid no saved row knows takes an even share as its RAW one, which is then
  // rescaled alongside the saved kid's. Those are not the same thing and the
  // difference is the whole of this test — `a` keeps 1 and `b` gets 0.5, so
  // they come out 2/3 and 1/3, not half each. Pinned because it is the
  // behaviour that existed before this task and must not have moved: the
  // restore tests all assert through it.
  it('rescales a kid that is neither saved nor remembered against the saved ones', () => {
    const built = tabRowFor({ id: 'tab', groupId: 'tab' }, ['a', 'b'], row(['a'], [1]))
    expect(built.layout.ratio[0]).toBeCloseTo(2 / 3)
    expect(built.layout.ratio[1]).toBeCloseTo(1 / 3)
    expect(built.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // CT-2 on the close path. `a` is the only kid the saved row still knows, `b`
  // died and came back, and `c` died and is still on screen as a tombstone —
  // so `c`'s 0.3 must be held back from the row main writes even though `c`
  // is not in it, and what is left must be expressed as shares of the 0.7 the
  // live kids hold.
  it('holds back a tombstone’s share and emits what the live kids hold', () => {
    const built = tabRowFor(
      { id: 'tab', groupId: 'tab' },
      ['a', 'b'],
      row(['a'], [1]),
      new Map([
        ['b', { tabId: 'tab', share: 0.2 }],
        ['c', { tabId: 'tab', share: 0.3 }],
      ]),
    )
    expect(built.layout.kids).toEqual(['a', 'b'])
    // Whole-tab: a 0.5, b 0.2, c 0.3. The live pair hold 0.7 between them.
    expect(built.layout.ratio[0]).toBeCloseTo(0.5 / 0.7)
    expect(built.layout.ratio[1]).toBeCloseTo(0.2 / 0.7)
    expect(built.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  it('ignores a claim recorded against another tab', () => {
    const built = tabRowFor(
      { id: 'tab', groupId: 'tab' },
      ['a', 'b'],
      row(['a'], [1]),
      new Map([['elsewhere', { tabId: 'other', share: 0.5 }]]),
    )
    // Unchanged from the no-tombstone case: `b` is neither saved nor claimed
    // here, so it takes an even raw share and the two come out 2/3 and 1/3.
    expect(built.layout.ratio[0]).toBeCloseTo(2 / 3)
    expect(built.layout.ratio[1]).toBeCloseTo(1 / 3)
  })
})

describe('sharesAroundClaims', () => {
  it('scales the bases into what the claims leave', () => {
    expect(sharesAroundClaims([{ base: 0.5 }, { base: 0.5 }, { claim: 0.3, base: 0.3 }])).toEqual([
      0.35, 0.35, 0.3,
    ])
  })

  // Neither guard is reachable from `forgetTab` today — one tab's claims sum
  // to less than 1 by induction, and both call sites give every unclaimed kid
  // a positive base. They are pinned anyway, because "unreachable" is a
  // property of two other files that a future caller can take away without
  // ever reading this one.

  // `room <= 0`: the claims have taken the whole tab. Renormalising the
  // entries together is what keeps every pane positive — the claims shrink in
  // proportion and the base still gets a share, rather than a 0%-wide box.
  it('renormalises everything when the claims leave no room', () => {
    const shares = sharesAroundClaims([{ claim: 0.8, base: 0.8 }, { claim: 0.4, base: 0.4 }, { base: 0.8 }])
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
    expect(shares.every((share) => share > 0)).toBe(true)
    expect(shares[0]).toBeCloseTo(0.4)
    expect(shares[1]).toBeCloseTo(0.2)
    expect(shares[2]).toBeCloseTo(0.4)
  })

  // `bases === 0`: every kid is a claim, so there is nothing to scale into the
  // room. The claims are renormalised among themselves — 0.2 and 0.6 come back
  // at a quarter and three quarters, keeping their proportion to each other.
  it('renormalises the claims when there are no bases to scale', () => {
    const shares = sharesAroundClaims([{ claim: 0.2, base: 0.2 }, { claim: 0.6, base: 0.6 }])
    expect(shares[0]).toBeCloseTo(0.25)
    expect(shares[1]).toBeCloseTo(0.75)
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  // Nothing to go on at all. An even split is the only division that needs no
  // data, and it is the only case where this function invents a proportion.
  it('splits evenly when every share is zero', () => {
    expect(sharesAroundClaims([{ base: 0 }, { base: 0 }, { base: 0 }])).toEqual([1 / 3, 1 / 3, 1 / 3])
  })

  // The no-op property in its purest form: with no claim, this IS the
  // `share / total` rescale it replaced at both call sites.
  it('is a plain rescale when nothing is claimed', () => {
    expect(sharesAroundClaims([{ base: 3 }, { base: 1 }])).toEqual([0.75, 0.25])
  })
})

describe('tombstonesOf', () => {
  const claims = new Map([
    ['b', { tabId: 'tab1', share: 0.2 }],
    ['c', { tabId: 'tab1', share: 0.3 }],
    ['far', { tabId: 'tab2', share: 0.4 }],
  ])

  it('answers with the claims this tab’s kids do not name', () => {
    expect(tombstonesOf('tab1', ['a', 'c'], claims)).toEqual([{ id: 'b', share: 0.2 }])
  })

  it('reads only its own tab’s claims', () => {
    // Two tabs with unspent claims at once — the state that made the tab-id
    // filter vacuously true everywhere for a milestone. Without it, `far`
    // would be reported as a tombstone of tab1 and 0.4 of that tab would be
    // held back for a pane in another one.
    expect(tombstonesOf('tab1', ['a'], claims).map((entry) => entry.id)).toEqual(['b', 'c'])
    expect(tombstonesOf('tab2', ['a'], claims)).toEqual([{ id: 'far', share: 0.4 }])
  })

  it('is empty when every claim has been spent', () => {
    expect(tombstonesOf('tab1', ['a', 'b', 'c'], claims)).toEqual([])
  })

  it('is empty for a tab with no claims at all, which is every tab that has never lost a pane', () => {
    expect(tombstonesOf('tab3', ['a', 'b'], claims)).toEqual([])
  })
})

describe('claimFor', () => {
  const claims = new Map([['b', { tabId: 'tab1', share: 0.2 }]])

  it('gives the share a pane is owed in the tab that owes it', () => {
    expect(claimFor('tab1', 'b', claims)).toBeCloseTo(0.2)
  })

  it('gives nothing for the same pane read against another tab', () => {
    // The same filter `tombstonesOf` applies, in the other half of the split:
    // a claim is a fraction of ONE tab, and reading it against a different one
    // would put a share of somebody else's tab into this row.
    expect(claimFor('tab2', 'b', claims)).toBeUndefined()
  })

  it('gives nothing for a pane nothing was recorded for', () => {
    expect(claimFor('tab1', 'zzz', claims)).toBeUndefined()
  })
})
