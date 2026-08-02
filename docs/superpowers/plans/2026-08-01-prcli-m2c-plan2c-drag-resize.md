# M2c Plan 2c — Drag-resize, and a ratio that survives

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a tab's ratios something the user sets and the app keeps — a draggable divider, a floor that stops a pane becoming unusable, persistence on mouse-up, and a ratio that survives both a split and a pane's death-and-restart.

**Architecture:** Ratios live in `state.tabs` during the gesture, so `paneGroups` reflows the panes and `Terminal.tsx`'s existing `ResizeObserver` drives tmux with no new push path. The arithmetic is pure functions in `workspace.ts`; the gesture is a thin DOM wrapper over them. Main coalesces the resulting resize storm and remembers a dead pane's share.

**Tech Stack:** TypeScript, Electron main, React renderer, node-pty, real tmux 3.7b via `TmuxAdapter`, Vitest (`npm test`), Playwright (`npm run e2e`, not run on this plan).

**Spec:** `docs/superpowers/specs/2026-08-01-prcli-m2c-plan2c-drag-resize-design.md`
**Base:** `master` at `a29ada1`.

## Global Constraints

- Tests use `-L prcli-test` only, via `new TmuxAdapter({ socket: 'prcli-test' })`. **Never the default socket.** `tmux -L prcli-test kill-server` is the established teardown; a bare `kill-server` is forbidden.
- Tests never touch the real `~/.prcli` (`PRCLI_CONFIG_DIR`), `~/Code` (`PRCLI_PROJECTS_ROOT`) or `~/.claude/settings.json` (`PRCLI_CLAUDE_SETTINGS`).
- **Never run `npm install` / `npm ci`.** It breaks node-pty's spawn-helper permissions and fails every integration test with `posix_spawnp failed`.
- **Never weaken, delete or loosen a test assertion, timeout or poll interval to make something pass.** If an assertion contradicts the code, stop and report.
- **Never assert over a collection without first asserting it is non-empty.** `[].every(...)` is `true`.
- **`expect.poll` cannot assert the absence of a change.** It returns on its first match. Poll for a transition; settle then assert plainly for a non-change.
- A/B every load-bearing assertion by breaking the production code it guards. **Before committing, `git diff` on production files must be empty of the mutation.** **Restore an A/B by snapshot copy (`cp file file.bak` … `cp file.bak file`), never by `git checkout -- <file>`** — that restores to HEAD and wipes uncommitted work, which happened on 2b.
- `register.ts`'s `serialise` queue has **no reentrancy protection**. Nothing running inside it may call it again. `rememberTab` and `forgetTab` are themselves `serialise` wrappers.
- `App.tsx` keeps every terminal mounted and toggles `visibility`, not `display`. Both of `Terminal.tsx`'s `fitToContainer` guards stay **above** the fit.
- **A comment asserting a mechanism that is not true is a defect here.**
- No DOM in this suite (`environment: 'node'`, no jsdom). Logic goes in pure functions; gesture wiring gets a **measured** static source check; what is not covered is declared.

## File Structure

- `src/renderer/workspace.ts` — gains `minRatioFor`, `resizeKids`, `PaneBox.share`, the `resized` action. All the arithmetic, all testable.
- `src/renderer/PaneDivider.tsx` — **new.** The gesture and nothing else: pointer listeners, px→ratio conversion, cursor. Owns no arithmetic.
- `src/renderer/App.tsx` — renders dividers, holds the min-ratio computation, dispatches `resized`, commits on release.
- `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc/register.ts` — `CHANNELS.setLayout`, and the carve + `shareWhenItDied` changes.
- `src/main/sessions/manager.ts` — resize coalescing.
- `src/main/ipc/restore.ts` — `tabRowFor` learns remembered shares.

---

### Task 1: The arithmetic, as two pure functions

**Files:**
- Modify: `src/renderer/workspace.ts`
- Test: `tests/unit/workspace.test.ts`

**Interfaces:**
- Produces: `minRatioFor(cells: number, totalCells: number): number` and `resizeKids(ratio: readonly number[], index: number, delta: number, minLow: number, minHigh: number): number[]`. `delta` is in **ratio units**, already converted from pixels by the caller. Positive grows kid `index` and shrinks kid `index + 1`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/workspace.test.ts`:

```ts
describe('minRatioFor', () => {
  it('is the fraction of the axis those cells take', () => {
    expect(minRatioFor(20, 200)).toBeCloseTo(0.1)
  })

  it('never exceeds the whole tab', () => {
    // A window narrower than the floor itself. Returning >1 would make every
    // drag impossible AND make `resizeKids`' bounds cross on a tab that is
    // merely small, rather than on one that is genuinely squeezed.
    expect(minRatioFor(20, 10)).toBe(1)
  })

  it('answers 0 rather than Infinity for an unmeasured axis', () => {
    expect(minRatioFor(20, 0)).toBe(0)
  })
})

describe('resizeKids', () => {
  it('moves share from one kid to its neighbour and leaves the rest alone', () => {
    const next = resizeKids([0.25, 0.25, 0.5], 0, 0.1, 0.05, 0.05)
    expect(next).toEqual([0.35, 0.15, 0.5])
  })

  it('preserves the sum exactly, with no renormalising', () => {
    const next = resizeKids([0.7, 0.3], 0, -0.2, 0.05, 0.05)
    expect(next.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
    expect(next).toEqual([0.5, 0.5])
  })

  it('clamps at the low kid’s floor', () => {
    const next = resizeKids([0.2, 0.8], 0, -0.5, 0.1, 0.1)
    expect(next[0]).toBeCloseTo(0.1)
    expect(next[1]).toBeCloseTo(0.9)
  })

  it('clamps at the high kid’s floor', () => {
    const next = resizeKids([0.2, 0.8], 0, 0.95, 0.1, 0.1)
    expect(next[0]).toBeCloseTo(0.9)
    expect(next[1]).toBeCloseTo(0.1)
  })

  it('lets a pane already below its floor be dragged back open', () => {
    // Ruling 4: a window resize can squeeze a pane through the floor. The
    // clamp is on the MOVEMENT, so the only moves refused are ones that make
    // it worse — opening it back up must still work.
    const next = resizeKids([0.02, 0.98], 0, 0.2, 0.1, 0.1)
    expect(next[0]).toBeCloseTo(0.22)
  })

  it('refuses to make a below-floor pane smaller', () => {
    const next = resizeKids([0.02, 0.98], 0, -0.01, 0.1, 0.1)
    expect(next).toEqual([0.02, 0.98])
  })

  it('does nothing when both kids are below their floors', () => {
    // The bounds cross: growing one to its floor requires taking the other
    // further below its own. No move satisfies both, so the honest answer is
    // no move at all rather than whichever bound happened to win.
    const next = resizeKids([0.02, 0.03], 0, 0.5, 0.4, 0.4)
    expect(next).toEqual([0.02, 0.03])
  })

  it('returns the ratios unchanged when the index names no pair', () => {
    expect(resizeKids([0.5, 0.5], 1, 0.1, 0.1, 0.1)).toEqual([0.5, 0.5])
    expect(resizeKids([0.5, 0.5], -1, 0.1, 0.1, 0.1)).toEqual([0.5, 0.5])
  })
})
```

Add `minRatioFor` and `resizeKids` to the import block at the top of the file.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/workspace.test.ts`
Expected: FAIL — `minRatioFor is not a function`.

- [ ] **Step 3: Implement**

In `src/renderer/workspace.ts`, beside `paneInDirection`:

```ts
/**
 * A floor of `cells` expressed as a fraction of an axis `totalCells` long.
 *
 * Cells, not percent, because what makes a terminal unusable is column count —
 * 80-column output wrapping — and not its share of a window. A percentage floor
 * misses that at exactly the sizes where it matters.
 *
 * Capped at 1, and 0 for an unmeasured axis. Neither is decoration: an
 * uncapped value above 1 would make `resizeKids`' bounds cross on a tab that is
 * merely small rather than genuinely squeezed, and `cells / 0` is `Infinity`,
 * which would poison every comparison it reached.
 */
export function minRatioFor(cells: number, totalCells: number): number {
  if (totalCells <= 0) return 0
  return Math.min(1, cells / totalCells)
}

/**
 * A drag of the divider between kid `index` and kid `index + 1`.
 *
 * Share moves between exactly those two; every other kid is untouched. That is
 * what makes the sum invariant BY CONSTRUCTION — what one loses the other
 * gains — so there is no rescale step here and nothing for a rescale to get
 * wrong. Plan 2b's Critical had a share bug behind it, and the branch that
 * renormalised every share alike was the part that resized a pane nobody had
 * touched.
 *
 * **The clamp is on the movement, not on the result.** A pane already below its
 * floor — squeezed there by a narrow window, which ruling 4 allows — is never
 * made worse by a drag, and can still be dragged back open. Validating the
 * outcome instead would freeze such a pane at its size for good.
 *
 * When the two bounds cross, no move can satisfy both floors and the answer is
 * no move. Taking whichever bound happened to survive `Math.min`/`Math.max`
 * would shrink an already-too-small pane further, which is the one thing the
 * floor exists to prevent.
 */
export function resizeKids(
  ratio: readonly number[],
  index: number,
  delta: number,
  minLow: number,
  minHigh: number,
): number[] {
  const low = ratio[index]
  const high = ratio[index + 1]
  // A divider with nothing on one side of it. Total, like every other lookup
  // in this file, because the caller is a pointer handler where "no such pair"
  // has to be a value rather than a throw.
  if (low === undefined || high === undefined) return [...ratio]

  const lower = minLow - low
  const upper = high - minHigh
  if (lower > upper) return [...ratio]

  const room = Math.min(Math.max(delta, lower), upper)
  const next = [...ratio]
  next[index] = low + room
  next[index + 1] = high - room
  return next
}
```

- [ ] **Step 4: Run** — `npx vitest run tests/unit/workspace.test.ts`, then `npm run typecheck`.

- [ ] **Step 5: A/B** — twice. (a) Replace the crossed-bounds guard with `if (false)`; confirm `does nothing when both kids are below their floors` fails. (b) Change `Math.max(delta, lower)` to `delta`; confirm `refuses to make a below-floor pane smaller` fails. Restore by snapshot copy each time; `git diff src/renderer/workspace.ts` must be empty.

- [ ] **Step 6: Commit** — `git commit -m "Move share between two panes, and stop before either is unusable"`

---

### Task 2: A box states its share, not only its CSS

**Files:**
- Modify: `src/renderer/workspace.ts`
- Test: `tests/unit/workspace.test.ts`

**Interfaces:**
- Produces: `PaneBox.share: number` — the normalised fraction of the axis this box takes. `style.flexBasis` is derived from it.

Dividers sit at cumulative ratio boundaries, and the only number a box publishes today is a percent *string*. Parsing that back to place a divider would make the string the source of truth for arithmetic it was formatted for.

- [ ] **Step 1: Write the failing tests**

```ts
describe('PaneBox.share', () => {
  it('is the normalised fraction, matching the flexBasis beside it', () => {
    const state: WorkspaceState = {
      ...three,
      tabs: [ratioRow('aaa', ['aaa', 'bbb'], [0.7, 0.3])],
    }
    const [group] = paneGroups(state)
    expect(group.panes).toHaveLength(2)
    expect(group.panes[0].share).toBeCloseTo(0.7)
    expect(group.panes[1].share).toBeCloseTo(0.3)
    expect(group.panes[0].style.flexBasis).toBe('70%')
  })

  it('is 1 for a pane that is its own group', () => {
    const state: WorkspaceState = { ...three, tabs: [] }
    const groups = paneGroups(state)
    expect(groups).not.toHaveLength(0)
    for (const group of groups) {
      expect(group.panes).toHaveLength(1)
      expect(group.panes[0].share).toBe(1)
    }
  })

  it('renormalises the share when a kid names no pane', () => {
    const state: WorkspaceState = {
      ...three,
      panes: [tab('aaa'), tab('bbb')],
      tabs: [ratioRow('aaa', ['aaa', 'gone', 'bbb'], [0.2, 0.6, 0.2])],
    }
    const [group] = paneGroups(state)
    expect(group.panes).toHaveLength(2)
    expect(group.panes[0].share).toBeCloseTo(0.5)
    expect(group.panes.reduce((sum, box) => sum + box.share, 0)).toBeCloseTo(1)
  })
})
```

- [ ] **Step 2: Run to verify they fail** — expected: `share` is `undefined`.

- [ ] **Step 3: Implement**

In `PaneBox`, above `style`:

```ts
  /**
   * The fraction of its tab's axis this box takes, after renormalising.
   *
   * Published as a number as well as a `flexBasis` string because the dividers
   * sit at cumulative boundaries and have to add these up. Parsing the percent
   * back out of the string would make a value formatted for CSS the source of
   * truth for arithmetic — and `percent()` rounds to four places, so it is
   * lossy in exactly the direction that accumulates.
   */
  share: number
```

In `boxesOfRow`'s final `map`:

```ts
  return kept.map((entry) => {
    const share = total > 0 ? entry.share / total : 1 / kept.length
    return {
      pane: entry.pane,
      share,
      style: { flexBasis: percent(share) },
      dead: state.dead[entry.pane.id] !== undefined,
    }
  })
```

In `paneGroups`' stray branch, add `share: 1` beside `flexBasis: '100%'`.

- [ ] **Step 4: Run** — the file, then `npm run typecheck`.

- [ ] **Step 5: A/B** — make `share` always `1 / kept.length`; confirm the 70/30 test fails. Restore by snapshot copy; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Let a box say what share it takes, not only how to style it"`

---

### Task 3: The reducer takes a resize

**Files:**
- Modify: `src/renderer/workspace.ts`
- Test: `tests/unit/workspace.test.ts`

**Interfaces:**
- Produces: `{ type: 'resized'; tabId: string; ratio: number[] }`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('workspaceReducer resized', () => {
  const state: WorkspaceState = {
    ...three,
    tabs: [ratioRow('aaa', ['aaa', 'bbb'], [0.5, 0.5])],
  }

  it('replaces the tab’s ratios and nothing else', () => {
    const next = workspaceReducer(state, { type: 'resized', tabId: 'aaa', ratio: [0.7, 0.3] })
    const row = next.tabs.find((candidate) => candidate.id === 'aaa')
    expect(row?.layout.ratio).toEqual([0.7, 0.3])
    expect(row?.layout.kids).toEqual(['aaa', 'bbb'])
    expect(next.panes).toBe(state.panes)
  })

  it('ignores a resize naming an unknown tab', () => {
    const next = workspaceReducer(state, { type: 'resized', tabId: 'nope', ratio: [0.7, 0.3] })
    expect(next).toEqual(state)
  })

  it('ignores a ratio of the wrong length', () => {
    // A gesture that raced a split or a close. Applying it would pair shares
    // with the wrong kids and silently mis-size every pane in the tab.
    const next = workspaceReducer(state, { type: 'resized', tabId: 'aaa', ratio: [0.3, 0.3, 0.4] })
    expect(next).toEqual(state)
  })
})
```

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

Add to `WorkspaceAction`:

```ts
  /**
   * A drag in progress. Ratios only — a drag never changes membership, and the
   * reducer is where they live during the gesture so `paneGroups` reflows the
   * panes and `Terminal.tsx`'s ResizeObserver drives tmux with no second push
   * path. Persistence waits for the pointer to come up; see `CHANNELS.setLayout`.
   */
  | { type: 'resized'; tabId: string; ratio: number[] }
```

Add the case:

```ts
    case 'resized': {
      const row = state.tabs.find((candidate) => candidate.id === action.tabId)
      if (!row) return state
      // A gesture that raced a split or a close carries a ratio for a row that
      // no longer has that many kids. Pairing them by position would mis-size
      // every pane in the tab, and the drag's own next frame corrects it — so
      // dropping the stale frame costs nothing and guessing costs the layout.
      if (action.ratio.length !== row.layout.kids.length) return state
      return {
        ...state,
        tabs: state.tabs.map((candidate) =>
          candidate.id === action.tabId
            ? { ...candidate, layout: { ...candidate.layout, ratio: action.ratio } }
            : candidate,
        ),
      }
    }
```

- [ ] **Step 4: Run** — the file, then full `npx vitest run tests/unit`, then `npm run typecheck`.

- [ ] **Step 5: A/B** — delete the length check; confirm `ignores a ratio of the wrong length` fails. Restore by snapshot copy; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Hold a drag's ratios where the panes are drawn from"`

---

### Task 4: A divider you can grab

**Files:**
- Create: `src/renderer/PaneDivider.tsx`
- Modify: `src/renderer/App.tsx`
- Test: `tests/unit/dividers.test.ts` (new, static source check)

**Interfaces:**
- Consumes: `PaneBox.share` (Task 2), `minRatioFor`/`resizeKids` (Task 1), the `resized` action (Task 3).
- Produces: `<PaneDivider dir={'row'|'col'} offset={number} onDrag={(deltaRatio: number) => void} onCommit={() => void} />`. `offset` is the cumulative share to its left/top, 0–1.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/dividers.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

/**
 * The drag gesture, checked against source text because nothing in this suite
 * can press a mouse button. `environment: 'node'` — no DOM, and jsdom performs
 * no layout, so even with one `clientWidth` would report nothing about the
 * thing at stake. The arithmetic is unit-tested properly in `resizeKids`
 * (workspace.test.ts). What is left over is that the gesture is wired to it.
 *
 * **What this does NOT cover, stated so it is not mistaken for coverage:**
 * that a mousedown actually starts a drag, that the cursor changes, that the
 * hit area is grabbable, that listeners are removed on unmount, or that the
 * divider lands where the eye expects. Those need a human or a real browser.
 * Same trade as `appLayout.test.ts`, and the same reason.
 */
function readCode(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
}

const app = readCode('../../src/renderer/App.tsx')
const divider = readCode('../../src/renderer/PaneDivider.tsx')

describe('the divider takes no space in the layout', () => {
  it('is absolutely positioned', () => {
    // A divider in the flow would widen the flex container's content and
    // change the very ratios it exists to adjust. The group container is
    // already `absolute`, so it is the containing block and no new positioning
    // context is needed.
    expect(divider).toMatch(/absolute/)
    expect(divider).not.toMatch(/flex-(1|auto|initial)/)
  })

  it('offers a resize cursor on both axes', () => {
    expect(divider).toMatch(/col-resize/)
    expect(divider).toMatch(/row-resize/)
  })
})

describe('the gesture reaches the arithmetic', () => {
  it('converts pixels to a ratio against the container it is in', () => {
    // px -> ratio is the only conversion the divider owns; getting it from
    // anything other than the container makes every drag the wrong distance.
    expect(divider).toMatch(/offsetWidth|getBoundingClientRect/)
  })

  it('listens on the window, not on itself', () => {
    // A pointer that leaves the 7px strip mid-drag must not end the drag.
    expect(divider).toMatch(/window\.addEventListener\(\s*'(pointermove|mousemove)'/)
    expect(divider).toMatch(/window\.removeEventListener/)
  })

  it('App clamps through resizeKids and dispatches resized', () => {
    expect(app).toMatch(/resizeKids\(/)
    expect(app).toMatch(/minRatioFor\(/)
    expect(app).toMatch(/type: 'resized'/)
  })

  it('App renders one divider between each adjacent pair', () => {
    // `index > 0` and not `index < length - 1`: the divider is drawn before
    // its box, so a trailing divider on the last pane would sit at the tab's
    // edge with nothing on its right.
    expect(app).toMatch(/<PaneDivider/)
    expect(app).toMatch(/index > 0/)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — expected: cannot resolve `PaneDivider.tsx`.

- [ ] **Step 3: Implement**

Create `src/renderer/PaneDivider.tsx`:

```tsx
import { useCallback, useEffect, useRef } from 'react'

/**
 * The grabbable strip between two panes.
 *
 * Absolutely positioned, so it takes no space in the flex container it sits
 * over. That is load-bearing rather than tidy: `App.tsx`'s panes size
 * themselves from `flexBasis` values that sum to the whole container, and a
 * divider in the flow would change the geometry it exists to adjust.
 *
 * Owns exactly one piece of knowledge — how many pixels make a ratio — and
 * nothing else. The clamping and the floors are `resizeKids`' and live where
 * they can be tested.
 */
export function PaneDivider({
  dir,
  offset,
  onDrag,
  onCommit,
}: {
  dir: 'row' | 'col'
  /** Cumulative share to the left of (or above) this divider, 0-1. */
  offset: number
  /** Called with the movement so far, in ratio units, on every pointer move. */
  onDrag: (deltaRatio: number) => void
  /** Called once when the pointer is released. */
  onCommit: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  // Gesture facts, captured at pointerdown. A ref rather than state because
  // none of it affects what is rendered, and putting it in state would
  // re-render the whole tab on every frame for no visible difference.
  const from = useRef<{ start: number; span: number } | null>(null)

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const container = ref.current?.parentElement
      if (!container) return
      const span = dir === 'row' ? container.offsetWidth : container.offsetHeight
      // An unmeasured container would make every delta Infinity.
      if (span <= 0) return
      event.preventDefault()
      from.current = { start: dir === 'row' ? event.clientX : event.clientY, span }
    },
    [dir],
  )

  useEffect(() => {
    const move = (event: PointerEvent): void => {
      const started = from.current
      if (!started) return
      const at = dir === 'row' ? event.clientX : event.clientY
      onDrag((at - started.start) / started.span)
    }
    const up = (): void => {
      if (!from.current) return
      from.current = null
      onCommit()
    }
    // On the window, not on the strip: a pointer that leaves 7 pixels mid-drag
    // must not end the drag, and a release outside the window must still
    // commit rather than leaving the gesture live for ever.
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [dir, onDrag, onCommit])

  return (
    <div
      ref={ref}
      data-testid="pane-divider"
      onPointerDown={onPointerDown}
      className={
        dir === 'row'
          ? 'absolute top-0 bottom-0 z-20 w-[7px] -translate-x-1/2 cursor-col-resize'
          : 'absolute left-0 right-0 z-20 h-[7px] -translate-y-1/2 cursor-row-resize'
      }
      style={dir === 'row' ? { left: `${offset * 100}%` } : { top: `${offset * 100}%` }}
    />
  )
}
```

In `App.tsx`, import `PaneDivider`, `minRatioFor`, `resizeKids`, and `paneGrid` (already imported). Add above the return:

```tsx
  /**
   * Apply a drag of the divider before `index` in `tabId`.
   *
   * The floors are computed here rather than in the divider because this is
   * where the cell size is reachable: `paneGrid` reports a mounted terminal's
   * grid, and the box's own share says what fraction of the axis that grid
   * covers, so the axis total falls out without measuring the DOM.
   *
   * Either adjacent pane can supply it — every terminal is built with the same
   * font — so the low side is taken and the choice is noted here so nobody has
   * to wonder whether it mattered.
   */
  const dragPane = useCallback(
    (tabId: string, index: number, boxes: { pane: TabDescriptor; share: number }[], delta: number) => {
      const row = state.tabs.find((candidate) => candidate.id === tabId)
      const low = boxes[index - 1]
      const high = boxes[index]
      if (!row || !low || !high) return
      const grid = paneGrid(low.pane.id)
      if (!grid || low.share <= 0) return
      const axisCells = (row.layout.dir === 'row' ? grid.cols : grid.rows) / low.share
      const floor = row.layout.dir === 'row' ? MIN_PANE_COLS : MIN_PANE_ROWS
      const min = minRatioFor(floor, axisCells)
      dispatch({
        type: 'resized',
        tabId,
        ratio: resizeKids(row.layout.ratio, index - 1, delta, min, min),
      })
    },
    [state.tabs],
  )
```

Add the constants near the top of `App.tsx`:

```tsx
/**
 * The smallest a pane may be dragged to, in cells.
 *
 * 20 columns because below it almost anything wraps and a `claude` pane stops
 * being readable; 5 rows because a shell needs a prompt and a little scrollback
 * to be worth keeping. Cells rather than a percentage: what makes a terminal
 * unusable is column count, not its share of the window.
 *
 * This governs the DRAG only. A window resize squeezes panes proportionally,
 * through this floor if it comes to that — refusing that would mean fighting
 * the user's own window manager, and `Terminal.tsx`'s zero-size guard is what
 * protects the session there.
 */
const MIN_PANE_COLS = 20
const MIN_PANE_ROWS = 5
```

Inside the `group.panes.map((box) => ...)` callback, take the index and render a divider before every box but the first. Change the map signature to `(box, index)` and return a fragment:

```tsx
              {group.panes.map((box, index) => (
                <Fragment key={box.pane.id}>
                  {index > 0 ? (
                    <PaneDivider
                      dir={group.style.flexDirection === 'column' ? 'col' : 'row'}
                      offset={group.panes
                        .slice(0, index)
                        .reduce((sum, earlier) => sum + earlier.share, 0)}
                      onDrag={(delta) => dragPane(group.id, index, group.panes, delta)}
                      onCommit={() => commitLayout(group.id)}
                    />
                  ) : null}
                  <div
                    data-testid={`pane-${box.pane.id}`}
                    /* … the existing pane box, unchanged, minus its `key` … */
                  >
                    {/* … unchanged … */}
                  </div>
                </Fragment>
              ))}
```

Import `Fragment` from `react`. `commitLayout` is a stub for this task — `const commitLayout = useCallback((_tabId: string) => undefined, [])` — and Task 5 replaces it.

- [ ] **Step 4: Run** — `npx vitest run tests/unit`, then `npm run typecheck`. Then **launch the app** (`npm start`) and drag a divider. Report what you saw: does the pane follow the cursor, does it stop at the floor, does the tmux session reflow. **This is the first time a drag has existed.**

- [ ] **Step 5: A/B** — change `index > 0` to `index >= 0`; confirm a divider is drawn at the tab's leading edge and the static check still passes, then say so in your report. That check cannot see position, which is exactly why the manual step above exists. Restore by snapshot copy; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Give the boundary between two panes something to take hold of"`

---

### Task 5: The ratio reaches disk, once

**Files:**
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc/register.ts`, `src/renderer/App.tsx`
- Test: `tests/integration/persistence.test.ts`

**Interfaces:**
- Produces: `CHANNELS.setLayout`; `setLayout(tabId: string, ratio: number[]): void` on `PrcliApi`.

- [ ] **Step 1: Write the failing test**

In `tests/integration/persistence.test.ts`, inside the `splitPane and closePane` describe (it already has a configured `ipcMain` harness):

```ts
  it('writes a dragged ratio to the tab row and leaves the panes alone', async () => {
    // `splitOnce` returns the FOUNDER, whose own id is the tab's id — there is
    // no `tabId` field on a `TabDescriptor`, and reaching for one is the
    // mistake this comment exists to stop.
    const { founder, second } = await splitOnce()
    const before = await written()
    expect(before.panes).toHaveLength(2)

    ipcMain.emit(CHANNELS.setLayout, {}, founder.id, [0.7, 0.3])
    await settle()

    const after = await written()
    const row = after.tabs.find((candidate) => candidate.id === founder.id)
    expect(row).toBeDefined()
    expect(row?.layout.ratio).toEqual([0.7, 0.3])
    expect(row?.layout.kids).toEqual([founder.id, second.id])
    // A layout write must never touch existence.
    expect(after.panes.map((pane) => pane.id).sort()).toEqual(
      before.panes.map((pane) => pane.id).sort(),
    )
  })

  it('ignores a ratio whose length does not match the row', async () => {
    const { founder } = await splitOnce()
    ipcMain.emit(CHANNELS.setLayout, {}, founder.id, [0.5, 0.3, 0.2])
    await settle()
    const after = await written()
    const row = after.tabs.find((candidate) => candidate.id === founder.id)
    expect(row?.layout.ratio).toHaveLength(2)
    expect(row?.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })
```

**`setLayout` is `ipcMain.on`, not `handle`, so there is nothing to await.** Drive it the way this file already drives `CHANNELS.setActive` and the other `on` handlers, and settle the `serialise` queue before reading the file — follow the file's existing pattern for that rather than inventing one, and say in your report which you used. `written()` is this file's config reader; there is no `readConfig`.

- [ ] **Step 2: Run to verify they fail** — expected: no handler registered for `prcli:setLayout`.

- [ ] **Step 3: Implement**

`src/shared/ipc.ts` — add `setLayout: 'prcli:setLayout',` to `CHANNELS`, and to `PrcliApi`:

```ts
  /**
   * Persist a tab's ratios after a drag. Fire-and-forget: the renderer already
   * has the layout on screen, and a failed write costs a ratio, not a session.
   *
   * Sent ONCE, on pointer release. Ratios live in renderer state during the
   * gesture — throttled writes would push several a second through a queue
   * shared with restore and the exit handler.
   */
  setLayout(tabId: string, ratio: number[]): void
```

`src/preload/index.ts`:

```ts
  setLayout: (tabId, ratio) => ipcRenderer.send(CHANNELS.setLayout, tabId, ratio),
```

`src/main/ipc/register.ts` — beside the other `ipcMain.on` handlers:

```ts
  ipcMain.on(CHANNELS.setLayout, (_event, tabId: string, ratio: number[]) => {
    void serialise(async () => {
      const config = await store.read()
      const saved = config.tabs.find((row) => row.id === tabId)
      // Layout, never existence: this writes `config.tabs` and never
      // `config.panes`. A row for a tab with no saved row yet is not invented
      // here — `store.read()` has already dropped any row whose kids name no
      // pane, so a missing row means a tab this process has no layout for, and
      // guessing one would be inventing membership.
      if (!saved) return
      // A ratio of the wrong length pairs shares with the wrong kids. The
      // gesture that produced it raced a split or a close, and the renderer's
      // own next frame is already correct.
      if (ratio.length !== saved.layout.kids.length) return
      const tabs = withTabRow(config.tabs, tabId, {
        ...saved,
        layout: { ...saved.layout, ratio },
      })
      await store.write({ ...config, tabs })
    })
  })
```

`src/renderer/App.tsx` — replace the Task 4 stub:

```tsx
  /** Persist the tab's ratios, once, when the drag ends. */
  const commitLayout = useCallback(
    (tabId: string) => {
      const row = state.tabs.find((candidate) => candidate.id === tabId)
      if (!row) return
      window.prcli.setLayout(tabId, row.layout.ratio)
    },
    [state.tabs],
  )
```

- [ ] **Step 4: Run** — the file, then `npx vitest run tests/unit`, `npm run typecheck`, `npm run check-deps`.

- [ ] **Step 5: A/B** — make the handler write `config.panes` as well as `config.tabs`; confirm the "leaves the panes alone" assertion fails. Then delete the length check and confirm the second test fails. Restore by snapshot copy each time; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Write a dragged ratio down when the mouse comes up"`

---

### Task 6: One tmux resize in flight per pane

**Files:**
- Modify: `src/main/sessions/manager.ts`
- Test: `tests/integration/manager.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. `resizeWindow`'s internals only.

A two-pane drag emits roughly 120 `resize()` calls a second through `ResizeObserver`, each one an `execFile`. The existing size guard makes a superseded call a no-op — but only after it has spawned tmux.

- [ ] **Step 1: Write the failing test**

```ts
  it('collapses a burst of resizes into one tmux call per settled size', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const resizes = vi.spyOn(adapter, 'resizeWindow')
    const manager = new SessionManager(adapter)
    const tab = manager.open({
      projectSlug: 'lumio', cwd: tmpdir(), cols: 100, rows: 30,
    })
    await expect.poll(() => clients(tab.tmuxSession), { timeout: 8000 }).toHaveLength(1)
    await expect.poll(() => resizes.mock.calls.length, { timeout: 8000 }).toBeGreaterThan(0)
    const afterAttach = resizes.mock.calls.length

    // A drag: twenty frames, faster than tmux can answer any of them.
    for (let width = 101; width <= 120; width += 1) manager.resize(tab.id, width, 30)

    // Settle, then assert plainly. `expect.poll` returns on its first match and
    // so cannot assert that something did NOT keep happening.
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // Far fewer calls than frames, and the LAST size is the one that landed —
    // coalescing that dropped the final frame would be worse than not
    // coalescing at all.
    const spent = resizes.mock.calls.length - afterAttach
    expect(spent).toBeGreaterThan(0)
    expect(spent).toBeLessThan(20)
    const last = resizes.mock.calls[resizes.mock.calls.length - 1]
    expect(last?.[1]).toBe(120)
    manager.detachAll()
  })
```

- [ ] **Step 2: Run to verify it fails** — expected: `spent` is 20, one call per frame.

- [ ] **Step 3: Implement**

Add to `Entry`:

```ts
  /**
   * Whether a `resize-window` for this pane is already in flight, and whether
   * a newer size arrived while it was.
   *
   * A drag emits sizes faster than tmux answers them. Spawning one `execFile`
   * per frame is the subprocess storm this milestone has now met twice; the
   * loop below sends the CURRENT size once the in-flight call settles, so at
   * most one tmux process exists per pane at a time and the last frame is
   * always the one that lands.
   */
  resizing?: boolean
  resizeDirty?: boolean
```

Rewrite the tail of `resizeWindow`. The window-resolution half is unchanged; replace from the identity guard down:

```ts
    if (this.entries.get(entry.record.id) !== entry) return
    // Already sending. Record that a newer size exists and let the in-flight
    // call pick it up when it settles — the loop below always reads the
    // entry's CURRENT size, so the newest frame wins without a timer and
    // without a queue.
    if (entry.resizing) {
      entry.resizeDirty = true
      return
    }
    entry.resizing = true
    try {
      do {
        entry.resizeDirty = false
        // Re-checked every pass, not once: `moveTabToProject` disposes an
        // entry and makes a new one, and this loop can outlive that.
        if (this.entries.get(entry.record.id) !== entry) return
        await this.adapter.resizeWindow(windowId, entry.cols, entry.rows)
      } while (entry.resizeDirty)
    } finally {
      entry.resizing = false
    }
```

**Note what this replaces and why.** The old `if (entry.cols !== cols || entry.rows !== rows) return` dropped a superseded call so a slow early resize could not land last. The loop makes that impossible by construction — it sends `entry.cols`/`entry.rows`, which are by definition the newest — so the guard is not merely redundant, it would now be wrong: it would drop the very call that carries the final size. The identity guard stays and is checked every pass.

- [ ] **Step 4: Run** — `npx vitest run tests/integration/manager.test.ts` (this file is pty-hungry; run it alone, and count resource errors beside the failures — `posix_spawnp`, `Device not configured`, `fork failed`, including inside assertion text — before believing any failure). Then `npx vitest run tests/unit` and `npm run typecheck`.

- [ ] **Step 5: A/B** — remove the `entry.resizing` early return so every call spawns; confirm the burst test fails on `spent` being 20. Then, separately, change the loop body to send the captured `cols`/`rows` instead of `entry.cols`/`entry.rows`; confirm the "last size is 120" assertion fails. Restore by snapshot copy each time; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Send one resize at a time, and always the newest"`

---

### Task 7: A split carves, and refuses a sliver

**Files:**
- Modify: `src/main/ipc/register.ts`, `src/renderer/App.tsx`
- Test: `tests/integration/persistence.test.ts`, `tests/unit/shortcuts.test.ts`

**Interfaces:**
- Consumes: `MIN_PANE_COLS`/`MIN_PANE_ROWS` from Task 4.

- [ ] **Step 1: Write the failing tests**

In `persistence.test.ts`:

```ts
  it('carves the new pane out of the pane being split, leaving others alone', async () => {
    const { founder, second } = await splitOnce()
    ipcMain.emit(CHANNELS.setLayout, {}, founder.id, [0.7, 0.3])
    await settle()

    // Split the 30, which should become two 15s and leave the 70 untouched.
    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: second.id, dir: 'row', cols: 40, rows: 20,
    })
    const row = shape.tabs[0]
    expect(row.layout.kids).toHaveLength(3)
    const at = (id: string): number => row.layout.ratio[row.layout.kids.indexOf(id)]
    expect(at(founder.id)).toBeCloseTo(0.7)
    expect(at(second.id)).toBeCloseTo(0.15)
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })
```

In `shortcuts.test.ts`:

```ts
  it('refuses a split that would breach the floor', () => {
    // The check lives beside the only cell-accurate numbers in the system.
    // Main has no idea what a column is, so it cannot make this call.
    expect(app).toMatch(/MIN_PANE_COLS/)
    expect(app).toMatch(/half\(grid\.cols\) < MIN_PANE_COLS|half\(grid\.rows\) < MIN_PANE_ROWS/)
  })
```

- [ ] **Step 2: Run to verify they fail** — expected: every ratio is `1/3`.

- [ ] **Step 3: Implement**

In `register.ts`'s `splitPane`, replace the `ratio:` line and its comment:

```ts
          // Carved out of the pane being split: it keeps half its share and
          // the new pane takes the other half. Every other pane's width is
          // untouched, so the sum is preserved by construction with no rescale.
          //
          // This overturns plan 2b's even split, whose stated reason was that
          // "ratios are the one thing the user can drag straight back" — drag
          // did not exist then, and recoverable is not the same as not
          // destroyed. 2b's objection to carving was that repeated splits hand
          // each new pane a sliver of a sliver; that is answered by the floor,
          // which makes `splitActive` refuse such a split before it is sent.
          //
          // A kid the saved row does not know has no share to halve — a
          // restarted pane, whose row entry went when it died. `shareOf` falls
          // back to an even share for it; Task 8 gives it the share it had.
          ratio: (() => {
            const sourceAt = siblings.indexOf(paneId)
            const savedRatio = saved?.layout.ratio ?? []
            const shareOf = (id: string): number => {
              const at = savedKids.indexOf(id)
              return at === -1 ? 1 / siblings.length : (savedRatio[at] ?? 1 / siblings.length)
            }
            const source = sourceAt === -1 ? 1 / kids.length : shareOf(paneId)
            const shares = kids.map((kid) =>
              kid === record.id || kid === paneId ? source / 2 : shareOf(kid),
            )
            const total = shares.reduce((sum, share) => sum + share, 0)
            return total > 0 ? shares.map((share) => share / total) : kids.map(() => 1 / kids.length)
          })(),
```

In `App.tsx`'s `splitActive`, after the `if (!grid) return`:

```tsx
      // Refused here rather than in main, because this is where the only
      // cell-accurate numbers are: main has no idea what a column is. A split
      // that cannot give the new pane its floor would produce a pane too small
      // to use, which is 2b's "sliver of a sliver" answered before it happens
      // rather than tolerated after.
      const wouldBe = dir === 'row' ? half(grid.cols) : half(grid.rows)
      const floor = dir === 'row' ? MIN_PANE_COLS : MIN_PANE_ROWS
      if (wouldBe < floor) {
        setError(`Not enough room to split: a pane needs at least ${floor} ${dir === 'row' ? 'columns' : 'rows'}`)
        return
      }
```

Move the `half` definition above this block.

- [ ] **Step 4: Run** — `npx vitest run tests/unit`, then `npx vitest run tests/integration/persistence.test.ts` alone with a resource-error count, then `npm run typecheck` and `npm run check-deps`.

- [ ] **Step 5: A/B** — restore `ratio: kids.map(() => 1 / kids.length)`; confirm the carve test fails on `at(founder.id)` being `1/3` rather than `0.7`. Restore by snapshot copy; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Take the new pane's room from the pane being split"`

---

### Task 8: A restarted pane comes back the size it was

**Files:**
- Modify: `src/main/ipc/register.ts`, `src/main/ipc/restore.ts`
- Test: `tests/integration/persistence.test.ts`

**Interfaces:**
- Consumes: Task 7's `shareOf` fallback.
- Produces: `tabRowFor(tab, ids, saved, remembered?: Map<string, number>)` — a fourth, optional parameter.

- [ ] **Step 1: Write the failing test**

```ts
  /** The pid of the process running in a session's pane. */
  async function panePid(name: string): Promise<string> {
    const { stdout } = await run('tmux', [
      '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{pane_pid}',
    ])
    return stdout.trim()
  }

  it('gives a restarted pane the share it had, not an even one', async () => {
    const { founder, second } = await splitOnce()
    ipcMain.emit(CHANNELS.setLayout, {}, founder.id, [0.7, 0.3])
    await settle()

    // A real death, not a close: `kill -9` on the pane's own process, so the
    // pane-died hook fires and main's exit path forgets the row. Killing it
    // through `CHANNELS.closePane` would be a deliberate kill, which is
    // exempted from the tombstone and would prove nothing about a restart.
    await run('kill', ['-9', await panePid(second.tmuxSession)])
    await expect
      .poll(async () => (await written()).panes.length, { timeout: 8000 })
      .toBe(1)

    await invoke<TabDescriptor>(CHANNELS.restartTab, { tab: second })

    // A split is the cheapest thing that makes main rewrite the tab's row,
    // which is where the share was being lost — the renderer's own copy was
    // right all along.
    const third = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 40, rows: 20,
    })
    const row = third.tabs[0]
    const at = (id: string): number => row.layout.ratio[row.layout.kids.indexOf(id)]
    expect(row.layout.kids).toContain(second.id)
    // Roughly, not exactly: the founder's 0.7 has just been halved, so every
    // share is rescaled. What must not happen is `second` coming back at an
    // even third.
    expect(at(second.id)).toBeGreaterThan(0.25)
    expect(at(second.id)).toBeLessThan(0.34)
  })
```

`panePid` is copied from `pane-death.test.ts`, which is the only file that has it; `run` and `SOCKET` already exist in `persistence.test.ts`. If the exact assertion window above proves wrong once the arithmetic is real, **report the numbers you measured rather than widening it** — a widened window is how an assertion stops biting.

- [ ] **Step 2: Run to verify it fails** — expected: the restarted pane comes back at an even share, roughly 0.5.

- [ ] **Step 3: Implement**

In `register.ts`, beside `lastGeometry`:

```ts
  /**
   * The share each pane held when it died, by pane id.
   *
   * The third map of a shape that is already here twice —
   * `SessionManager.tabWasIn` and `lastGeometry` above are both
   * process-lifetime, keyed by pane id, written at death, read at restart, and
   * dropped by the same two handlers. This inherits that contract rather than
   * inventing one, which is also why it is not persisted: restore prunes dead
   * panes at launch, so a saved share would never have a pane to apply to.
   *
   * The renderer keeps a tombstone's share on screen by itself (see
   * `withKeptPanes`), so this is not what the user is looking at. It is what
   * main needs the moment it rebuilds the tab's row — at which point the
   * restarted pane is a kid the saved row never knew, and the even fallback
   * would flatten a ratio that survived both the death and the restart.
   */
  const shareWhenItDied = new Map<string, number>()
```

Extend `forgetTab` to capture it in the same pass — it already reads the config:

```ts
  const forgetTab = (id: string): Promise<void> =>
    serialise(async () => {
      const config = await store.read()
      // Captured before the row goes, and inside this same pass, so there is
      // no window in which the share is gone but unrecorded.
      const row = config.tabs.find((candidate) => candidate.layout.kids.includes(id))
      const at = row?.layout.kids.indexOf(id) ?? -1
      const share = at === -1 ? undefined : row?.layout.ratio[at]
      if (share !== undefined) shareWhenItDied.set(id, share)
      const panes = config.panes.filter((saved) => saved.id !== id)
      if (panes.length === config.panes.length) return
      await store.write({ ...config, panes })
    })
```

Drop it where `lastGeometry` is dropped — in the `dismissTab` handler and in `closePane`:

```ts
    shareWhenItDied.delete(id)      // dismissTab, beside lastGeometry.delete(id)
    shareWhenItDied.delete(paneId)  // closePane, beside lastGeometry.delete(paneId)
```

In `restore.ts`, `tabRowFor` gains the parameter and uses it in place of `even`:

```ts
export function tabRowFor(
  tab: { id: string; groupId: string },
  ids: string[],
  saved: TabRow | undefined,
  /**
   * Shares to use for kids the saved row does not know — a pane that died and
   * came back, whose row entry went with it. Absent for restore, which prunes
   * dead panes and so never meets one.
   */
  remembered?: Map<string, number>,
): TabRow {
```

and:

```ts
  const shares = kids.map((kid) => {
    const at = savedKids.indexOf(kid)
    if (at !== -1 && saved) return saved.layout.ratio[at]
    return remembered?.get(kid) ?? even
  })
```

In `closePane`, pass it: `tabRowFor({ id: tabId, groupId }, kids, saved, shareWhenItDied)`.

In `splitPane`'s `shareOf`, use it before the even fallback:

```ts
              return at === -1
                ? (shareWhenItDied.get(id) ?? 1 / siblings.length)
                : (savedRatio[at] ?? 1 / siblings.length)
```

- [ ] **Step 4: Run** — `npx vitest run tests/integration/persistence.test.ts` alone with a resource-error count, then `npx vitest run tests/unit`, `npm run typecheck`, `npm run check-deps`.

- [ ] **Step 5: A/B** — make `forgetTab` record nothing; confirm the restart test fails with roughly an even share. Restore by snapshot copy; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Remember how big a pane was when it died"`

---

## Deliberately not in this plan

- **The `⊞n` badge and the tab-bar selection model.** Its own plan — collapsing a split tab into one entry changes what an entry *is*, and with it what clicking one means, where its dot comes from (`stateOfTab`, which exists and is called by nothing), and what close/restart/dismiss act on.
- **E2E revival.** Its own plan; touches no product code.
- **Arbitrary pane nesting**, **detach-a-pane-to-its-own-tab**, **two-dimensional drag.** Out of M2c.
- **`restore.ts`'s silent `catch { continue }`** (carry item N2). A two-line `console.warn`, and this plan does not otherwise touch that function — take it only if Task 8's edit lands next to it.

## Self-review

**Spec coverage.** Divider as overlay → Task 4. Live reflow via existing `ResizeObserver` → Task 4 (no new code, asserted in its manual step). Cell-based floor, clamp on movement → Task 1, applied in Task 4. Sum preserved by construction → Tasks 1 and 7. Coalescing → Task 6. Split carves → Task 7. Renderer-side refusal → Task 7. Close left alone → no task, by design; stated here so its absence is deliberate. `shareWhenItDied` → Task 8. `CHANNELS.setLayout`, write-once on mouse-up, `config.tabs` only → Task 5. Declared-untested statement → Task 4's test file header.

**Ordering.** 1 before 3 (the reducer clamps through it) and before 4. 2 before 4 (dividers need cumulative shares). 5 after 4 (it replaces the stub). 6 is independent of the renderer and could run any time after 4 makes the storm real. 7 before 8 (8 fills 7's fallback).

**Type consistency.** `resizeKids(ratio, index, delta, minLow, minHigh)` is called in Task 4 with `index - 1`, because `PaneDivider` at `index` sits *before* box `index` while `resizeKids` names the *low* kid. That off-by-one is the one place these two conventions meet and it is called out here on purpose. `PaneBox.share` (Task 2) is consumed by Task 4's `offset` reduction and by `dragPane`. `tabRowFor`'s fourth parameter (Task 8) is optional, so `restoreWorkspace`'s existing three-argument call still compiles.

**Pre-flight, run against the code before this plan was finished.** Four defects
in my own test snippets, all of which would have failed to compile or asserted
nothing:

- `readConfig()` does not exist; this file's config reader is `written()`.
- `splitOnce()` returns `{ founder, second, shape }`, not `{ first, second }`.
- **`TabDescriptor` has no `tabId` field.** A tab's id is its founder pane's own
  id. Three snippets reached for `first.tabId`, which is exactly the confusion
  the v5 naming was meant to end.
- `CHANNELS.setLayout` is an `ipcMain.on`, so `invoke` cannot drive it and there
  is nothing to await; and no `killPaneProcess` helper exists — a real death
  needs `panePid` from `pane-death.test.ts` plus `kill -9`.

**Known soft spots, stated rather than hidden.**
- Task 4's static check cannot see position, size or whether a listener is ever removed. Its A/B step deliberately produces a wrong-looking divider that the check still passes, so the implementer sees the limit rather than trusting it.
- Task 6 changes what a superseded resize does. No test pinned the old size guard, which is why it can be replaced — but that also means nothing was watching it, so the burst test is the only thing standing between the loop and a regression.
- Task 8's test needs a real pane death, which is the pty-hungriest thing in the suite. Run that file alone and count resource errors inside assertion text as well as in error lines — a starvation failure there reads exactly like the defect.
