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
