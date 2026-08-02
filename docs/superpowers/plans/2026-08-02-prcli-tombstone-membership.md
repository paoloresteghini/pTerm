# Tombstone membership — main owns the tombstone, and every layout message names its panes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close CT-1 and CT-2 — a drag that is silently never persisted, dividers that go
inert after a dismiss, and a pane nobody touched changing width whenever its tab holds a
tombstone — by settling the one question both fall out of: **who says which panes a tab
holds, and in what frame a share is measured.**

**Architecture:** Main gains an explicit tombstone record (the `{tabId, share}` map it
already keeps, renamed, with a reader) and both of its row builders convert their whole-tab
vector into the **live-remainder frame** the config file has always been in, by dividing the
live kids' shares by the total those shares hold. The layout wire stops being positional and
starts naming panes, so a drag on a tab holding a tombstone lands and keeps main's record
current. The renderer stops leaving a dismissed pane's id in `layout.kids` — and never does
that for a death, which is the direction the design rejects.

**Tech Stack:** TypeScript, Electron main, React renderer, node-pty, real tmux 3.7b via
`TmuxAdapter`, Vitest (`npm test`), Playwright (`npm run e2e`, not run on this plan).

**Spec:** `docs/superpowers/specs/2026-08-02-prcli-tombstone-membership-design.md`
**Base:** `master` at `d5dc35d`. Unit 514/514 green, verified before this plan was written.

## Global Constraints

- Tests use `-L prcli-test` only, via `new TmuxAdapter({ socket: 'prcli-test' })`. **Never the default socket.** `tmux -L prcli-test kill-server` is the established teardown; a bare `kill-server` is forbidden.
- Tests never touch the real `~/.prcli` (`PRCLI_CONFIG_DIR`), `~/Code` (`PRCLI_PROJECTS_ROOT`) or `~/.claude/settings.json` (`PRCLI_CLAUDE_SETTINGS`).
- **Never run `npm install` / `npm ci`.** It breaks node-pty's spawn-helper permissions and fails every integration test with `posix_spawnp failed`.
- **The machine is starved.** `kern.tty.ptmx_max` is 511 with ~422 held. `persistence.test.ts` has failed three times with the failure count exactly equal to the resource-error count. **Every integration step below says: run that file ALONE, and count `posix_spawnp failed` / `Device not configured` / `fork failed` — inside assertion text as well as in error lines — before believing any failure is a defect. Re-run a failing describe alone before reporting it.**
- **Never weaken, delete or loosen a test assertion, timeout or poll interval to make something pass.** If an assertion contradicts the code, stop and report.
- **Never assert over a collection without first asserting it is non-empty.** `[].every(...)` is `true`.
- A/B every load-bearing assertion by breaking the production code it guards. **Restore an A/B by snapshot copy (`cp file file.bak` … `cp file.bak file`), never by `git checkout -- <file>`** — that restores to HEAD and once wiped an entire uncommitted fix. **Before committing, `git diff` on production files must be empty of the mutation.**
- `register.ts`'s `serialise` queue has **no reentrancy protection.** Nothing running inside it may call it again. `rememberTab` and `forgetTab` are themselves `serialise` wrappers. Writing a tombstone record is an in-memory map write, not a config write, so nothing here adds a new path back into the queue.
- **Every terminal stays mounted; a hidden tab uses `visibility`, never `display`.** Both of `Terminal.tsx`'s `fitToContainer` guards stay above the fit.
- **`withKeptPanes` keeps tombstones in their row at their share.** This plan is built around that rule, not against it. Task 1 removes a kid only when its pane leaves `state.panes`, and **never on `died`**.
- **Row ids are never rewritten.** `TabRow.id` is the founder pane's id and the renderer's React key. Nothing here renames a row or re-keys a group.
- **The sum comes out by construction, not by a rescale bolted on to cover a gap.** The conversion this plan adds is a projection onto a smaller basis — dividing a known-correct whole-tab vector by the total it holds for the live kids — and it sums to 1 exactly. It is written as one expression with the reason named so nobody later "simplifies" it into a rescale that happens to agree.
- **A comment asserting a mechanism that is not true is a defect here.** Five comments become false under this plan; each is rewritten in the task that falsifies it, and they are listed in the self-review.
- **No attach, split or drag may drive a window to 80×24 or a pane to 2×1.** The conversion divides by a number in `(0, 1]`, so main's emitted shares only ever get *larger*; the renderer scales them back. No new path to a zero-width box.
- No DOM in this suite (`environment: 'node'`, no jsdom, and none can be added). Integration drives real tmux but has no renderer. Logic goes in pure functions; what is not covered is declared.

## File Structure

- `src/main/ipc/shares.ts` — **new.** The main side's layout arithmetic, with no `store`, no `manager` and no `electron`: `sharesAroundClaims` (moved here from `restore.ts`), the tombstone reader, the frame conversion, and `setLayout`'s routing. Imports types only, so it cannot cycle with either of its two callers.
- `src/main/ipc/register.ts` — `shareWhenItDied` becomes `tombstones`; `claimForDeath` and `carveRatio` read the same predicate; `CHANNELS.setLayout` routes a named record; `dismissTab` keeps the record honest.
- `src/main/ipc/restore.ts` — `tabRowFor` emits in the live-remainder frame; `sharesAroundClaims` moves out.
- `src/shared/ipc.ts`, `src/preload/index.ts` — `setLayout(tabId, shares: Record<string, number>)`.
- `src/renderer/workspace.ts` — `dismissed`/`removed` drop the pane's kid; gains `grabFor`.
- `src/renderer/App.tsx` — `commitLayout` sends a record; `grabPane` becomes a call to `grabFor`.
- `tests/unit/tombstoneFrame.test.ts` — **new.** The composition nothing in this repo has ever run: main's row builder through the renderer's merge.

---

### Task 1: A dismissed pane leaves its tab's row, and a dead one does not

**Files:**
- Modify: `src/renderer/workspace.ts`
- Test: `tests/unit/workspace.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. The `dismissed` and `removed` cases only.

This is the cheapest half of CT-1 and is worth landing even if everything after it is
reconsidered. `dismissed` drops the pane from `state.panes` and leaves its id in
`layout.kids` for ever; `boxesOfRow` boxes only kids whose pane exists, so boxes become one
shorter than kids and `grabPane`'s 1:1 guard refuses **every** grab in that tab until the
next split or close. Measured on master: kids stay `['aaa','ccc','bbb']`, panes become
`['aaa','ccc']`, boxes 2 ≠ kids 3, and the divider still draws with `col-resize` over it.

**The row is renormalised in the same step, and that is not decoration.** `boxesOfRow`
already renormalises for the screen, so leaving the row summing to less than 1 would make
`state.tabs` and what the user sees disagree — and `commitLayout` sends the row, whose
entries are whole-tab fractions by contract (Task 5). One renormalisation, in the reducer,
keeps every path that writes `state.tabs` producing a vector that sums to 1.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/workspace.test.ts`, inside the existing
`describe('a tombstone when its tab is split or closed', …)` block (it already has the
fixtures these need):

```ts
  it('takes a dismissed pane out of its tab’s kids, so boxes and kids stay 1:1', () => {
    // CT-1's inert-dividers half. `boxesOfRow` boxes only kids whose pane
    // exists, so a kid left behind by a dismiss makes boxes one shorter than
    // kids — and `App.tsx`'s `grabPane` refuses every grab in a tab where those
    // two disagree, leaving live dividers that do nothing.
    const state: WorkspaceState = {
      ...deadFounder,
      panes: [tab('aaa'), tab('bbb'), tab('ccc')],
      tabs: [ratioRow('aaa', ['aaa', 'bbb', 'ccc'], [0.5, 0.25, 0.25])],
      status: { aaa: 'crashed', bbb: 'idle', ccc: 'idle' },
      dead: { aaa: 0 },
    }
    const next = workspaceReducer(state, { type: 'dismissed', id: 'aaa' })
    const row = next.tabs.find((candidate) => candidate.id === 'aaa')
    expect(row?.layout.kids).toEqual(['bbb', 'ccc'])
    const groups = paneGroups(next)
    expect(groups).toHaveLength(1)
    expect(groups[0].panes).toHaveLength(row?.layout.kids.length ?? -1)
    // The row keeps its id, which is the dismissed founder's. That is the whole
    // safety argument for doing this on a dismiss and never on a death: no
    // stray pane is left carrying the row's id, so `paneGroups` has nothing to
    // collide with.
    expect(groups[0].id).toBe('aaa')
  })

  it('renormalises the row it leaves behind, so the tab still describes a whole tab', () => {
    const state: WorkspaceState = {
      ...deadFounder,
      panes: [tab('aaa'), tab('bbb'), tab('ccc')],
      tabs: [ratioRow('aaa', ['aaa', 'bbb', 'ccc'], [0.5, 0.25, 0.25])],
      dead: { aaa: 0 },
    }
    const row = workspaceReducer(state, { type: 'dismissed', id: 'aaa' }).tabs[0]
    expect(row.layout.ratio).toHaveLength(2)
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
    // The survivors keep their proportion to each other — they were equal, and
    // they stay equal. What they must NOT do is keep 0.25 each and leave the
    // row summing to 0.5, which is what dropping the share without
    // renormalising would give.
    expect(row.layout.ratio[0]).toBeCloseTo(0.5)
    expect(row.layout.ratio[1]).toBeCloseTo(0.5)
  })

  it('leaves a dead pane in its tab’s kids, at its share', () => {
    // The direction the design REJECTS, pinned so nobody "simplifies" the two
    // cases into one. A pane removed from `kids` while still in `state.panes`
    // is a stray, and a dead FOUNDER's stray carries its own row's id — which
    // `paneGroups` skips the second time it meets, unmounting every live
    // terminal in the tab. That is plan 2b's Critical, and `died` is the one
    // action that can produce it.
    const next = workspaceReducer(
      { ...deadFounder, dead: {} },
      { type: 'died', id: 'aaa', code: 0 },
    )
    const row = next.tabs.find((candidate) => candidate.id === 'aaa')
    expect(row?.layout.kids).toEqual(['aaa', 'bbb'])
    expect(row?.layout.ratio).toEqual([0.5, 0.5])
  })

  it('takes a removed pane out of its tab’s kids the same way', () => {
    // `removed` is dispatched by nothing today (see its own doc comment) and is
    // pinned anyway: the two cases share this rule, and a future caller that
    // reaches for it must not reintroduce the leak.
    const next = workspaceReducer(deadFounder, { type: 'removed', id: 'aaa' })
    expect(next.tabs.find((candidate) => candidate.id === 'aaa')?.layout.kids).toEqual(['bbb'])
  })
```

The existing test `lets a merged-back tombstone be dismissed, and renormalises what is left`
keeps every assertion it has — under this change the row itself becomes `['bbb','ccc']` at
`[0.5, 0.5]` and `boxesOfRow`'s renormalisation becomes the identity, so both boxes still
report `50%`. **Its comment becomes false and must be rewritten**: it currently says "the row
still names the dismissed pane — nothing rewrites kids on a dismiss". Replace that sentence
with what now happens, and say that `boxesOfRow`'s renormalisation is now an identity here
rather than the thing doing the work.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/workspace.test.ts`
Expected: the first two fail — `kids` still holds `'aaa'`, and the ratio still has three
entries. The `died` and `removed` tests pass and fail respectively (`died` is already
correct; `removed` is not).

- [ ] **Step 3: Implement**

In `src/renderer/workspace.ts`, beside `removeTab`:

```ts
/**
 * Every row with `id` taken out of its kids, and what is left renormalised.
 *
 * Called from exactly the two actions that take a pane out of `state.panes` —
 * `dismissed` and `removed` — and **never from `died`.** That distinction is
 * the whole safety argument. A pane dropped from `kids` while it is still in
 * `state.panes` is a stray, `paneGroups` keys a stray by its own id, and a
 * dead FOUNDER's id is its row's id: the two collide in `seen`, and whichever
 * is walked second is skipped, unmounting every live terminal in the tab. A
 * dismissed pane leaves `state.panes` in this same reducer step, so there is
 * no stray to collide with — even for a founder, whose row keeps its id.
 *
 * Renormalised rather than left with a hole: `boxesOfRow` already divides the
 * survivors' shares by their own total for the screen, so a row summing to
 * less than 1 would make `state.tabs` disagree with what is drawn — and
 * `commitLayout` sends this row to main as whole-tab fractions. This is the
 * same projection `sharesAroundClaims` and `boxesOfRow` do, not a rescale
 * covering a gap: the pane is gone, and the survivors divide the tab.
 *
 * A row that keeps no kid at all is left alone rather than emptied. That state
 * is unreachable from `dismissed` — the pane being dismissed is dead, and a
 * tab whose every pane is dead has already lost its row through `closedPane` —
 * and an empty row is a container with nothing in it, which `paneGroups`
 * drops. Leaving it whole is the answer that changes nothing.
 */
function withoutKid(state: WorkspaceState, id: string): WorkspaceState {
  const row = state.tabs.find((candidate) => candidate.layout.kids.includes(id))
  if (!row) return state
  const kept = row.layout.kids
    .map((kid, index) => ({ kid, share: row.layout.ratio[index] ?? 0 }))
    .filter((entry) => entry.kid !== id)
  if (kept.length === 0) return state
  const total = kept.reduce((sum, entry) => sum + entry.share, 0)
  const next: TabRow = {
    ...row,
    layout: {
      ...row.layout,
      kids: kept.map((entry) => entry.kid),
      ratio: kept.map((entry) => (total > 0 ? entry.share / total : 1 / kept.length)),
    },
  }
  return { ...state, tabs: state.tabs.map((candidate) => (candidate.id === row.id ? next : candidate)) }
}
```

Then wrap both cases:

```ts
    case 'removed': {
      const { [action.id]: _dropped, ...status } = state.status
      const { [action.id]: _tombstone, ...dead } = state.dead
      return { ...withoutKid(removeTab(state, action.id), action.id), status, dead }
    }
```

```ts
    case 'dismissed': {
      const { [action.id]: _dropped, ...dead } = state.dead
      // Same selection move a close makes, so dismissing the tab you are
      // looking at does not leave the pane showing nothing — and the tab's row
      // stops naming a pane that is no longer there, which is what kept every
      // divider in that tab from being grabbable (see `withoutKid`).
      return { ...withoutKid(removeTab(state, action.id), action.id), dead }
    }
```

- [ ] **Step 4: Run** — `npx vitest run tests/unit`, then `npm run typecheck`.

- [ ] **Step 5: A/B** — twice. (a) Make `withoutKid` return `state` unchanged; confirm
`takes a dismissed pane out of its tab’s kids, so boxes and kids stay 1:1` fails on
`kids` still holding `'aaa'`, and that `leaves a dead pane in its tab’s kids` still passes.
(b) Call `withoutKid` from the `died` case as well; confirm
`leaves a dead pane in its tab’s kids, at its share` fails — this is the mutation that
reopens 2b's Critical, and it must be caught by name. Restore by snapshot copy each time;
`git diff src/renderer/workspace.ts` must be empty.

- [ ] **Step 6: Commit** — `git commit -m "Let a dismissed pane leave its tab, and a dead one stay"`

---

### Task 2: Main names its tombstones, with the predicate it already had

**Files:**
- Create: `src/main/ipc/shares.ts`
- Modify: `src/main/ipc/register.ts`, `src/main/ipc/restore.ts`
- Test: `tests/unit/shares.test.ts`, `tests/unit/claimForDeath.test.ts`

**Interfaces:**
- Produces: `src/main/ipc/shares.ts`, exporting `sharesAroundClaims` (moved verbatim from `restore.ts`), `type Claim = { tabId: string; share: number }`, `claimFor(tabId, paneId, claims): number | undefined`, and `tombstonesOf(tabId, kids, claims): { id: string; share: number }[]`.
- `register.ts`'s `shareWhenItDied` becomes `tombstones`; `claimForDeath`'s parameter of the same name becomes `tombstones`; `carveRatio`'s `remembered` becomes `tombstones: ReadonlyMap<string, Claim>` and it gains a `tabId: string`; `tabRowFor`'s fourth parameter likewise.

`shareWhenItDied` already carries `{tabId, share}`, is written at exactly one place, and is
dropped by exactly the two handlers that end a pane's restartability. What it lacks is a
name that says what it is and a reader that answers **which panes of tab T are tombstones
right now** — the claims recorded for T whose pane is not among the kids being written.
That is `claimForDeath`'s existing `taken` predicate, unchanged, evaluated at rebuild
instead of at death.

- [ ] **Step 1: Write the failing tests**

Create the new describes in `tests/unit/shares.test.ts` (which becomes this new module's
test file — change its import to `'../../src/main/ipc/shares'` for `sharesAroundClaims` and
keep `tabRowFor` coming from `'../../src/main/ipc/restore'`):

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/shares.test.ts`
Expected: FAIL — cannot resolve `src/main/ipc/shares`.

- [ ] **Step 3: Implement**

Create `src/main/ipc/shares.ts`. Move `sharesAroundClaims` into it **verbatim, doc comment
and all** — its traced-case paragraph is rewritten in Task 3, where the behaviour it
describes actually changes, not here. Add above it:

```ts
/**
 * What one tab owes one pane its row does not name, as a fraction of the WHOLE
 * tab.
 *
 * Recorded at a pane's death by `register.ts`'s `forgetTab`, through
 * `claimForDeath`, and dropped by the two handlers that end a pane's
 * restartability — `dismissTab` and `closePane`. The tab id is not
 * bookkeeping: it is what makes the share a whole-tab fraction rather than a
 * fraction of a row, and it is what `tombstonesOf` and `claimFor` both filter
 * on.
 *
 * `SessionManager.tabWasIn` is the other half of this same concept — a
 * process-lifetime map, keyed by pane id, written at death, read at restart,
 * dropped by the same two handlers, recording WHICH TAB the dead pane was in
 * while this records WHAT IT HELD. Two maps in two files recording facts about
 * the same dead pane is one concept whether or not it is one map; it is not
 * moved here because the manager is where a pane's membership is decided, but
 * a change to the lifetime of either belongs in both.
 */
export interface Claim {
  readonly tabId: string
  readonly share: number
}

/**
 * The share `tabId` owes `paneId`, or undefined when it owes it nothing.
 *
 * Filtered on the tab, not merely looked up by pane id. Pane ids are unique
 * today, so the filter decides nothing — but a claim is defined as a fraction
 * of one named tab, and reading one against a different tab would be reading a
 * number in a frame it was never measured in. Stated as a filter so the
 * definition is enforced rather than relied upon.
 */
export function claimFor(
  tabId: string,
  paneId: string,
  claims: ReadonlyMap<string, Claim>,
): number | undefined {
  const held = claims.get(paneId)
  return held && held.tabId === tabId ? held.share : undefined
}

/**
 * Which panes of `tabId` are tombstones right now: every claim recorded for
 * that tab whose pane `kids` does not name.
 *
 * **This is `claimForDeath`'s `taken` predicate, unchanged, evaluated at a
 * different moment**, and that is the whole of what this design adds to main.
 * At a death, `kids` is the row as it stands and the answer is what the dying
 * pane's share has to be discounted by. At a rebuild, `kids` is the row about
 * to be written and the answer is what that row does not account for — the
 * panes the renderer is still drawing and main has forgotten. The two were
 * previously described in `claimForDeath`'s doc as "NOT the same set, and that
 * is a known, open gap"; they are now one set, read twice.
 *
 * A claim whose pane IS in `kids` is spent: the row accounts for that pane
 * again, so nothing is owed outside it. That is a restarted pane the moment a
 * split or a close writes it back in.
 */
export function tombstonesOf(
  tabId: string,
  kids: readonly string[],
  claims: ReadonlyMap<string, Claim>,
): { id: string; share: number }[] {
  return [...claims].flatMap(([id, held]) =>
    held.tabId === tabId && !kids.includes(id) ? [{ id, share: held.share }] : [],
  )
}
```

In `register.ts`:

- import `sharesAroundClaims`, `claimFor`, `tombstonesOf` and `type Claim` from `./shares`, and drop `sharesAroundClaims` from the `./restore` import list.
- rename the map: `const tombstones = new Map<string, Claim>()`. Its doc comment stays, with two edits — the sentence naming it "the share each pane held when it died" gains "…and is still owed, until a rebuild spends it", and the `SessionManager.tabWasIn` sentence now points at `shares.ts`'s `Claim`, which is where that pairing is written down.
- rename `claimForDeath`'s parameter `shareWhenItDied` to `tombstones` (four call sites in `claimForDeath.test.ts` follow), and compute `taken` through the shared reader:

```ts
  const { share, tabId, kids, tombstones } = params
  // The same reader the row builders use, so "what this death must be
  // discounted by" and "what a rebuilt row does not account for" cannot drift
  // into two predicates again. See `tombstonesOf`.
  const taken = tombstonesOf(tabId, kids, tombstones).reduce((sum, entry) => sum + entry.share, 0)
```

- **Rewrite `claimForDeath`'s "`taken` here and `sharesAroundClaims`'s `held` are NOT the same set" section.** It is now false. Replace it with the one-line version: they are the same set — every unspent claim for this tab — read at death against the row as it stands and at rebuild against the row about to be written; the row builders offer `sharesAroundClaims` a claim for every one of them, whether the pane is a live sibling (through `shareOf`) or a tombstone (through `tombstonesOf`). Keep the `!kids.includes` paragraph and the `room <= 0` paragraph exactly as they are; both are still true.
- **Restate `forgetTab`'s inline induction proof while you are in it.** It currently argues the claims of one tab stay below 1 by a strict inequality that does not hold at the step where `share` is exactly 1 — the sole survivor of its row dying. The conclusion holds; the one-line proof does not establish it. Say instead that the bound is not proved here and that what keeps a later read safe is `sharesAroundClaims`'s own `room > 0` fallback, which is already what the paragraph below it says.
- rename every remaining `shareWhenItDied` reference (`dismissTab`, `closePane`, `splitPane`'s `remembered:` argument, `carveRatio`'s and `tabRowFor`'s parameter docs).

In `restore.ts`: import `sharesAroundClaims` from `./shares`, and update the two comments
that name `shareWhenItDied` (in `tabRowFor`'s parameter doc and in the paragraph above its
`shares`) to name `register.ts`'s `tombstones` and `shares.ts`'s `Claim`.

- [ ] **Step 4: Run** — `npx vitest run tests/unit`, then `npm run typecheck` and `npm run check-deps`.

- [ ] **Step 5: A/B** — delete the `held.tabId === tabId` condition inside `tombstonesOf`.
Confirm **two** tests fail: `tombstonesOf > reads only its own tab’s claims`, and
`claimForDeath > counts only claims recorded against the same tab, not another tab's`. Two
failures from one mutation is the evidence that the two really are one predicate; if only
one fails, `claimForDeath` is not going through the reader and the task is not done.
Restore by snapshot copy; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Give main a name for the panes it owes a share to"`

---

### Task 3: Both row builders emit in the live-remainder frame

**Files:**
- Modify: `src/main/ipc/shares.ts`, `src/main/ipc/register.ts`, `src/main/ipc/restore.ts`
- Test: `tests/unit/shares.test.ts`, `tests/unit/carveRatio.test.ts`

**Interfaces:**
- Produces: `inLiveFrame(whole: readonly number[], liveCount: number): number[]` in `shares.ts`.
- `carveRatio(params)` gains `tabId: string`; its `remembered?: ReadonlyMap<string, { share: number }>` becomes `tombstones?: ReadonlyMap<string, Claim>`.
- `tabRowFor(tab, ids, saved, tombstones?)` — same widening on the fourth parameter; `restoreWorkspace`'s three-argument call still compiles.

`normaliseLayout` rescales every saved row over the panes that exist, so main's
`config.tabs` row is, by the file format's own invariant, always in the **live-remainder
frame**. A claim is a fraction of the whole tab. Today `sharesAroundClaims` writes whole-tab
claims into a live-remainder vector and calls it done: when the tab holds a tombstone the
two frames differ by exactly the tombstone's share, the renderer scales main's
already-whole vector down a second time, and the difference lands on panes nobody touched.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/shares.test.ts`:

```ts
describe('inLiveFrame', () => {
  it('re-expresses the live kids’ shares as shares of what they hold', () => {
    // Half of a whole-tab vector belongs to panes this row will not name, so
    // the two that are named hold 0.5 between them and take 0.5 each of it.
    expect(inLiveFrame([0.25, 0.25, 0.5], 2)).toEqual([0.5, 0.5])
  })

  it('is the identity when the live kids hold the whole tab', () => {
    // The control that stops this being satisfied by an implementation that
    // ignores its inputs: with no tombstone the conversion changes nothing,
    // which is what makes this change a strict superset of today's behaviour.
    expect(inLiveFrame([0.25, 0.25, 0.3, 0.2], 4)).toEqual([0.25, 0.25, 0.3, 0.2])
  })

  it('splits evenly when the live kids hold nothing at all', () => {
    expect(inLiveFrame([0, 0, 1], 2)).toEqual([0.5, 0.5])
  })
})
```

Extend `describe('tabRowFor with a remembered pane', …)`:

```ts
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
```

In `tests/unit/carveRatio.test.ts` — every existing case gains `tabId: 'tab'`, and the two
`remembered:` maps become `tombstones: new Map([['b', { tabId: 'tab', share: 0.3 }]])`.
**No existing expected number moves**; if one does, stop and report, because that means the
conversion is firing where there is no tombstone. Add:

```ts
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/unit/shares.test.ts tests/unit/carveRatio.test.ts`
Expected: `inLiveFrame is not a function`, and (once it exists) the two carve cases coming
back at `0.35 / 0.35 / 0.30` and `0.4 / 0.4 / 0.2` — today's numbers.

- [ ] **Step 3: Implement**

In `shares.ts`, below `sharesAroundClaims`:

```ts
/**
 * The first `liveCount` shares of a whole-tab vector, re-expressed as shares
 * of what those kids hold between them.
 *
 * **A projection onto a smaller basis, not a renormalisation.** The vector
 * handed in sums to 1 by construction — `sharesAroundClaims` guarantees it —
 * so the total divided by here is exactly `1 - (what the tombstones hold)`.
 * Both readings are true and only one of them is the reason: the reason is
 * that the row being written describes the panes it names and nothing else,
 * and the tombstone total is the CHECK. Written as one division so nobody
 * later replaces it with `share / sum(share)` on the live kids alone, which
 * agrees numerically and stops being a projection the moment the vector it is
 * given does not sum to 1.
 *
 * `config.tabs` has always been in this frame: `normaliseLayout` rescales
 * every saved row over the panes that exist, and a dead pane's kid is dropped
 * on the way in. Emitting a whole-tab vector into it — which is what both row
 * builders did before this — is what made the renderer reserve a tombstone's
 * share a second time.
 *
 * The guard is not provably unreachable and is not written as though it were,
 * for the same reason `sharesAroundClaims`'s `room > 0` note gives: the live
 * kids hold nothing only when the tombstones hold the whole tab, which
 * `sharesAroundClaims`'s own fallback makes very hard to reach and neither
 * function proves impossible. An even split is the only division that needs no
 * data, and a zero share would be a 0%-wide box, which fits to tmux's 2x1
 * floor — the geometry defect wearing different numbers.
 *
 * The ordering this leans on is one line away at both call sites: the
 * tombstone entries are APPENDED after the kids' entries, so the kids are the
 * prefix this slices.
 */
export function inLiveFrame(whole: readonly number[], liveCount: number): number[] {
  const live = whole.slice(0, liveCount)
  const held = live.reduce((sum, share) => sum + share, 0)
  return held > 0 ? live.map((share) => share / held) : live.map(() => 1 / live.length)
}
```

In `register.ts`'s `carveRatio`: take `tabId` and `tombstones` out of `params`, replace
`remembered?.get(id)?.share` in `shareOf` with `claimFor(tabId, id, tombstones ?? new Map())`
— or hoist an empty map once above `shareOf` — and replace the return:

```ts
  // The whole tab: the kids this row will name, plus every pane of this tab
  // that a claim is still owed to and that this row does NOT name. The second
  // group is what `sharesAroundClaims` was never given before, which is why
  // the vector it produced described a tab larger than the row it went into.
  const dead = tombstonesOf(tabId, kids, tombstones ?? new Map())
  const whole = sharesAroundClaims([
    ...kids.map((kid) => (kid === newPaneId || kid === sourcePaneId ? halved : shareOf(kid))),
    ...dead.map((entry) => ({ claim: entry.share, base: entry.share })),
  ])
  // Appended above, sliced here: see `inLiveFrame`.
  return inLiveFrame(whole, kids.length)
```

In `restore.ts`'s `tabRowFor`, the same shape around its existing `sharesAroundClaims` call,
using `tab.id` as the tab and `remembered` renamed to `tombstones`.

**Comments that become false here and must be rewritten in this task:**

- `sharesAroundClaims`'s "Traced, not hypothetical" paragraph, which describes C ending up drawn at 0.24. That is now a description of a fixed defect, not of behaviour: say what it was, that this plan's `inLiveFrame` is what closed it, and keep the trace, because the numbers are the evidence.
- The paragraph above it beginning "This function only ever sees a claim for a pane that is a LIVE sibling" — it now sees a claim for every unspent claim of the tab, live sibling or not.
- `carveRatio`'s "dilutes every known share evenly" paragraphs **stay**: they describe an *unremembered* sibling, which is untouched by this task. Do not delete them along with the rest.

- [ ] **Step 4: Run** — the two files, then `npx vitest run tests/unit`, `npm run typecheck`,
`npm run check-deps`. Then `npx vitest run tests/integration/persistence.test.ts` **alone**,
with a resource-error count — the two existing restart tests
(`gives a restarted pane the share it had, not an even one` and its close-path twin) pin
main's emitted numbers in cases with **no tombstone**, so they must come out unchanged.
If either moves, the conversion is firing where the live kids hold the whole tab and the
task is wrong.

- [ ] **Step 5: A/B** — twice. (a) Return `whole.slice(0, kids.length)` from `carveRatio`
without the division; confirm `carveRatio > holds back a tombstone’s share and emits what
the live kids hold` fails at `0.35` against `0.3125`, and that every no-tombstone case in
that file still passes. (b) Give `tombstonesOf` the kids of the SAVED row instead of the
kids being written (`savedKids` for `carveRatio`); confirm the restarted pane's claim is
double-counted and the second carve case fails. Restore by snapshot copy each time;
`git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Write a tab's row in the frame the file is already in"`

---

### Task 4: The composition nothing has ever run

**Files:**
- Create: `tests/unit/tombstoneFrame.test.ts`
- Modify: nothing.

**Interfaces:**
- Consumes: `carveRatio`, `tabRowFor`, `workspaceReducer`, `paneGroups`. No production change.

**No unit file in this repo imports both `workspaceReducer` and any of
`carveRatio`/`tabRowFor`.** `carveRatio.test.ts` and `shares.test.ts` call the main side with
hand-written inputs; `workspace.test.ts` drives the reducer with hand-written `TabShape`
fixtures; the two never meet. That is the structural blind spot CT-2 lived in for a
milestone, and closing it needs no DOM, no ptys and no new export — driving
`workspaceReducer` with `{ type: 'split', shape }` reaches `withKeptPanes`, which is how
`workspace.test.ts` already exercises the tombstone rules.

Every number below was derived against the real functions at `d5dc35d` before this plan was
written, both before and after the fix.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/tombstoneFrame.test.ts`. It builds a tab `A .5 / C .3 / B .2`, kills
panes through `claimForDeath` exactly as `forgetTab` does, prunes the saved row exactly as
`normaliseLayout` does, asks `carveRatio` for the row a split would write, and folds that
row into the reducer. Give it a header saying what it covers and what it does not — in
particular that it does **not** show that main's tombstone set and the renderer's
`state.dead` agree at runtime, which is a cross-process fact this suite cannot see.

The four cases and their expected numbers, all four ending in the same place:

| case | claims recorded | main emits | on screen after the merge |
|---|---|---|---|
| B dies, C dies, C restarted | B 0.2, C 0.3 | A .3125 / new .3125 / C .375 | A .25 / new .25 / C .30 / B .20 |
| C dies, B dies, C restarted | C 0.3, B 0.2 | A .3125 / new .3125 / C .375 | A .25 / new .25 / C .30 / B .20 |
| B dies, C dies, B restarted | B 0.2, C 0.3 | A 5/14 / new 5/14 / B 2/7 | A .25 / new .25 / C .30 / B .20 |
| C dies, B dies, B restarted | C 0.3, B 0.2 | A 5/14 / new 5/14 / B 2/7 | A .25 / new .25 / C .30 / B .20 |

**Before this plan, those same four gave** A .28 / new .28 / C .24 / B .20 for the first two
and A .28 / new .28 / C .30 / B .14 for the second two — the restarted pane returning at
0.14 of a tab it died holding 0.20 of.

The claims are identical in both death orders and this is worth asserting rather than
assuming: `claimForDeath`'s discount makes B 0.2 and C 0.3 whichever died first, and the
saved row after both deaths is `[A] = [1]` either way. That is why the two orders produce
byte-identical output, and it is the measurement that killed the death-ordinal candidate.

Plus three controls, all of which must be **identical before and after this plan**:

- **nothing ever died** — split A on `[A .5, C .3, B .2]` gives A .25 / new .25 / C .30 / B .20, both on the wire and on screen.
- **B died and came back, nothing else** — one claim, no tombstone. Saved row `[A .625, C .375]`, claim B 0.2; main emits A .25 / new .25 / C .30 / B .20 and the screen agrees. This is the case that stops the implementation being "reserve everything in the map": a recorded claim whose pane the row DOES name is spent, and reserving it would shrink the whole tab by 0.2 for nothing.
- **a claim recorded against another tab** — present in the map, absent from every number.

And two compositions beyond a single split:

- **split twice.** After the first split of case 1, split A again. Main emits A .15625 / n2 .15625 / n1 .3125 / C .375 and the screen shows A .125 / n2 .125 / n1 .25 / C .30 / B .20. **The tombstone is still at exactly 0.20 and C still at exactly 0.30** — the frame is stable across round trips rather than merely correct once, which is the property a frame error would compound through.
- **close, on the same tab.** After the first split of case 1, close the new pane through `tabRowFor`. Main emits A 5/11 / C 6/11 and the screen shows A 4/11 ≈ .3636 / C .4364 / B .20: the tombstone keeps its 0.20 exactly, and A:C keep the 0.25:0.30 proportion they had. That is `closePane`'s standing "close is already right" ruling, now also true through a tombstone.

Assert the exact per-pane shares off `paneGroups(next)[0].panes`, not just the sum — `sum ≈ 1`
holds under every wrong answer in the table above and is necessary, not sufficient. Assert
`paneGroups(next)` has exactly one group and that every pane is boxed exactly once, so a
regression that drops a terminal fails here too.

- [ ] **Step 2: Run to verify it passes, then verify it can fail**

This task adds no production code, so Step 2 is the A/B in Step 3 rather than a red run.
Run `npx vitest run tests/unit/tombstoneFrame.test.ts` and confirm green.

- [ ] **Step 3: A/B — the whole point of this task**

Revert Task 3's conversion in `carveRatio` (return `whole.slice(0, kids.length)`), by
snapshot copy. Confirm:

- the four ordering cases fail, with the measured pre-fix numbers above — 0.24 for a pane nobody touched in two of them, 0.14 for the restarted pane in the other two;
- **all three controls still pass**, and say so in your report. A control that fails under this mutation is a control that was never a control.

Then revert Task 3's conversion in `tabRowFor` only, and confirm the close case fails while
the split cases pass. Restore by snapshot copy each time; `git diff src/main` empty.

- [ ] **Step 4: Run** — `npx vitest run tests/unit`, `npm run typecheck`.

- [ ] **Step 5: Commit** — `git commit -m "Run main's row through the renderer's merge, which nothing had"`

---

### Task 5: A layout message names its panes

**Files:**
- Modify: `src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/ipc/register.ts`, `src/main/ipc/shares.ts`, `src/renderer/App.tsx`
- Test: `tests/unit/shares.test.ts`, `tests/unit/dividers.test.ts`, `tests/integration/persistence.test.ts`

**Interfaces:**
- Produces: `setLayout(tabId: string, shares: Record<string, number>): void` on `PrcliApi`, and `routeShares(shares, savedKids, owes)` in `shares.ts`.

`setLayout`'s positional ratio is dropped whenever its length disagrees with the saved row,
and that is not a rare race: after any death in a tab the renderer's `layout.kids` is a
**permanent strict superset** of main's, so every drag on such a tab fails the guard, every
time, for as long as the tab holds that pane. Naming the panes makes misalignment
unrepresentable rather than guarded, and it is the one moment main can learn a tombstone's
current share.

**The invariant this retires.** "Renderer kids are always a superset of main's, so equal
length implies equal membership" is a four-file argument asserted by nothing, and it is the
only thing standing between today's wire and a positionally-*misaligned* ratio on disk.
After this task nothing depends on it: every share arrives with the pane it belongs to, and
a pane main cannot place is named in a log rather than silently paired with somebody else's.
**Nothing further needs to pin it** — an invariant that no longer has a consumer is not one
worth asserting, and asserting it would be pinning a fact about four files that this change
made irrelevant.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/shares.test.ts`:

```ts
describe('routeShares', () => {
  const owes = (id: string): boolean => id === 'b' || id === 'c'

  it('projects the saved kids’ shares into the frame the row is written in', () => {
    // The renderer's vector is whole-tab: `a` and `n` hold 0.6 between them and
    // `b` — which the row does not name — holds 0.4. The row gets 0.5/0.5, the
    // same division a split does, so a drag and a split cannot disagree about
    // the frame.
    const routed = routeShares({ a: 0.3, n: 0.3, b: 0.4 }, ['a', 'n'], owes)
    expect(routed.ok).toBe(true)
    if (!routed.ok) return
    expect(routed.ratio).toEqual([0.5, 0.5])
    expect(routed.owed).toEqual([{ id: 'b', share: 0.4 }])
  })

  it('keeps the saved kids’ order, not the record’s', () => {
    const routed = routeShares({ n: 0.25, a: 0.75 }, ['a', 'n'], owes)
    expect(routed.ok).toBe(true)
    if (!routed.ok) return
    expect(routed.ratio).toEqual([0.75, 0.25])
  })

  it('refuses a record naming a pane the tab cannot place', () => {
    // Not a silent drop wearing a new shape: the caller logs this, and it is
    // the only branch that logs. It needs a renderer kid that is neither on
    // disk nor owed a share, which no path this plan can name produces.
    const routed = routeShares({ a: 0.5, zzz: 0.5 }, ['a'], owes)
    expect(routed.ok).toBe(false)
    if (routed.ok) return
    expect(routed.why).toContain('zzz')
  })

  it('refuses a record that does not name every saved kid', () => {
    // Pairing what is there would leave `ratio` shorter than `kids`, and
    // `normaliseLayout` reads a short ratio as unusable and flattens the whole
    // row to an even split — a drag that silently resets the tab.
    const routed = routeShares({ a: 1 }, ['a', 'n'], owes)
    expect(routed.ok).toBe(false)
    if (routed.ok) return
    expect(routed.why).toContain('n')
  })

  it('refuses a record whose saved kids hold nothing', () => {
    const routed = routeShares({ a: 0, n: 0, b: 1 }, ['a', 'n'], owes)
    expect(routed.ok).toBe(false)
  })
})
```

In `tests/integration/persistence.test.ts`, **convert every existing `setLayout` call site
to a record** — there are seven, at the `ipc.listeners.get(CHANNELS.setLayout)?.(…)` lines
and inside `splitThenRestartSibling(ratio?)`, whose parameter becomes
`shares?: Record<string, number>`. Replace `ignores a ratio whose length does not match the
row` (the guard it tested is gone) with these:

```ts
  it('writes a drag on a tab holding a tombstone, which used to be dropped in silence', async () => {
    // CT-1's persistence half, end to end. `bbb` has died, so main's saved row
    // no longer names it while the renderer still draws it — the state in which
    // EVERY drag on this tab was silently discarded by the old length guard.
    const { founder, second } = await splitOnce()
    const third = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 100, rows: 30,
    })
    const middle = third.panes[1]
    await waitForPrompt(middle.id)

    const adapter = new TmuxAdapter({ socket: SOCKET })
    const window = await adapter.windowIdOf(second.tmuxSession)
    expect(window).toMatch(/^@\d+$/)
    const exited = waitForExitEvent(second.id)
    await run('tmux', [
      '-L', SOCKET,
      'kill-session', '-t', `=${second.tmuxSession}`, ';', 'kill-window', '-t', window,
    ])
    await exited
    await expect.poll(() => written().then((c) => c.panes.length), { timeout: 8000 }).toBe(2)

    const before = await written()
    // The precondition, asserted rather than assumed: the row on disk names two
    // panes and the message names three.
    expect(before.tabs[0].layout.kids).toEqual([founder.id, middle.id])

    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.3, [middle.id]: 0.3, [second.id]: 0.4 } as never,
    )
    await settle(200)

    const after = await written()
    const row = after.tabs.find((candidate) => candidate.id === founder.id)
    expect(row?.layout.kids).toEqual([founder.id, middle.id])
    // The live kids held 0.6 of the tab between them, so the row that describes
    // only them is 0.5/0.5. Read from the raw file, not through `store.read()`,
    // which would rescale a wrong answer into a right-looking one.
    expect(row?.layout.ratio[0]).toBeCloseTo(0.5)
    expect(row?.layout.ratio[1]).toBeCloseTo(0.5)
    expect(after.panes.map((pane) => pane.id).sort()).toEqual(
      before.panes.map((pane) => pane.id).sort(),
    )
  })

  it('ignores a record naming a pane the tab does not have, and writes nothing', async () => {
    const { founder, second } = await splitOnce()
    const before = await written()
    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.5, [second.id]: 0.3, 'not-a-pane': 0.2 } as never,
    )
    await settle(200)
    const after = await written()
    expect(after.tabs[0].layout.ratio).toEqual(before.tabs[0].layout.ratio)
  })
```

And the one test that witnesses the `owed` half — **the pty-heaviest thing this plan adds,
and the only thing standing between that branch and dead code:**

```ts
  it('keeps what a tombstone is owed current, so the next split reserves the dragged share', async () => {
    // A, C, B at 0.5/0.3/0.2. C dies and stays dead — a tombstone. B dies and
    // is restarted, so main owes it a claim and the row does not name it. The
    // user then drags C wider, and the next split must reserve the DRAGGED
    // share rather than the one C died at.
    const { founder, second } = await splitOnce()
    const split2 = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 100, rows: 30,
    })
    const third = split2.panes[1]
    await waitForPrompt(third.id)
    expect(split2.tabs[0].layout.kids).toEqual([founder.id, third.id, second.id])
    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.5, [third.id]: 0.3, [second.id]: 0.2 } as never,
    )
    await settle(200)

    // (kill `third` and leave it dead; kill `second` and restart it — the same
    // two-command death the other tests in this file use, then
    // CHANNELS.restartTab. Assert main's row is down to [founder] before going on.)

    ipc.listeners.get(CHANNELS.setLayout)?.(
      null as never,
      founder.id as never,
      { [founder.id]: 0.4, [third.id]: 0.4, [second.id]: 0.2 } as never,
    )
    await settle(200)

    const shape = await invoke<TabShape>(CHANNELS.splitPane, {
      paneId: founder.id, dir: 'row', cols: 100, rows: 30,
    })
    await waitForPrompt(shape.panes[shape.panes.length - 1].id)
    const row = shape.tabs[0]
    const at = (id: string): number => row.layout.ratio[row.layout.kids.indexOf(id)]
    // Whole tab: founder 0.2, new 0.2, second 0.2, third(tombstone) 0.4. The
    // three live kids hold 0.6, so each takes a third of the row. Without the
    // drag reaching the record, `third` would still be owed the 0.3 it died at,
    // the live kids would hold 0.7, and `second` would come back at 2/7 = 0.286.
    expect(at(second.id)).toBeCloseTo(1 / 3)
    expect(at(founder.id)).toBeCloseTo(1 / 3)
    expect(row.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })
```

- [ ] **Step 2: Run to verify they fail** — `npx vitest run tests/unit/shares.test.ts`
(`routeShares is not a function`), then typecheck, which fails at every `setLayout` call
site until the signature changes.

- [ ] **Step 3: Implement**

`shares.ts`:

```ts
/**
 * A layout message's shares, split into what belongs in the row and what
 * belongs in the tombstone record.
 *
 * The renderer's shares are whole-tab and cover its whole row — every live kid
 * AND every tombstone — so they sum to 1. Main's row covers only the panes it
 * has, so the saved kids' shares are divided by their own total: the same
 * projection `inLiveFrame` does for a split, so a drag and a split cannot
 * disagree about the frame. What is left over names panes the row does not
 * have, and each one has to be a pane this tab already owes a share to.
 *
 * **All or nothing.** A message that names a pane this tab cannot place, or
 * that fails to name a saved kid, describes a tab main and the renderer
 * disagree about the membership of. Applying half of it would put the row in
 * one frame and the record in another, and pairing a short ratio with the
 * row's kids is worse still: `normaliseLayout` reads a ratio shorter than its
 * kids as unusable and flattens the whole tab to an even split, so a drag
 * would silently reset the layout it was adjusting. Refused, with a reason the
 * caller logs — and that log is the only one on this path, because this is the
 * only outcome that is not simply a drag being written down.
 *
 * Nothing here checks that the shares sum to 1. That is the channel's
 * contract, held by the renderer's own row invariant, and it is a
 * cross-process fact this side cannot verify; a tolerance check here would be
 * the length guard back in another shape. `ratio` is immune to it either way —
 * it is a projection — while `owed` is not, and that is stated rather than
 * defended.
 */
export type RoutedShares =
  | { ok: true; ratio: number[]; owed: { id: string; share: number }[] }
  | { ok: false; why: string }

export function routeShares(
  shares: Readonly<Record<string, number>>,
  savedKids: readonly string[],
  owes: (paneId: string) => boolean,
): RoutedShares {
  const missing = savedKids.filter((kid) => shares[kid] === undefined)
  if (missing.length > 0) return { ok: false, why: `no share for ${missing.join(', ')}` }
  const rest = Object.keys(shares).filter((id) => !savedKids.includes(id))
  const unplaced = rest.filter((id) => !owes(id))
  if (unplaced.length > 0) return { ok: false, why: `no pane or claim for ${unplaced.join(', ')}` }
  const mine = savedKids.map((kid) => shares[kid] ?? 0)
  const held = mine.reduce((sum, share) => sum + share, 0)
  if (!(held > 0)) return { ok: false, why: 'the saved kids hold none of the tab' }
  return {
    ok: true,
    ratio: mine.map((share) => share / held),
    owed: rest.map((id) => ({ id, share: shares[id] ?? 0 })),
  }
}
```

`src/shared/ipc.ts` — `setLayout(tabId: string, shares: Record<string, number>): void`, with
the doc comment saying what a share is: **a fraction of the whole tab, one per pane the
renderer draws in it, tombstones included.** Keep the fire-and-forget and once-on-release
paragraphs.

`src/preload/index.ts` — `setLayout: (tabId, shares) => ipcRenderer.send(CHANNELS.setLayout, tabId, shares),`

`register.ts`:

```ts
  ipcMain.on(CHANNELS.setLayout, (_event, tabId: string, shares: Record<string, number>) => {
    void serialise(async () => {
      const config = await store.read()
      const saved = config.tabs.find((row) => row.id === tabId)
      if (!saved) return
      const routed = routeShares(shares, saved.layout.kids, (id) =>
        claimFor(tabId, id, tombstones) !== undefined,
      )
      if (!routed.ok) {
        console.warn(`PRCLI: ignored a layout for ${tabId} — ${routed.why}`)
        return
      }
      // The renderer wins on a tombstone's share, and only here: it is what the
      // user is looking at and what they just dragged. Main's record is
      // corrected by every commit rather than defended against one. An
      // in-memory write, so this adds no new path back into `serialise`.
      for (const entry of routed.owed) {
        tombstones.set(entry.id, { tabId, share: entry.share })
      }
      const tabs = withTabRow(config.tabs, tabId, {
        ...saved,
        layout: { ...saved.layout, ratio: routed.ratio },
      })
      await store.write({ ...config, tabs })
    })
  })
```

**Rewrite `CHANNELS.setLayout`'s doc comment.** The "length guard's dominant trigger is NOT
a race" and "the common case is structural" paragraphs describe a guard that no longer
exists. Replace them with what the routing does and what each outcome means, keep the
"writes `config.tabs` and nothing else" paragraph and the "a row for a tab this handler has
no saved layout for is not invented" paragraph, and state that the superset invariant those
paragraphs leaned on is no longer load-bearing.

`App.tsx`:

```tsx
  const commitLayout = useCallback(
    (tabId: string) => {
      const row = state.tabs.find((candidate) => candidate.id === tabId)
      if (!row) return
      // Named, not positional: main's row is a subset of this one whenever the
      // tab holds a tombstone, and pairing the two by index is what dropped
      // every such drag. Whole-tab fractions, tombstones included — which is
      // what this row holds, on every path that writes it.
      window.prcli.setLayout(
        tabId,
        Object.fromEntries(row.layout.kids.map((id, index) => [id, row.layout.ratio[index] ?? 0])),
      )
    },
    [state.tabs],
  )
```

**Rewrite `dividers.test.ts`'s header bullet** "that main actually persists what this handler
sends", which declares the CT-1 gap as permanent uncovered ground. What is still true is
narrower and should say so: this file reaches as far as the IPC call being made and never
what main does with it; what main does is now pinned in `persistence.test.ts` and
`shares.test.ts`.

- [ ] **Step 4: Run** — `npx vitest run tests/unit`, `npm run typecheck`, `npm run check-deps`,
then `npx vitest run tests/integration/persistence.test.ts` **alone**, counting resource
errors inside assertion text as well as error lines before believing any failure.

- [ ] **Step 5: A/B** — three times. (a) Drop the `for (const entry of routed.owed)` loop;
confirm `keeps what a tombstone is owed current…` fails with `second` at 0.286. (b) Return
`ratio: mine` from `routeShares` without dividing by `held`; confirm
`writes a drag on a tab holding a tombstone…` fails with 0.3/0.3 in the file. (c) Make the
`!routed.ok` branch write the row anyway; confirm `ignores a record naming a pane the tab
does not have` fails. Restore by snapshot copy each time; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Send a layout with its panes named, so none of it is guessed"`

---

### Task 6: Dismissing one tombstone leaves the others honest

**Files:**
- Modify: `src/main/ipc/shares.ts`, `src/main/ipc/register.ts`
- Test: `tests/unit/shares.test.ts`, `tests/unit/tombstoneFrame.test.ts`

**Interfaces:**
- Produces: `withoutClaim(tabId, paneId, claims): void`-shaped rescale, exported as a pure `rescaledClaims(tabId, gone, claims): Map<string, Claim>` in `shares.ts`.

**This goes one step past the design doc's four parts, and here is the measurement that
earns it.** Task 1 renormalises the renderer's row when a pane is dismissed — the survivors
divide the tab, which is what `boxesOfRow` already draws. Main does not: `dismissTab`
deletes the dismissed pane's claim and leaves every other claim for that tab at its
pre-dismiss value. Measured, on `A .5 / C .3 / B .2` with both C and B dead, B dismissed,
then C restarted and A split: main emits **A .35 / new .35 / C .30** and the screen shows C
at 0.30, when C had grown to 0.375 of the tab the moment B was dismissed. With the rescale,
main emits A .3125 / new .3125 / C .375 and C comes back at exactly the width it had. It is
the same defect class this whole plan is about, one event later, and it is four lines.

It does not arise on a close: the renderer keeps a tombstone at its prior share across
`closedPane` and scales main's row into the rest, so the two already agree. Only a dismiss
redistributes a share the two sides account for separately.

- [ ] **Step 1: Write the failing tests**

In `tests/unit/shares.test.ts`:

```ts
describe('rescaledClaims', () => {
  it('grows this tab’s remaining claims into the space the dismissed one left', () => {
    // B held 0.2 of the tab and has been dismissed, so what is left divides a
    // tab that is 0.8 of what it was: 0.3 of the old tab is 0.375 of the new
    // one. The renderer does exactly this to its own row; this is main
    // following, not main deciding.
    const next = rescaledClaims('tab1', 0.2, new Map([
      ['c', { tabId: 'tab1', share: 0.3 }],
      ['far', { tabId: 'tab2', share: 0.3 }],
    ]))
    expect(next.get('c')?.share).toBeCloseTo(0.375)
    // Another tab's claims are a fraction of another tab. Untouched.
    expect(next.get('far')?.share).toBeCloseTo(0.3)
  })

  it('leaves everything alone when the dismissed pane was owed nothing', () => {
    const claims = new Map([['c', { tabId: 'tab1', share: 0.3 }]])
    expect(rescaledClaims('tab1', 0, claims).get('c')?.share).toBeCloseTo(0.3)
  })

  it('leaves everything alone when the dismissed pane held the whole tab', () => {
    // Dividing by zero here would poison every share it reached. Nothing is a
    // better answer than Infinity, and the next rebuild renormalises anyway.
    const claims = new Map([['c', { tabId: 'tab1', share: 0.3 }]])
    expect(rescaledClaims('tab1', 1, claims).get('c')?.share).toBeCloseTo(0.3)
  })
})
```

In `tests/unit/tombstoneFrame.test.ts`, add the composed case: two tombstones, one
dismissed, the other restarted, then a split — asserting the screen shows A .3125 / new
.3125 / C .375, and naming 0.30 in the comment as what it gives without the rescale.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

In `shares.ts`:

```ts
/**
 * `claims`, with every share this tab still owes grown into the space a
 * dismissed pane left.
 *
 * A dismiss is the one event that removes a pane from a tab without either
 * side rebuilding the row: the renderer drops the kid and renormalises what is
 * left (see `workspace.ts`'s `withoutKid`), so every surviving share — live
 * pane and tombstone alike — becomes a fraction of a smaller tab. Main has to
 * follow, or its record and the renderer's row are in two frames again, which
 * is the defect this whole plan exists to remove.
 *
 * Only this tab's claims, because `gone` is a fraction of this tab.
 * `gone <= 0` and `gone >= 1` are both left alone rather than divided by:
 * nothing was owed, or the whole tab was, and neither has a rescale that means
 * anything. A close needs none of this — the renderer keeps a tombstone at its
 * prior share across `closedPane` and scales main's row into the rest, so the
 * two already agree.
 */
export function rescaledClaims(
  tabId: string,
  gone: number,
  claims: ReadonlyMap<string, Claim>,
): Map<string, Claim> {
  const room = 1 - gone
  if (!(gone > 0 && room > 0)) return new Map(claims)
  return new Map(
    [...claims].map(([id, held]) =>
      held.tabId === tabId ? [id, { ...held, share: held.share / room }] : [id, held],
    ),
  )
}
```

In `register.ts`'s `dismissTab` handler, in place of the bare `tombstones.delete(id)`:

```ts
    // Read before the delete, because the record is the only thing left that
    // can say which tab this pane was in and what it held: `forgetTab` dropped
    // its row at its death, and `store.read()` dropped its kid after that. The
    // tab id travels on the claim for exactly this reason.
    const held = tombstones.get(id)
    tombstones.delete(id)
    if (held) {
      // The renderer has just renormalised its row around this pane leaving.
      // Following it here is what keeps the two frames in step until the next
      // rebuild; see `rescaledClaims`. The rescale changes values and never
      // the key set, so writing each entry back is the whole of applying it.
      for (const [paneId, claim] of rescaledClaims(held.tabId, held.share, tombstones)) {
        tombstones.set(paneId, claim)
      }
    }
```

- [ ] **Step 4: Run** — `npx vitest run tests/unit`, `npm run typecheck`. No integration run
is needed here and none is added: the composition test is the witness, and a real dismiss
costs a pty for a fact that is pure arithmetic.

- [ ] **Step 5: A/B** — replace `rescaledClaims(held.tabId, held.share, tombstones)` with
`tombstones`; confirm the composed dismiss case in `tombstoneFrame.test.ts` fails with C at
0.30 instead of 0.375. Then drop the `held.tabId === tabId` condition inside
`rescaledClaims` and confirm the "another tab's claims are untouched" assertion fails.
Restore by snapshot copy each time; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Follow the renderer when a dismiss makes the tab smaller"`

---

### Task 7: `grabPane`'s pair resolution and its floor, as a function

**Files:**
- Modify: `src/renderer/workspace.ts`, `src/renderer/App.tsx`
- Test: `tests/unit/workspace.test.ts`, `tests/unit/dividers.test.ts`

**Interfaces:**
- Produces: `grabFor(row, boxes, index, gridOf, floors): { at: number; ratio: number[]; min: number } | null` in `workspace.ts`.

The 2c ledger deferred this as a candidate for a later plan, and this is the plan that has a
reason: **CT-1's inert-dividers half is a bug in that guard**, and `dividers.test.ts`'s own
header records three separate ways it cannot see the code: deleting all three refusal guards
passes, swapping `minRatioFor`'s arguments passes, and turning the `/` in
`axisCells = grid.cols / low.share` into a `*` passes. After Task 1 the guards can no longer
fire in ordinary use — which is the right outcome for a guard, and exactly why the arithmetic
around them needs a test that is not a grep.

The guards stay. They still guard a box index taken for a kid index, and ruling 4 of the
design is explicit that no new UI is added for a refused grab.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/workspace.test.ts`:

```ts
describe('grabFor', () => {
  const boxes = (shares: number[], ids: string[]): PaneBox[] =>
    shares.map((share, index) => ({
      pane: tab(ids[index]),
      share,
      style: { flexBasis: `${share * 100}%` },
      dead: false,
    }))
  const grid = () => ({ cols: 100, rows: 30 })
  const floors = { cols: 20, rows: 5 }

  it('takes the pair, the shares on screen, and a floor in the axis being dragged', () => {
    // The low box covers half a `row` tab and is 100 columns wide, so the tab's
    // axis is 200 columns and a 20-column floor is a tenth of it.
    const held = grabFor(ratioRow('aaa', ['aaa', 'bbb'], [0.5, 0.5]), boxes([0.5, 0.5], ['aaa', 'bbb']), 1, grid, floors)
    expect(held).not.toBeNull()
    expect(held?.at).toBe(0)
    expect(held?.ratio).toEqual([0.5, 0.5])
    expect(held?.min).toBeCloseTo(0.1)
  })

  it('measures a col tab down the other axis, against the other floor', () => {
    // The pairing that a bare `minRatioFor(` grep cannot see: 30 rows over half
    // the axis is 60 rows, and a 5-row floor is 1/12 of it. Swapping the two
    // arguments gives 12; multiplying instead of dividing gives 1/3.
    const held = grabFor(ratioRow('aaa', ['aaa', 'bbb'], [0.5, 0.5], 'col'), boxes([0.5, 0.5], ['aaa', 'bbb']), 1, grid, floors)
    expect(held?.min).toBeCloseTo(5 / 60)
  })

  it('takes the shares from the boxes, not from the row', () => {
    // `boxesOfRow` renormalises what it draws, so the screen's shares and the
    // stored ones are not the same list. A delta measured against the screen
    // has to be applied to the screen's own numbers.
    const held = grabFor(ratioRow('aaa', ['aaa', 'bbb'], [2, 2]), boxes([0.5, 0.5], ['aaa', 'bbb']), 1, grid, floors)
    expect(held?.ratio).toEqual([0.5, 0.5])
  })

  it('refuses when the boxes and the kids are not the same list', () => {
    // A kid whose pane is missing: the box index and the kid index have slid
    // apart, and applying the drag at the box index would resize a pane nobody
    // touched. This is the state a dismiss used to leave behind for good.
    const row = ratioRow('aaa', ['aaa', 'gone', 'bbb'], [0.4, 0.2, 0.4])
    expect(grabFor(row, boxes([0.5, 0.5], ['aaa', 'bbb']), 1, grid, floors)).toBeNull()
  })

  it('refuses when the boxes are the same length but not the same panes', () => {
    const row = ratioRow('aaa', ['aaa', 'zzz'], [0.5, 0.5])
    expect(grabFor(row, boxes([0.5, 0.5], ['aaa', 'bbb']), 1, grid, floors)).toBeNull()
  })

  it('refuses at either edge and for an index naming no pair', () => {
    const row = ratioRow('aaa', ['aaa', 'bbb'], [0.5, 0.5])
    const pair = boxes([0.5, 0.5], ['aaa', 'bbb'])
    expect(grabFor(row, pair, 0, grid, floors)).toBeNull()
    expect(grabFor(row, pair, 2, grid, floors)).toBeNull()
  })

  it('refuses when the low pane has no mounted terminal to measure, or no width', () => {
    const row = ratioRow('aaa', ['aaa', 'bbb'], [0.5, 0.5])
    expect(grabFor(row, boxes([0.5, 0.5], ['aaa', 'bbb']), 1, () => undefined, floors)).toBeNull()
    expect(grabFor(row, boxes([0, 1], ['aaa', 'bbb']), 1, grid, floors)).toBeNull()
  })
})
```

`PaneBox` needs adding to `workspace.test.ts`'s import block, along with `grabFor`.

- [ ] **Step 2: Run to verify they fail** — `grabFor is not a function`.

- [ ] **Step 3: Implement**

Move the body of `App.tsx`'s `grabPane` into `workspace.ts`, beside `resizeKids`, keeping its
whole doc comment (it is the argument for why the guards exist) and adding one paragraph
saying why it lives here now: it is arithmetic, `App.tsx` had the only copy, and a static
source check was measured unable to see any of it.

```ts
export function grabFor(
  row: TabRow,
  boxes: readonly PaneBox[],
  index: number,
  gridOf: (paneId: string) => { cols: number; rows: number } | undefined,
  floors: { cols: number; rows: number },
): { at: number; ratio: number[]; min: number } | null {
  const low = boxes[index - 1]
  const high = boxes[index]
  if (!low || !high) return null
  if (boxes.length !== row.layout.kids.length) return null
  if (row.layout.kids[index - 1] !== low.pane.id) return null
  if (row.layout.kids[index] !== high.pane.id) return null
  const grid = gridOf(low.pane.id)
  if (!grid || low.share <= 0) return null
  const axisCells = (row.layout.dir === 'row' ? grid.cols : grid.rows) / low.share
  const floor = row.layout.dir === 'row' ? floors.cols : floors.rows
  return { at: index - 1, ratio: boxes.map((box) => box.share), min: minRatioFor(floor, axisCells) }
}
```

`App.tsx`'s `grabPane` becomes the lookup and the ref write:

```tsx
  const grabPane = useCallback(
    (tabId: string, index: number, boxes: PaneBox[]) => {
      const row = state.tabs.find((candidate) => candidate.id === tabId)
      const held = row
        ? grabFor(row, boxes, index, paneGrid, { cols: MIN_PANE_COLS, rows: MIN_PANE_ROWS })
        : null
      grabbed.current = held ? { tabId, ...held } : null
    },
    [state.tabs],
  )
```

Drop `minRatioFor` from `App.tsx`'s import block and add `grabFor`. `MIN_PANE_COLS` and
`MIN_PANE_ROWS` **stay in `App.tsx`** — `splitActive` uses them and `shortcuts.test.ts`
asserts them against that file's source.

**`dividers.test.ts` needs two edits, and they are not optional.** Its
`expect(app).toMatch(/minRatioFor\(/)` assertion will fail, because that call is no longer in
`App.tsx`: change it to `/grabFor\(/`. And its header's two "what this does NOT cover"
bullets — `grabPane`'s refusal guards, and the floor derivation with its measured-dead
`minRatioFor(` token — are now covered by `workspace.test.ts` and must say so, naming the
three mutations that used to pass and now do not.

- [ ] **Step 4: Run** — `npx vitest run tests/unit`, `npm run typecheck`.

- [ ] **Step 5: A/B** — three times, and these are precisely the three mutations the old
static check was measured unable to see. (a) Swap `minRatioFor`'s arguments; confirm
`measures a col tab down the other axis, against the other floor` fails. (b) Change
`grid.cols / low.share` to `grid.cols * low.share`; confirm the same test fails with 1/3.
(c) Delete the two identity guards; confirm `refuses when the boxes are the same length but
not the same panes` fails. Restore by snapshot copy each time; `git diff` empty.

- [ ] **Step 6: Commit** — `git commit -m "Put the drag's pair and floor where they can be tested"`

---

### Task 8: The whole-tab property, exhaustively

**Files:**
- Modify: `tests/unit/tombstoneFrame.test.ts`
- Test: itself.

**Interfaces:** none. No production change.

The four named cases are the seed; this is the check that there is no fifth. The property is
the recommendation's central claim: **for any sequence of deaths, restarts and dismisses,
main's row composed through the renderer's merge reproduces the whole-tab vector.**

**Enumerated, not generated.** A random property test would be the first in this repo and
would bring a decision about flake, seeds and shrinking that nothing here needs: over a
three-pane tab the space of "which panes die, in which order, which come back, which are
dismissed, which pane is then split" is small enough to enumerate completely, and an
exhaustive test is reproducible, prints the case it failed on, and needs no library. If the
tab size ever grows past what enumeration can cover, that is the moment to reach for
generation.

- [ ] **Step 1: Write the test**

Enumerate over a tab of three panes at `0.5 / 0.3 / 0.2`: every subset of panes that die, in
every order; for each, every subset of the dead that are restarted and every subset of the
rest that are dismissed; then split each surviving pane in turn. Drive main through
`claimForDeath` → `carveRatio` exactly as `forgetTab`/`splitPane` do, and the renderer
through `workspaceReducer`.

The oracle is a **model of the whole tab kept by the test itself**, independent of every
production function: start at `{A: .5, C: .3, B: .2}`; a death changes nothing; a restart
changes nothing; a dismiss removes the entry and divides the rest by what is left; a split
halves the source's entry and gives the other half to the new pane. Assert for each case:

- every pane on screen has exactly the model's share, to four places;
- `paneGroups` returns exactly one group and boxes every pane exactly once;
- the shares sum to 1 — necessary, not sufficient, and stated as such in the comment.

Skip only the cases that are not reachable at all: a tab whose every pane is dead has no
pane to split, and `closedPane` drops its row.

- [ ] **Step 2: Run** — `npx vitest run tests/unit/tombstoneFrame.test.ts`. Report **how many
cases it enumerated**; a property test that silently enumerated three is the shape of dead
test this project has found fifteen of.

- [ ] **Step 3: A/B** — twice. (a) Revert Task 3's `inLiveFrame` in `carveRatio`; confirm the
property fails and **report which case it names first** — it should be one holding a
tombstone, and the no-tombstone cases must still pass. (b) Make the model's dismiss step
*not* renormalise; confirm the property fails on a dismiss case, which is what shows the
oracle is doing work rather than agreeing with the code by construction. Restore by snapshot
copy; `git diff` empty.

- [ ] **Step 4: Commit** — `git commit -m "Check every ordering, not the four that were traced"`

---

## Deliberately not in this plan

- **`died` removing a kid.** Rejected by the design with the mechanism confirmed, and pinned against by Task 1's third test. A pane out of `kids` while still in `state.panes` is a stray; a dead founder's stray carries its row's id; `paneGroups` skips the second of the two and unmounts every live terminal in the tab.
- **Persisting a tombstone's share across a relaunch.** Restore prunes dead panes at launch, so there would be no pane to apply it to. Unchanged, and still right.
- **The `⊞n` badge and the tab-bar selection model.** Its own plan.
- **E2E coverage of any of this.** `2026-08-02-prcli-e2e-revival.md` carries the drag and the tombstone, and asks in its own Open Questions whether the `setLayout` guard should be fixed in a plan of its own. This is that plan; the two should be sequenced, not merged, and Task 8 of the E2E plan is worth more pointed at a fixed guard.
- **Arbitrary pane nesting, detach-a-pane-to-its-own-tab, two-dimensional drag.** Out of M2c.

**From the 2c ledger, judged rather than carried:**

- **Taken.** `grabPane`'s pair resolution and floor derivation → Task 7. A shared home for the main side's layout arithmetic → Task 2's `shares.ts`, because the frame conversion has two callers in two files and the composition test should not reach into `restore.ts` to find it.
- **Already closed, and the design doc is wrong to list them.** `held.tabId === row.id` is pinned by `claimForDeath.test.ts`'s first test, which was written for exactly that and A/B'd against exactly that regression — it exists at the design's own base commit. `workspace.test.ts`'s `resized` fixture already has a second, untouched row and an identity assertion on it, added in plan 2c. Neither needs work; Task 2 adds a *fresh* two-tab pin for `tombstonesOf`, because the predicate acquires a second consumer.
- **Stays deferred: the `remembered → claim` lookup written twice.** The two copies differ genuinely in their even fallback — `carveRatio` divides by `siblings.length`, `tabRowFor` by `kids.length` — and unifying them would move a number with no defect behind it. This plan's whole claim is that the only numbers that move are the wrong ones. Both now share `claimFor` and `tombstonesOf`, which is the part that could drift into two frames; the fallback cannot.
- **Stays deferred: `restore.ts`'s silent `catch { continue }`.** Still ~250 lines from anything this touches. It was explicitly conditional on landing next to it, and it does not.
- **Stays deferred: `data-testid="pane-divider"` not being unique per divider.** Only worth it if a test needs to address a specific seam; the E2E plan's Task 8 might, so it belongs there.
- **Stays deferred: `PaneDivider` measuring through `ref.current.parentElement`.** Real, unrelated to either defect, and the `inset-2` assertion pins the coupling today.
- **Stays deferred: a second concurrent pointer, and the floor being conservative by 1–2%.** The first is unreachable with one mouse; the second is harmless in direction, and Task 7 is what makes it measurable if anyone wants to.

**Declared uncovered, so it is not mistaken for coverage:**

- **That main's tombstone set and the renderer's `state.dead` actually agree at runtime.** A cross-process fact. Each side's own rule is pinned, and so is the round trip through `persistence.test.ts`'s mocked `ipcMain`; the agreement itself is not.
- **That the renderer's shares really sum to 1 when they arrive at `setLayout`.** The channel's contract, held by the renderer's row invariant, which Task 1 is what completes. `routeShares` is immune to it for the row and not for the record, and says so.
- **The gesture itself** — hit area, cursor, listener attach and teardown, whether a pane follows the cursor. Unchanged from plan 2c and unchanged by this work. `dividers.test.ts`'s header is the standing record.
- **Manual verification, still owed from plan 2c.** The drag has never been watched in a real window, and this plan does not discharge it. A dev build and a packaged build are both live against the real config; the drag already exists in the running dev window, so it can be watched without relaunching anything.

## Self-review

**Design coverage.** Tombstone record and its reader → Task 2. Both row builders in the
live-remainder frame → Task 3. `setLayout` naming its panes → Task 5. Renderer dropping a
dismissed kid, never a dead one → Task 1. `withKeptPanes ∘ sharesAroundClaims`, the blind
spot CT-2 lived in → Task 4. All four death orderings as named cases, including the fourth
→ Task 4. A property test on top of the named cases → Task 8. `SessionManager.tabWasIn`
cited rather than moved → Task 2's `Claim` doc. `grabPane`'s three guards kept → Task 7.
No new UI for a refused grab → nothing; stated here so its absence is deliberate.

**Ordering.** 1 is independent and lands first because it is worth having on its own. 2
before 3 (the reader is what the conversion selects with). 3 before 4 (4 is 3's composition)
and before 5 (5 divides by the same total). 5 before 6 only by convention — 6 needs 1 and 2.
7 is independent of 2–6 and after 1, whose change is what makes those guards unreachable in
ordinary use. 8 last, because it covers everything before it.

**The four orderings, derived against the real code rather than copied.** Every number in
Task 4's table was measured by importing `claimForDeath`, `carveRatio`, `sharesAroundClaims`,
`workspaceReducer` and `paneGroups` from `d5dc35d` and running both the current and the
proposed arithmetic. They match the design doc's table exactly. Two findings worth carrying:
the two death **orders** produce byte-identical claims and byte-identical output, so the
genuinely-fourth combination (C first, then B, B restarted) is the same case as the third —
what varies is only which pane came back; and the conversion is the exact identity on both
controls, so this change is a strict superset of today's behaviour rather than a
re-derivation of it.

**Pre-flight, run against the code before this plan was finished.** Every plan on this
project has shipped defects in its own snippets. What was checked here, and what it caught:

- **`workspace.test.ts`'s `resized` fixture already has a second row** and an identity assertion on it (`tests/unit/workspace.test.ts:1256-1271`), at the design's own base commit. The design doc's Part 6 lists this as outstanding and cites lines 92-95, which are `neighbourOf`'s. Already closed.
- **`claimForDeath.test.ts:17` already pins `held.tabId === row.id`** with two tabs holding unspent claims, and is non-vacuous (dropping the filter gives 0.18 against an expected 0.3). The design doc's Part 5 says no test does this. Already closed.
- **`tests/unit/shares.test.ts` imports `sharesAroundClaims` from `restore.ts`.** Task 2 moves that function, so the import must move with it or the file fails to resolve.
- **`dividers.test.ts:194` asserts `/minRatioFor\(/` against `App.tsx`'s source.** Task 7 moves that call into `workspace.ts` and the assertion fails. Named in the task, with the replacement, so nobody "fixes" it by leaving the call behind.
- **`workspace.test.ts:1520`'s dismiss test keeps every assertion** under Task 1 — the row becomes `[0.5, 0.5]` and `boxesOfRow`'s renormalisation becomes an identity, so both boxes still report `50%` — but its **comment becomes false**, and a false comment is a defect here.
- **`persistence.test.ts` drives `setLayout` through `ipc.listeners.get(CHANNELS.setLayout)?.(null, id, ratio)`, not `invoke`** — it is `ipcMain.on`. There are seven call sites plus `splitThenRestartSibling(ratio?)`'s parameter, all of which change shape in Task 5.
- **`written()` parses the raw config file**, not `store.read()`. That is what makes Task 5's `0.5 / 0.5` assertion sharp: through `store.read()`, `normaliseLayout` would rescale a wrong `0.3 / 0.3` into a right-looking answer.
- **The two existing restart tests in `persistence.test.ts` have no tombstone** — one death, restarted, so the claim is spent and the conversion is the identity. Their pinned numbers must not move, and that is Task 3's Step 4 check.
- **`carveRatio`'s existing `remembered` maps all name kids that are IN `kids`**, so no existing expectation in `carveRatio.test.ts` or `shares.test.ts` moves either. Only the map's element type and the new `tabId` parameter change.
- **`restoreWorkspace` calls `tabRowFor` with three arguments**; the fourth stays optional, so it still compiles and gets no tombstones — which is right, since restore prunes dead panes and never meets one.
- **`MIN_PANE_COLS`/`MIN_PANE_ROWS` must stay in `App.tsx`** — `shortcuts.test.ts` asserts both tokens against that file's text, and `splitActive` uses them.
- **`console.warn('PRCLI: …')` is the house form** for a main-process warning (`store.ts:411`, `inbox.ts:76`).
- **`grabFor` takes a `gridOf` callback** rather than importing `paneGrid`: `workspace.ts` is DOM-free and `Terminal.tsx` is not, and the unit suite has no DOM to mount a terminal in.

**Known soft spots, stated rather than hidden.**

- Task 5's `owed` write has exactly one witness, and it is the pty-heaviest test in the plan: five sessions, a real death, a real restart. If it cannot be run against a starved machine, say so and leave it failing rather than deleting it — the branch is dead code without it, and the pure `routeShares` test cannot tell whether the handler calls it.
- Task 6 goes one step past the design doc's four parts. The measurement that earns it is in the task; a reviewer who disagrees can strike the task without touching any other, and the residual is then a declared one rather than a hidden one.
- Task 8's oracle is a model written in the test file. A model that drifts from what the app should do is a test that pins the wrong thing, which is why its second A/B breaks the model rather than the code.
- `inLiveFrame` leans on the tombstone entries being appended after the kids' entries. That coupling is one line away at both call sites and is stated in its doc, but it is a positional assumption in a plan about removing one, and it is the thing to look at first if a future entry type is added.

## Controller rulings on the planner's three worries (2026-08-02)

Settled under standing authority before dispatch, so no implementer has to guess.

**(c) `inLiveFrame` must not slice a prefix. Select the live kids by id.** The planner flagged
this itself and was right to: a positional assumption, inside a plan whose whole purpose is
removing a positional assumption, is the defect wearing the fix's clothes. It also silently
depends on tombstone entries being appended last, which is a contract nothing states and
nothing tests. Select by pane id, and say in the comment why a slice was rejected.

**(a) Task 6 stays.** It goes one step past the design doc's four parts, but it fixes a
measured wrong number — a restarted pane coming back at 0.375 instead of 0.30 — and a
dismiss redistributing shares the two sides account for separately is the same root cause
this plan exists to close, not a new one. It remains the first thing to cut if the plan runs
long, and it is marked strikeable for that reason.

**(b) Task 5's `owed` write needs a cheaper witness first.** One witness, and it is the
pty-heaviest test in the plan — five sessions, a real death and a restart — on a machine
that has failed `persistence.test.ts` three times tonight with the failure count exactly
equal to the resource-error count. Try to witness the branch at unit level first; keep the
integration test only if nothing cheaper can see it, and say in the report which it was. A
branch whose only proof cannot be run reliably is not much better than dead code.
