import { describe, it, expect } from 'vitest'
import { carveRatio, claimForDeath } from '../../src/main/ipc/register'
import { tabRowFor } from '../../src/main/ipc/restore'
import { rescaledClaims, type Claim } from '../../src/main/ipc/shares'
import { workspaceReducer, paneGroups, type WorkspaceState } from '../../src/renderer/workspace'
import type { TabDescriptor, TabRow, TabShape } from '../../src/shared/ipc'

/**
 * The seam CT-2 lived in for a milestone: main's arithmetic
 * (`carveRatio`/`tabRowFor`, in `register.ts`/`restore.ts`) and the renderer's
 * merge (`workspaceReducer`'s `split`/`closedPane`, via `withKeptPanes` in
 * `workspace.ts`) had never been driven in the same test file. `carveRatio.test.ts`
 * and `shares.test.ts` call the main side with hand-written `kids`/`siblings`;
 * `workspace.test.ts` drives the reducer with hand-written `TabShape` replies.
 * Both are real coverage of their own half; neither proves the two halves
 * agree about what a row means once it crosses the wire between them.
 *
 * This file drives both from ONE tab, through the real functions in the real
 * order: `claimForDeath` at each death (as `forgetTab` calls it), a local prune
 * of the saved row (as `normaliseLayout` prunes it), `carveRatio`/`tabRowFor`
 * for the row a split or a close would write, and `workspaceReducer`'s `split`/
 * `closedPane` to fold that row into renderer state — the same path
 * `withKeptPanes` is exercised through everywhere else.
 *
 * **What this does NOT show, and cannot:** that main's `tombstones` map and the
 * renderer's `state.dead` agree at runtime. That agreement is a cross-process
 * fact — one map lives in `register.ts`'s closure, the other in a renderer
 * reducer, and nothing but the real IPC round trip connects them. This file
 * builds both sides by hand, from the same story, so every case here has them
 * agreeing by construction; a real disagreement (a `died` event the renderer
 * missed, a tombstone dismissed on one side and not the other) is outside what
 * a unit test can see at all. `tests/integration/persistence.test.ts` is the
 * file that drives main's half against a real tmux session; nothing plays the
 * renderer's half against a real Electron window.
 */

const TAB = 'a'

function pane(id: string): TabDescriptor {
  return { id, projectSlug: 'proj', cwd: '/tmp', tmuxSession: `prcli-proj-${id}`, type: 'shell' }
}

/** A tab row over `kids`, at `ratio` — main's shape and the renderer's alike. */
function row(kids: string[], ratio: number[]): TabRow {
  return { id: TAB, groupId: TAB, activePaneId: kids[0] ?? null, layout: { dir: 'row', ratio, kids } }
}

/** The tab as it starts, before anything dies: A .5 / C .3 / B .2. */
const STARTING_ROW = row(['a', 'c', 'b'], [0.5, 0.3, 0.2])

/**
 * `forgetTab`'s own two steps, run on a row directly instead of through a
 * config file: `claimForDeath` — the exact function `forgetTab` calls — records
 * `id`'s claim into `tombstones` (mutated, exactly as `forgetTab`'s outer map
 * is), and the kid is then dropped and what is left rescaled, which is
 * `normaliseLayout`'s rule for a kid whose pane row has gone (drop-then-divide
 * by the new total, not left holding a hole).
 */
function kill(current: TabRow, id: string, tombstones: Map<string, Claim>): TabRow {
  const at = current.layout.kids.indexOf(id)
  const share = current.layout.ratio[at]
  const claim = claimForDeath({ share, tabId: TAB, kids: current.layout.kids, tombstones })
  if (claim > 0) tombstones.set(id, { tabId: TAB, share: claim })
  const kept = current.layout.kids
    .map((kid, index) => ({ kid, share: current.layout.ratio[index] ?? 0 }))
    .filter((entry) => entry.kid !== id)
  const total = kept.reduce((sum, entry) => sum + entry.share, 0)
  return row(
    kept.map((entry) => entry.kid),
    kept.map((entry) => entry.share / total),
  )
}

/**
 * The row a split of `sourcePaneId` would write, built the way `splitPane`
 * builds it: `siblings` is the saved row's kids unioned with any live pane it
 * does not know (a restarted pane whose row entry `forgetTab` dropped), and the
 * new pane is inserted directly after the pane it split from.
 */
function splitRow(params: {
  saved: TabRow
  sourcePaneId: string
  newPaneId: string
  unclaimed: string[]
  tombstones: ReadonlyMap<string, Claim>
}): { kids: string[]; ratio: number[] } {
  const { saved, sourcePaneId, newPaneId, unclaimed, tombstones } = params
  const savedKids = saved.layout.kids
  const siblings = [...savedKids, ...unclaimed]
  const at = siblings.indexOf(sourcePaneId)
  const kids =
    at === -1
      ? [...siblings, newPaneId]
      : [...siblings.slice(0, at + 1), newPaneId, ...siblings.slice(at + 1)]
  const ratio = carveRatio({
    tabId: TAB,
    kids,
    sourcePaneId,
    newPaneId,
    siblings,
    savedKids,
    savedRatio: saved.layout.ratio,
    tombstones,
  })
  return { kids, ratio }
}

/** Every pane's exact share, off `paneGroups`, with the shape checks the plan asks for. */
function screenShares(state: WorkspaceState): Record<string, number> {
  const groups = paneGroups(state)
  // A regression that folded the tab into two groups (a dropped tombstone
  // stealing its row's id, say) fails here before a single share is read.
  expect(groups).toHaveLength(1)
  const boxes = groups[0].panes
  const ids = boxes.map((box) => box.pane.id)
  // Every pane boxed exactly once — a regression that drops or duplicates a
  // terminal changes this count without necessarily moving any one share.
  expect(new Set(ids).size).toBe(ids.length)
  return Object.fromEntries(boxes.map((box) => [box.pane.id, box.share]))
}

/** The renderer's state right before a split or a close: the tab's row is
 * `STARTING_ROW`, untouched, because neither `died` nor `opened` ever rewrites
 * `state.tabs` — only a `split`/`closedPane` reply does, and none has landed
 * yet in any of these scenarios. `dead` names whichever pane is still a
 * tombstone on screen; the other has been restarted and cleared. */
function priorState(stillDead: string | null): WorkspaceState {
  return {
    projects: [],
    panes: [pane('a'), pane('c'), pane('b')],
    tabs: [STARTING_ROW],
    activeProjectId: null,
    status: {},
    dead: stillDead ? { [stillDead]: 0 } : {},
  }
}

describe('the four orderings of one tab’s death and restart', () => {
  // Two panes die in one order or the other, then one of them restarts, then
  // the tab is split. `claimForDeath`'s discount makes both claims the same
  // whichever pane died first, and the saved row after both deaths is
  // `[A] = [1]` either way — asserted below rather than assumed, since it is
  // the reason all four cases land in the same place.
  const orders: Record<'B first' | 'C first', ['b', 'c'] | ['c', 'b']> = {
    'B first': ['b', 'c'],
    'C first': ['c', 'b'],
  }

  it('records the same two claims, and prunes to the same saved row, whichever pane died first', () => {
    for (const order of Object.values(orders)) {
      const tombstones = new Map<string, Claim>()
      const afterFirst = kill(STARTING_ROW, order[0], tombstones)
      const afterSecond = kill(afterFirst, order[1], tombstones)
      expect(afterSecond.layout.kids).toEqual(['a'])
      expect(afterSecond.layout.ratio[0]).toBeCloseTo(1)
      expect(tombstones.get('b')?.share).toBeCloseTo(0.2)
      expect(tombstones.get('c')?.share).toBeCloseTo(0.3)
    }
  })

  const cases: {
    label: string
    order: ['b', 'c'] | ['c', 'b']
    restarted: 'b' | 'c'
    main: Record<string, number>
    screen: Record<string, number>
  }[] = [
    {
      label: 'B dies, C dies, C restarted',
      order: orders['B first'],
      restarted: 'c',
      main: { a: 0.3125, new: 0.3125, c: 0.375 },
      screen: { a: 0.25, new: 0.25, c: 0.3, b: 0.2 },
    },
    {
      label: 'C dies, B dies, C restarted',
      order: orders['C first'],
      restarted: 'c',
      main: { a: 0.3125, new: 0.3125, c: 0.375 },
      screen: { a: 0.25, new: 0.25, c: 0.3, b: 0.2 },
    },
    {
      label: 'B dies, C dies, B restarted',
      order: orders['B first'],
      restarted: 'b',
      main: { a: 5 / 14, new: 5 / 14, b: 2 / 7 },
      screen: { a: 0.25, new: 0.25, c: 0.3, b: 0.2 },
    },
    {
      label: 'C dies, B dies, B restarted',
      order: orders['C first'],
      restarted: 'b',
      main: { a: 5 / 14, new: 5 / 14, b: 2 / 7 },
      screen: { a: 0.25, new: 0.25, c: 0.3, b: 0.2 },
    },
  ]

  for (const { label, order, restarted, main, screen } of cases) {
    it(label, () => {
      const tombstones = new Map<string, Claim>()
      const afterFirst = kill(STARTING_ROW, order[0], tombstones)
      const savedRow = kill(afterFirst, order[1], tombstones)

      const { kids, ratio } = splitRow({
        saved: savedRow,
        sourcePaneId: 'a',
        newPaneId: 'new',
        // The restarted pane is live and back in `config.panes`, but no row
        // claims it yet — exactly the "unclaimed sibling" `splitPane` unions in.
        unclaimed: [restarted],
        tombstones,
      })

      // What main puts on the wire — the row it writes to disk and hands back.
      for (const [id, share] of Object.entries(main)) {
        expect(ratio[kids.indexOf(id)]).toBeCloseTo(share)
      }
      expect(ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)

      const shape: TabShape = {
        panes: kids.map((id) => pane(id)),
        tabs: [row(kids, ratio)],
      }
      const stillDead = restarted === 'b' ? 'c' : 'b'
      const next = workspaceReducer(priorState(stillDead), { type: 'split', shape })

      // What the user actually sees, once `withKeptPanes` folds main's row —
      // which never named the still-dead pane — back into the renderer's own.
      const shares = screenShares(next)
      for (const [id, share] of Object.entries(screen)) {
        expect(shares[id]).toBeCloseTo(share)
      }
    })
  }
})

describe('three controls, unmoved by any of this', () => {
  // Split A on the untouched starting row. No claim, no tombstone — the plain
  // carve `carveRatio` always did, on both sides.
  it('nothing ever died', () => {
    const kids = ['a', 'new', 'c', 'b']
    const ratio = carveRatio({
      tabId: TAB,
      kids,
      sourcePaneId: 'a',
      newPaneId: 'new',
      siblings: ['a', 'c', 'b'],
      savedKids: ['a', 'c', 'b'],
      savedRatio: [0.5, 0.3, 0.2],
    })
    expect(ratio[0]).toBeCloseTo(0.25)
    expect(ratio[1]).toBeCloseTo(0.25)
    expect(ratio[2]).toBeCloseTo(0.3)
    expect(ratio[3]).toBeCloseTo(0.2)

    const shape: TabShape = { panes: kids.map((id) => pane(id)), tabs: [row(kids, ratio)] }
    const next = workspaceReducer(priorState(null), { type: 'split', shape })
    const shares = screenShares(next)
    expect(shares.a).toBeCloseTo(0.25)
    expect(shares.new).toBeCloseTo(0.25)
    expect(shares.c).toBeCloseTo(0.3)
    expect(shares.b).toBeCloseTo(0.2)
  })

  // B died and came back; C never touched. One claim, no tombstone — the case
  // that stops "reserve everything in the map" from being the implementation:
  // B's claim is SPENT the moment the row names it, and reserving it anyway
  // would shrink the whole tab by 0.2 for nothing.
  it('B died and came back, nothing else', () => {
    const tombstones = new Map<string, Claim>()
    const savedRow = kill(STARTING_ROW, 'b', tombstones)
    expect(savedRow.layout.kids).toEqual(['a', 'c'])
    expect(savedRow.layout.ratio[0]).toBeCloseTo(0.625)
    expect(savedRow.layout.ratio[1]).toBeCloseTo(0.375)
    expect(tombstones.get('b')?.share).toBeCloseTo(0.2)

    const { kids, ratio } = splitRow({
      saved: savedRow,
      sourcePaneId: 'a',
      newPaneId: 'new',
      unclaimed: ['b'],
      tombstones,
    })
    expect(ratio[kids.indexOf('a')]).toBeCloseTo(0.25)
    expect(ratio[kids.indexOf('new')]).toBeCloseTo(0.25)
    expect(ratio[kids.indexOf('c')]).toBeCloseTo(0.3)
    expect(ratio[kids.indexOf('b')]).toBeCloseTo(0.2)

    const shape: TabShape = { panes: kids.map((id) => pane(id)), tabs: [row(kids, ratio)] }
    const next = workspaceReducer(priorState(null), { type: 'split', shape })
    const shares = screenShares(next)
    expect(shares.a).toBeCloseTo(0.25)
    expect(shares.new).toBeCloseTo(0.25)
    expect(shares.c).toBeCloseTo(0.3)
    expect(shares.b).toBeCloseTo(0.2)
  })

  // A claim recorded against a different tab: present in the map, absent from
  // every number this tab emits. `carveRatio.test.ts` pins this in isolation;
  // it is repeated here against the composition's own two-death map, so a
  // future change to how claims are filtered cannot pass one file and fail
  // the other.
  it('a claim recorded against another tab changes nothing here', () => {
    const tombstones = new Map<string, Claim>([
      ['b', { tabId: TAB, share: 0.2 }],
      ['c', { tabId: TAB, share: 0.3 }],
    ])
    const without = splitRow({
      saved: row(['a'], [1]),
      sourcePaneId: 'a',
      newPaneId: 'new',
      unclaimed: ['c'],
      tombstones,
    })
    const withOther = splitRow({
      saved: row(['a'], [1]),
      sourcePaneId: 'a',
      newPaneId: 'new',
      unclaimed: ['c'],
      tombstones: new Map([...tombstones, ['far', { tabId: 'other-tab', share: 0.9 }]]),
    })
    expect(withOther).toEqual(without)
  })
})

describe('two compositions beyond a single split', () => {
  // Both start from case 1 above: B dies, C dies, C restarted, A is split. The
  // row main actually PERSISTS after that split is the carve's own output —
  // `new`/`c` at .3125/.3125/.375 — and `tombstones` still carries B's unspent
  // 0.2 and C's now-spent 0.3, since nothing ever deletes a spent entry.
  const tombstones = new Map<string, Claim>()
  const afterFirstDeath = kill(STARTING_ROW, 'b', tombstones)
  const savedAfterBothDeaths = kill(afterFirstDeath, 'c', tombstones)
  const firstSplit = splitRow({
    saved: savedAfterBothDeaths,
    sourcePaneId: 'a',
    newPaneId: 'new',
    unclaimed: ['c'],
    tombstones,
  })
  const firstShape: TabShape = {
    panes: firstSplit.kids.map((id) => pane(id)),
    tabs: [row(firstSplit.kids, firstSplit.ratio)],
  }
  const afterFirstSplit = workspaceReducer(priorState('b'), { type: 'split', shape: firstShape })
  const mainRowAfterFirstSplit = row(firstSplit.kids, firstSplit.ratio)

  it('split twice: the tombstone and the pane it never touched both hold their exact share across the round trip', () => {
    const second = splitRow({
      saved: mainRowAfterFirstSplit,
      sourcePaneId: 'a',
      newPaneId: 'n2',
      unclaimed: [],
      tombstones,
    })
    expect(second.kids).toEqual(['a', 'n2', 'new', 'c'])
    expect(second.ratio[second.kids.indexOf('a')]).toBeCloseTo(0.15625)
    expect(second.ratio[second.kids.indexOf('n2')]).toBeCloseTo(0.15625)
    expect(second.ratio[second.kids.indexOf('new')]).toBeCloseTo(0.3125)
    expect(second.ratio[second.kids.indexOf('c')]).toBeCloseTo(0.375)
    expect(second.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)

    const shape: TabShape = {
      panes: second.kids.map((id) => pane(id)),
      tabs: [row(second.kids, second.ratio)],
    }
    const next = workspaceReducer(afterFirstSplit, { type: 'split', shape })
    const shares = screenShares(next)
    expect(shares.a).toBeCloseTo(0.125)
    expect(shares.n2).toBeCloseTo(0.125)
    expect(shares.new).toBeCloseTo(0.25)
    // The property worth having: the tombstone is still at exactly 0.20 and C
    // still at exactly 0.30 after a second round trip, not merely correct once.
    expect(shares.c).toBeCloseTo(0.3)
    expect(shares.b).toBeCloseTo(0.2)
  })

  it('close, on the same tab: the tombstone keeps its share and A:C keep their proportion', () => {
    const savedKids = mainRowAfterFirstSplit.layout.kids.filter((kid) => kid !== 'new')
    const built = tabRowFor({ id: TAB, groupId: TAB }, savedKids, mainRowAfterFirstSplit, tombstones)
    expect(built.layout.kids).toEqual(['a', 'c'])
    expect(built.layout.ratio[0]).toBeCloseTo(5 / 11)
    expect(built.layout.ratio[1]).toBeCloseTo(6 / 11)
    expect(built.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)

    const shape: TabShape = {
      panes: built.layout.kids.map((id) => pane(id)),
      tabs: [built],
    }
    const next = workspaceReducer(afterFirstSplit, { type: 'closedPane', paneId: 'new', shape })
    const shares = screenShares(next)
    // `closePane`'s standing "close is already right" ruling, now through a
    // tombstone: B keeps its 0.20 exactly, and A:C keep the 0.25:0.30
    // proportion they had before the close — 4/11 : (24/55) is 0.25 : 0.3.
    expect(shares.b).toBeCloseTo(0.2)
    expect(shares.a).toBeCloseTo(4 / 11)
    expect(shares.c / shares.a).toBeCloseTo(0.3 / 0.25)
  })
})

describe('a dismiss, then a restart and split', () => {
  // `register.ts`'s `dismissTab` handler, run here as its own two steps: read
  // the claim before deleting it (the record is the only place left that says
  // which tab a dismissed pane was in), then grow what is left of THAT tab
  // into the room it leaves. Mirrors `kill` above in spirit — a small
  // reimplementation of the production step, not a call into `ipcMain`.
  function dismiss(id: string, tombstones: Map<string, Claim>): void {
    const held = tombstones.get(id)
    // Never assert over a collection without first asserting it is non-empty.
    expect(held).toBeDefined()
    tombstones.delete(id)
    for (const [paneId, claim] of rescaledClaims(held!.tabId, held!.share, tombstones)) {
      tombstones.set(paneId, claim)
    }
  }

  it('a dismissed tombstone’s share grows the other into it, on both sides, so a later restart returns it honest', () => {
    // B dies, then C dies — the same setup case 1 above starts from: main's
    // persisted row drops to `[A] = [1]` and `tombstones` records B at 0.2,
    // C at 0.3 (both whole-tab fractions, and both amounts pinned already by
    // 'records the same two claims...' above).
    const tombstones = new Map<string, Claim>()
    const afterFirstDeath = kill(STARTING_ROW, 'b', tombstones)
    const savedAfterBothDeaths = kill(afterFirstDeath, 'c', tombstones)
    expect(tombstones.get('b')?.share).toBeCloseTo(0.2)
    expect(tombstones.get('c')?.share).toBeCloseTo(0.3)

    // B is dismissed. Main's side: `dismiss` above.
    dismiss('b', tombstones)
    // Wire value: C's claim, grown from the 0.3 it died at into 0.375 — its
    // share of the tab now that B's 0.2 is no longer part of it.
    expect(tombstones.get('c')?.share).toBeCloseTo(0.375)
    expect(tombstones.get('b')).toBeUndefined()

    // The renderer's side of the same dismiss: `state.tabs`'s row for this tab
    // is still `STARTING_ROW` untouched (nothing has rewritten it since either
    // pane died), so `withoutKid`, via the `dismissed` action, drops B out of
    // it and renormalises A and C over what is left — independently of main,
    // and by construction from the same starting numbers.
    const priorWithBothDead: WorkspaceState = { ...priorState('b'), dead: { b: 0, c: 0 } }
    const afterDismiss = workspaceReducer(priorWithBothDead, { type: 'dismissed', id: 'b' })
    const dismissedRow = afterDismiss.tabs[0]
    expect(dismissedRow.layout.kids).toEqual(['a', 'c'])
    // Screen value: the same 0.375 C's wire claim now carries, reached by the
    // renderer's own arithmetic rather than by reading main's map. They agree
    // because both are "the survivor's old share, divided by 1 minus what
    // left" — the same rule, run twice on the same starting numbers, not a
    // coincidence of these particular fractions.
    expect(dismissedRow.layout.ratio[dismissedRow.layout.kids.indexOf('c')]).toBeCloseTo(0.375)
    expect(dismissedRow.layout.ratio[dismissedRow.layout.kids.indexOf('a')]).toBeCloseTo(0.625)

    // C restarts, A is split. Main carves the row from `savedAfterBothDeaths`
    // — still `[A] = [1]`, since a dismiss never touches the persisted row,
    // only the tombstone map — using the now-rescaled `tombstones`.
    const { kids, ratio } = splitRow({
      saved: savedAfterBothDeaths,
      sourcePaneId: 'a',
      newPaneId: 'new',
      unclaimed: ['c'],
      tombstones,
    })
    // Wire values: what main puts on the row it writes and hands back.
    // Without the rescale (Step 5's A/B) this reads A .35 / new .35 / C .30 —
    // the brief's measured defect, C recovered at what it died at rather than
    // at what it was worth the moment B left.
    expect(ratio[kids.indexOf('a')]).toBeCloseTo(0.3125)
    expect(ratio[kids.indexOf('new')]).toBeCloseTo(0.3125)
    expect(ratio[kids.indexOf('c')]).toBeCloseTo(0.375)
    expect(ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)

    const shape: TabShape = {
      panes: kids.map((id) => pane(id)),
      tabs: [row(kids, ratio)],
    }
    const next = workspaceReducer(afterDismiss, { type: 'split', shape })
    const shares = screenShares(next)
    // Screen values: B is gone outright — dismissed, not merely dead — and C
    // comes back at exactly the 0.375 it was worth the moment it was
    // dismissed, not the 0.30 it died at.
    expect(Object.keys(shares)).not.toContain('b')
    expect(shares.a).toBeCloseTo(0.3125)
    expect(shares.new).toBeCloseTo(0.3125)
    expect(shares.c).toBeCloseTo(0.375)
  })
})

describe('the whole-tab property, exhaustively', () => {
  /**
   * The four describes above are the seed; this is the check that there is no
   * fifth. The property is the recommendation's central claim: for any
   * sequence of deaths, restarts and dismisses, main's row — `kill`/`splitRow`
   * above, the exact steps `forgetTab`/`splitPane` take — composed through the
   * renderer's merge (`workspaceReducer`'s `split`, via `withKeptPanes`)
   * reproduces the whole-tab vector a tab of A .5 / C .3 / B .2 should show.
   *
   * **Enumerated, not generated.** Over three panes, "which die, in which
   * order, which come back, which are dismissed, then which surviving pane is
   * split" is small enough to enumerate completely — 276 reachable cases,
   * derived by a closed form independent of the generator below and pinned in
   * the first `it`, so a change to the generator cannot silently shrink the
   * count without a test noticing. Reproducible, prints the exact case it
   * failed on, and needs no library — a random property test would be the
   * first of its kind in this repo and would bring flake, seeds and shrinking
   * decisions that nothing here needs. The day three panes stops being enough
   * to enumerate is the day to reach for one.
   *
   * **The oracle is a model kept by the test itself (`buildModel`, below),
   * independent of every production function.** Starts at `STARTING_ROW`'s own
   * `{a: .5, c: .3, b: .2}`; a death changes nothing; a restart changes
   * nothing; a dismiss removes the entry and divides the rest by what is
   * left; a split halves the source's entry and gives the other half to the
   * new pane. `kill`, `splitRow` and `workspaceReducer` are the real functions
   * under test; the model shares no code with any of them, which is what
   * makes its agreement with them evidence rather than a tautology — and also
   * why its SECOND A/B, below, breaks the model rather than the code: an
   * oracle that drifts from what the app should do is a test that pins the
   * wrong thing.
   *
   * **What this does NOT show, and cannot: `inLiveFrame`.** The property is
   * asserted off `paneGroups` — what is actually drawn — and `inLiveFrame` is
   * exactly one positive scalar over every live share: `withKeptPanes`
   * divides by the incoming sum (`src/renderer/workspace.ts:763`) and
   * `boxesOfRow` divides by the kept total (`src/renderer/workspace.ts:567`),
   * so a uniform rescale of main's row is invisible to both. A mutation that
   * broke only `inLiveFrame` would leave every case here green — not because
   * this property is weak, but because `inLiveFrame` is a wire-frame
   * conversion, not a screen one; the file's own A/B (a), below, mutates a
   * different line for exactly this reason. `inLiveFrame` is pinned on the
   * wire instead, by `tests/unit/carveRatio.test.ts`, `tests/unit/shares.test.ts`,
   * and by this file's own wire-level assertions in the four-orderings,
   * two-compositions and dismiss describes above.
   *
   * **Skipped: a tab whose every pane is dead, with none restarted.** There is
   * then no live pane to split from, and `closedPane` — never exercised by
   * this property, which only ever drives a `split` — is what would drop such
   * a tab's row instead. Every other combination reaches a split; the skip
   * count is pinned alongside the case count in the first `it`, below.
   */

  type PaneId = 'a' | 'c' | 'b'
  const ALL: PaneId[] = ['a', 'c', 'b']
  const START: Record<string, number> = Object.fromEntries(
    STARTING_ROW.layout.kids.map((id, index) => [id, STARTING_ROW.layout.ratio[index]]),
  )

  /** Every subset of `xs`, `[]` included, order-of-generation only. */
  function subsetsOf<T>(xs: readonly T[]): T[][] {
    return xs.reduce<T[][]>((subsets, x) => [...subsets, ...subsets.map((s) => [...s, x])], [[]])
  }

  /** Every ordering of `xs`. `[]` has exactly one: itself. */
  function permutationsOf<T>(xs: readonly T[]): T[][] {
    if (xs.length === 0) return [[]]
    return xs.flatMap((x, at) => {
      const rest = [...xs.slice(0, at), ...xs.slice(at + 1)]
      return permutationsOf(rest).map((tail) => [x, ...tail])
    })
  }

  /**
   * The whole-tab vector the app SHOULD show after `dismissed` (in any order —
   * proved order-independent below) and a final split of `source` into
   * `newId`. No production function is called here.
   */
  function buildModel(
    dismissed: readonly PaneId[],
    source: PaneId,
    newId: string,
  ): Record<string, number> {
    const model = { ...START }
    for (const id of dismissed) {
      const removed = model[id]
      delete model[id]
      const room = 1 - removed
      for (const key of Object.keys(model)) model[key] = model[key] / room
    }
    const half = model[source] / 2
    model[source] = half
    model[newId] = half
    return model
  }

  interface Case {
    label: string
    deathOrder: PaneId[]
    restarted: PaneId[]
    dismissed: PaneId[]
    source: PaneId
  }

  const cases: Case[] = []
  const skipped: { deathOrder: PaneId[]; restarted: PaneId[]; dismissed: PaneId[] }[] = []

  for (const dead of subsetsOf(ALL)) {
    for (const deathOrder of permutationsOf(dead)) {
      for (const restarted of subsetsOf(dead)) {
        // Dismissed is a subset of what died and was NOT restarted — a
        // restarted pane is live again and cannot be dismissed, and a pane
        // that never died has no claim to dismiss.
        const stillDead = dead.filter((id) => !restarted.includes(id))
        for (const dismissed of subsetsOf(stillDead)) {
          // `stillDead` alone decides which panes are live to split from:
          // whether a still-dead pane is later dismissed or stays a
          // tombstone changes nothing about what is SPLITTABLE right now.
          const live = ALL.filter((id) => !stillDead.includes(id))
          const tag = `died[${deathOrder.join('') || '-'}] restarted[${restarted.join('') || '-'}] dismissed[${dismissed.join('') || '-'}]`
          if (live.length === 0) {
            skipped.push({ deathOrder, restarted, dismissed })
            continue
          }
          for (const source of live) {
            cases.push({ label: `${tag} split[${source}]`, deathOrder, restarted, dismissed, source })
          }
        }
      }
    }
  }

  it('enumerates every reachable case, not a silently smaller number', () => {
    // Independent of the generator above: for a dead subset of size k, r of
    // it restarted, the live count to split from is (3-k+r), and the number
    // of ways to choose which r are restarted and how the other k-r split
    // between dismissed/still-tombstone is C(k,r)*2^(k-r). Summed over r and
    // weighted by C(3,k) subsets and k! orderings:
    //   k=0: 1 * 1 * [1*1*3]                      =  3
    //   k=1: 3 * 1 * [1*2*2 + 1*1*3]               = 21
    //   k=2: 3 * 2 * [1*4*1 + 2*2*2 + 1*1*3]        = 90
    //   k=3: 1 * 6 * [1*8*0 + 3*4*1 + 3*2*2 + 1*1*3] = 162
    // 3 + 21 + 90 + 162 = 276. The one zero term above (k=3, r=0 — every pane
    // dead, none restarted) is the only skip: 1 subset * 6 orders * 8
    // dismissed-subsets-of-the-remaining-three = 48.
    expect(cases.length).toBe(276)
    expect(skipped.length).toBe(48)
  })

  for (const { label, deathOrder, restarted, dismissed, source } of cases) {
    it(label, () => {
      const model = buildModel(dismissed, source, 'new')

      // Main's half: `kill` for every death, in order, then each dismiss's
      // own step — `register.ts`'s `dismissTab`, run by hand exactly as the
      // dismiss describe above does — then the row a split would carve.
      const tombstones = new Map<string, Claim>()
      let savedRow = STARTING_ROW
      for (const id of deathOrder) savedRow = kill(savedRow, id, tombstones)
      for (const id of dismissed) {
        const held = tombstones.get(id)
        // Never assert over a collection without first asserting it is
        // non-empty: `id` is in `dismissed` only because it is in `dead`, so
        // its claim must already be on record.
        expect(held).toBeDefined()
        tombstones.delete(id)
        for (const [paneId, claim] of rescaledClaims(held!.tabId, held!.share, tombstones)) {
          tombstones.set(paneId, claim)
        }
      }
      const { kids, ratio } = splitRow({
        saved: savedRow,
        sourcePaneId: source,
        newPaneId: 'new',
        unclaimed: restarted,
        tombstones,
      })

      // The renderer's half: the same events, through the real reducer, in
      // the order they would actually arrive — `died` per death, `opened` per
      // restart (the action a restart's reply dispatches, and the one that
      // clears `state.dead`), `dismissed` per dismiss — then the `split`
      // reply main's half just built.
      let renderer: WorkspaceState = {
        projects: [],
        panes: [pane('a'), pane('c'), pane('b')],
        tabs: [STARTING_ROW],
        activeProjectId: null,
        status: {},
        dead: {},
      }
      for (const id of deathOrder) {
        renderer = workspaceReducer(renderer, { type: 'died', id, code: 1 })
      }
      for (const id of restarted) {
        renderer = workspaceReducer(renderer, { type: 'opened', tab: pane(id) })
      }
      for (const id of dismissed) {
        renderer = workspaceReducer(renderer, { type: 'dismissed', id })
      }

      const shape: TabShape = { panes: kids.map((id) => pane(id)), tabs: [row(kids, ratio)] }
      const next = workspaceReducer(renderer, { type: 'split', shape })

      // `screenShares` asserts exactly one group and every pane boxed exactly
      // once — the second of the three checks the plan asks for.
      const shares = screenShares(next)
      const modelIds = Object.keys(model).sort()
      const shareIds = Object.keys(shares).sort()
      // Non-empty before comparing: `model` always keeps every pane that was
      // not dismissed, plus the new one, so this can never be `[]`.
      expect(modelIds.length).toBeGreaterThan(0)
      expect(shareIds).toEqual(modelIds)
      // Every pane on screen has exactly the model's share, to four places.
      for (const id of modelIds) {
        expect(shares[id]).toBeCloseTo(model[id], 4)
      }
      // The shares sum to 1 — necessary, not sufficient (a vector that sums
      // to 1 but has moved a share between two panes would still pass this
      // alone; the per-pane equality above is what actually pins the
      // assignment) — and stated as such rather than left to be assumed.
      const sum = Object.values(shares).reduce((total, share) => total + share, 0)
      expect(sum).toBeCloseTo(1)
    })
  }
})
