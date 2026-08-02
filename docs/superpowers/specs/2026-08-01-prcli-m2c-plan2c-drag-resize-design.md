# M2c plan 2c — Drag-resize, and a ratio that survives

**Goal:** make a tab's ratios something the user sets and the app keeps. Plan 2b
made splits visible; every ratio in the app is still an even split written by
`splitPane`. At the end of this plan a divider can be dragged, the pane reflows
under the cursor, the ratio is on disk when the mouse comes up, and neither a
split nor a pane's death-and-restart quietly flattens it.

**Base:** `master` at `a29ada1` (M2c plan 2b merged, 712 tests green).

## Scope, and the two things taken out of it

2c was written in the M2c spec as four things: drag-resize, the `⊞n` badge, E2E,
and the restarted-pane position repair. **Split, 2026-08-01.** This plan is
drag-resize plus the repair, which are coupled — the repair exists to restore an
uneven ratio, and uneven ratios cannot exist until drag creates them.

Two are deferred to plans of their own:

- **The `⊞n` badge is not cosmetic, and the spec calling it cosmetic is what hid
  that.** The tab bar lists *panes*, one entry each. Collapsing a split tab into
  one entry changes what an entry *is*, and that cascades: `activeTabId` names a
  pane today, so clicking an entry needs a new meaning; each entry's dot must come
  from `stateOfTab`, which exists ahead of exactly this need and is called by
  nothing; and close, restart and dismiss are all wired per pane. That is a change
  to the selection model, and it does not belong in the same review as a gesture.
- **E2E revival** touches no product code and gates differently. Its own plan.

## Rulings taken for this plan (2026-08-01)

1. **A drag clamps at a floor measured in cells, not percent.** 20 columns × 5
   rows. What makes a terminal unusable is column count — 80-column output
   wrapping — not its share of a window, so a percentage floor misses the failure
   at exactly the sizes that matter.
2. **A split carves the new pane out of the pane being split.** Every other pane
   keeps its width. This overturns 2b's even-split ruling, whose stated
   justification was that "ratios are the one thing the user can drag straight
   back" — drag did not exist then, and recoverable is not the same as not
   destroyed.
3. **A dead pane's share is remembered by main, in a process-lifetime map.** Not
   by the renderer, which would put a second authority on a number main just
   sent; not in config, which would break "config supplies layout, never
   existence".
4. **The floor governs the drag only. A window resize squeezes proportionally,
   through the floor if it comes to that.** A drag is a deliberate act that can be
   refused; a window resize is not, and refusing it would mean fighting the user's
   own window manager.
5. **Testing follows the plan-2b ruling unchanged.** No DOM exists and none can be
   added (`environment: 'node'`, no jsdom, `npm install` forbidden). Logic goes in
   pure functions; the gesture wiring gets a *measured* static source check; and
   what is not covered is declared, not implied.

## Geometry

**The divider is an overlay, and that is load-bearing.** Panes sit in a flex
container with `gap-px`, and the existing comment in `App.tsx` explains what
absorbs that pixel: the bases sum to the whole container, flex shrinking is
weighted by base size, so the one-pixel overflow comes off the panes in the same
proportion as their ratios and leaves them intact. A 6-pixel grabbable divider
*in the flow* would break that arithmetic — **a divider that took space would
change the geometry it exists to adjust.**

So the divider is absolutely positioned over the gap. The group container is
already `absolute`, which makes it a containing block for absolutely-positioned
descendants, so this needs no new positioning context. It spans the cross axis,
carries a ~7px hit area and a `col-resize`/`row-resize` cursor, and has zero
layout footprint.

**Live tmux resize is already built.** `Terminal.tsx` observes its own container
with a `ResizeObserver` and calls `fitToContainer` → `fit.fit()` →
`window.prcli.resize(...)`. Changing a pane's `flexBasis` fires that by itself.
The renderer therefore pushes **no** tmux calls during a drag; the M2c ruling that
the pane reflows under the cursor is satisfied by machinery that exists. Both of
`fitToContainer`'s guards stay, and stay above the fit — the `offsetParent` check
for a container with no layout, and the `clientWidth === 0` check for a laid-out
box of no size. FitAddon floors its proposal at 2 cols × 1 row rather than
declining, so without the second guard a box of no size drives a real session to
2×1.

The drag itself cannot reach that: it clamps at the floor. The guard matters here
for the other direction — ruling 4 lets a **window** resize squeeze panes below
the floor, and a window small enough can take a box to zero. That is the case the
second guard has always been for, and this plan makes it reachable more often.

## The arithmetic

**A drag moves share between exactly two kids.** Divider *i* takes from kid *i*
and gives to kid *i+1*, or the reverse. Every other pane is untouched.

That gives an invariant for free: **the sum is preserved by construction, not by
renormalising.** What one kid loses the other gains. There is no rescale step,
and therefore nothing for a rescale to get wrong — which is worth stating
because plan 2b's Critical had a share bug behind it, and the branch of it that
renormalised every share alike was the part that resized a pane nobody had
touched.

**The clamp applies to the movement, not to the result.** Each of the two panes
has a floor as a fraction, `MIN_CELLS / totalCellsAlongAxis`, converted once at
`mousedown` from a cell size the renderer already has. Clamping the delta rather
than validating the outcome is what makes ruling 4 fall out for free: a pane
already below its floor — squeezed there by a narrow window — is never made
*worse* by a drag, and can still be dragged back open.

Two pure functions in `src/renderer/workspace.ts`, beside `paneInDirection` and
`boxesOfRow`, where this file's arithmetic already lives:

- `minRatioFor(cells, totalCells): number`
- `resizeKids(ratio, index, delta, minA, minB): number[]` — `delta` is in **ratio
  units**, already converted from pixels by the caller, so this function never
  needs to know what a pixel is. Positive grows kid *i* and shrinks kid *i+1*.

Both total, both numbers in and numbers out: no DOM, no React, no measurement.

**Cell size is captured once, at drag start.** `paneGrid(paneId)` gives a mounted
terminal's `cols`/`rows`; the box's pixel size divided by that is the cell size.
Capturing it at `mousedown` rather than reading the DOM per frame keeps the whole
gesture pure arithmetic on numbers already in hand.

Either adjacent pane can be measured for this — every terminal in the app is
constructed with the same `fontFamily` and `fontSize`, so cell size is a property
of the font and not of the pane. Take it from the pane on the low side of the
divider, and say so, so nobody has to wonder whether the choice mattered.

## Flow

1. `mousedown` on divider *i* captures gesture facts into a ref — tab id, index,
   container size along the axis, cell size. None of it affects rendering, so
   none of it belongs in reducer state.
2. Window-level `mousemove` converts pixel delta to ratio delta and dispatches
   `resized`.
3. The reducer writes the two adjacent kids' ratios into `state.tabs`.
   `paneGroups` already reads exactly that, so the panes move; `ResizeObserver`
   does the rest.
4. `mouseup` tears the listeners down and sends the tab's ratios once.

## Coalescing, which is where the 2a carry-in lands

`ResizeObserver` is frame-batched, so a two-pane drag emits roughly 120
`resize()` calls a second, each currently one `execFile`. `SessionManager.
resizeWindow` already re-checks the entry's current size before its call lands,
so a superseded resize is a no-op — but it has already spawned tmux by then.

**One in flight per entry.** If a resize is already running for a pane, mark it
dirty and re-run once after it settles rather than spawning another. That
collapses a drag to about one tmux call per pane per round trip, needs no timer,
and keeps the existing staleness guards exactly as they are. This is the 2a carry
item "`resize()` now issues one `execFile` per renderer resize — coalesce if plan
2's drag-resize proves chatty", arriving as predicted.

## Split and close

**Split carves.** `splitPane` stops writing `ratio: kids.map(() => 1 /
kids.length)`. The pane being split holds share *s*; it keeps *s/2* and the new
pane takes *s/2*, inserted after it exactly as now. Every other kid is untouched,
so the sum is again preserved by construction. 70/30 split on the 30 gives
70/15/15.

**The refusal lives where the measurement is.** `splitActive` already computes
`half(grid.cols)` and already refuses an unmeasured pane. It gains one more
refusal: a half below the floor does not get sent. Main has no idea what a column
is, so this cannot live there — and main keeps its own independent refusal of an
unmeasured or zero size, which guards a different failure.

This answers 2b's objection to carving. The worry was that repeated splits "hand
each new pane a sliver of a sliver": true with no floor, impossible with one,
because the split that would produce the sliver is refused before it happens with
a reason the user can act on.

**Close is already right and is deliberately not touched.** `tabRowFor` gives each
survivor its saved share and rescales the set to sum to 1. Rescaling
proportionally *is* preserving relative sizes — closing the 15 out of 70/15/15
gives roughly 82/18, which keeps the shape the user built. Written down because
the instinct to "redistribute evenly" would be wrong here and would look like a
fix.

## A dead pane's share

The renderer already keeps a dead pane's slot and its share for as long as the
tombstone lives — that is `withKeptPanes`, added in 2b — and a restart lands back
in the right place. The gap is on main's side: it drops the pane's row at death,
so when it next rebuilds that tab's row, the restarted pane is a kid the saved row
never knew and `tabRowFor` hands it `even`. The ratio survives the death and the
restart, then flattens on the next ⌘D.

**`shareWhenItDied: Map<string, number>` in `register.ts`.** A third map of a
shape that is already there twice — `SessionManager.tabWasIn` and `lastGeometry`
are both process-lifetime, keyed by pane id, written at death, read at restart,
and dropped by the same two handlers. This inherits that contract rather than
inventing one.

- **Written** inside the pass that already forgets the row. `forgetTab` is a
  `serialise` wrapper; it grows to read the tab row's ratio at that pane's index
  before dropping the pane row. One pass, so there is no window in which the share
  is gone but unrecorded.
- **Read** in `splitPane`/`closePane` when resolving a kid the saved row does not
  know. The `even` fallback stays for a pane genuinely never seen.
- **Dropped** by `dismissTab` and `closePane`, exactly where `lastGeometry` is.
- **Not persisted.** Restore prunes dead panes at launch, so there would never be
  a pane to apply it to.

## Persistence

One new channel — `CHANNELS.setLayout(tabId, ratio: number[])` — sent once on
`mouseup`. It writes `config.tabs` only — never
`panes` — through `serialise`, and appends a row when the tab has none yet
(`withTabRow` already does replace-or-append). It cannot go through `rememberTab`
for the same reason `splitPane` cannot: that is itself a `serialise` wrapper and
would deadlock inside a pass.

Nothing during the gesture touches disk. That is the point of the mouse-up ruling:
throttled writes would push several a second through a queue shared with restore
and the exit handler.

## Test plan

Tested properly:

- `minRatioFor` and `resizeKids`, including both clamps, a pane already below its
  floor, and the sum-preservation invariant.
- The `resized` and persist reducer actions.
- The carve arithmetic in `splitPane`, and that no other kid's share moves.
- `shareWhenItDied`'s full lifetime: written at death, restored on restart, dropped
  by dismiss and by close.
- The new channel through the mocked `ipcMain` the persistence tests already use.
- That a drag and a persist leave tombstones in their row, at their share.

**Declared untested, plainly:** the mouse gesture itself — hit area, cursor,
listener attach and teardown. No DOM exists and none can be added. It gets a
measured static source check in the idiom of `appLayout.test.ts` and
`shortcuts.test.ts`, and the plan states what that check does not cover. The
alternative is a test that looks like coverage and is not; this project has found
twelve of those.

**A/B every load-bearing assertion** by breaking the production code it guards,
and `git diff` on production files must be empty before committing. Restore an
A/B by snapshot copy, never by `git checkout --`, whenever the file has
uncommitted work — that wiped an entire uncommitted fix mid-run on 2b.

## Done when

- A divider between two panes can be dragged; the pane reflows under the cursor
  and the real tmux session follows.
- Neither pane can be dragged below 20 columns or 5 rows; the divider stops.
- The ratio is on disk after mouse-up, and comes back on relaunch.
- Splitting a tab with uneven ratios leaves every untouched pane's width alone.
- A split that would breach the floor is refused with a reason.
- A pane that dies and is restarted comes back at the share it had, and keeps it
  through the next split.
- A drag does not evict a tombstone from its row (2b's Critical stays closed).
- No attach or split drives a window to 80×24, and no **drag** drives a pane to
  2×1. A window resize small enough can still take a pane below the floor — that
  is ruling 4, deliberate — and what protects the session there is
  `fitToContainer`'s zero-size guard, not the floor.
- Unit, integration, typecheck and `check-deps` all green; default tmux socket
  untouched and verified after every task.

## What must not regress

Each of these has cost this project a defect at least once:

- Every terminal stays mounted; a hidden tab uses `visibility`, never `display`.
- Both `fitToContainer` guards stay, above the fit.
- `withKeptPanes` keeps tombstones in their row at their share.
- Row ids are never rewritten — `TabRow.id` is the founder's, permanent, and the
  renderer's React key.
- `serialise` has no reentrancy protection; nothing reached from inside it may
  call back into it.
- Tests use `-L prcli-test` only; a bare `kill-server` is forbidden.
- A comment asserting a mechanism that is not true is a defect here.

## Out of scope

- The `⊞n` badge and the tab-bar selection model. Its own plan.
- E2E revival. Its own plan.
- Arbitrary pane nesting. Still deferred; the tmux model has no opinion about
  arrangement, so it stays a config-and-renderer change whenever it is wanted.
- Detach-a-pane-to-its-own-tab, and dragging a pane between tabs. Out of M2c.
- Two-dimensional drag. One axis per tab is the standing ruling.
