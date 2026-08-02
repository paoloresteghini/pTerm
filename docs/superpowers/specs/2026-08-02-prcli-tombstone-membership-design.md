# Tombstone membership — where the authority over a tab's panes lives

**Goal:** close CT-1 and CT-2, the two behavioural Importants the plan-2c whole-branch
review deferred and that are now live on master, by settling the one question both fall
out of: **who is allowed to say which panes a tab holds, and in what frame a share is
measured.**

**Base:** `master` at `1407ad6`. Unit 514/514 green, verified before anything below was
written. Integration deliberately not run — the machine is pinned at 422 of 511 ptys and
`persistence.test.ts` has failed three times tonight with the failure count exactly equal
to the resource-error count.

---

## Part 1 — What I reproduced, and what the review got wrong

Everything in this section was executed against the code as committed at `1407ad6`, using
the real production functions (`claimForDeath`, `carveRatio`, `sharesAroundClaims`,
`workspaceReducer`, `paneGroups`) imported directly, in `environment: 'node'`, with no DOM
and no ptys. Where a number appears below it was measured, not derived on paper.

### CT-1 — reproduced, both halves, and it is worse-founded than "a race"

**The persistence half.** `commitLayout` (`App.tsx:366`) sends `row.layout.ratio` from
renderer state. `setLayout`'s guard (`register.ts:727`) compares its length against main's
saved kids. After any death in a tab, the renderer's `layout.kids` is a **permanent strict
superset** of main's: `forgetTab` drops the pane row, `normaliseLayout` (`store.ts:151`)
then drops the kid, and the renderer's reducer never removes a dead kid — `died`
(`workspace.ts:912`) writes only `state.dead`, and `removeTab` (`workspace.ts:798`) filters
`state.panes` and leaves `kids` untouched. Lengths differ, the write returns, nothing logs.
Confirmed by construction; there is no timing involved.

Then the loss reaches the screen. Measured, on a tab whose kids are `[A, B(dead), C]`: the
user drags A from 0.4 to 0.6, the write is dropped, and the next split rebuilds from the
**pre-drag** saved ratio — the live panes snap back while the tombstone keeps the share the
drag gave it. So the drag is not merely unsaved; it is half-reverted, in a way that leaves
the tombstone and the live panes describing two different gestures.

**The inert-dividers half.** `dismissed` (`workspace.ts:914`) drops the pane from
`state.panes` and leaves its id in `layout.kids` for ever. `boxesOfRow` boxes only kids
whose pane exists, so boxes become one shorter than kids, and `grabPane`'s 1:1 guard
(`App.tsx:311`) refuses **every** grab in that tab. Measured: kids stay `['A','C','B']`,
panes become `['A','C']`, boxes 2 ≠ kids 3. The divider still draws and still shows
`col-resize`. It is repaired only by the next split or close (which rebuild `kids` from
main's reply, and cannot restore the dismissed pane because it is no longer in
`state.panes`) or by a relaunch.

"A tab of three or more kids" is exactly right, and worth stating as an arithmetic fact
rather than a rule of thumb: a dismiss leaves `kids − 1` boxes, and a divider is only drawn
above box index 0, so at two kids the dismissal leaves one box and no divider at all.

**One correction to the review's supporting argument.** The reviewer wrote that "renderer
kids are always a superset of main's, so equal length implies equal membership", and used
that to conclude no corruption is possible. I re-derived it and believe it is true today:
every `TabShape` reply carries `panes` for every kid it names, `withKeptPanes` only ever
*adds* prior kids back, and main's saved kids only ever shrink between round trips
(`forgetTab` → `normaliseLayout`; nothing grows them without a reply to the renderer). But
it is a four-file argument that **nothing anywhere asserts**, and it is the only thing
standing between the current wire and a positionally-misaligned ratio written to disk. It
should not stay load-bearing.

### CT-2 — reproduced exactly, and it is not an artefact of the death order

Trace as recorded: tab `A .5 / C .3 / B .2`; B dies and is not restarted; C dies and is
restarted; the user splits A.

Measured, end to end:

| | main's row | on screen after `withKeptPanes` |
|---|---|---|
| A | 0.35 | **0.28** (half of 0.5 is 0.25 → **12% wide**) |
| new | 0.35 | **0.28** |
| C | 0.30 | **0.24** — nobody touched C |
| B (tombstone) | — | 0.20 |

Sum 1.0. No zero-width box. Nothing logs. Every number in the review's trace is exact.

I then ran three things the review did not.

**(a) The reverse death order gives the identical defect.** C dies first (claim 0.3), then
B (row share 0.2857, claim correctly 0.2). Split A: `carveRatio` returns
`[0.35, 0.35, 0.30]` and the screen shows `C = 0.24` again. CT-2 is a property of the
frame, not of the order.

**(b) The reviewer's candidate fix does not work.** The candidate — record the raw row
share plus a death ordinal, compose honoured claims in death order at rebuild — is exactly
right in the traced case, and I confirmed why: there, the only unhonoured tombstone died
*before* the honoured claim, so the honoured claim's raw share is already expressed in the
frame the renderer will use. **Reverse the two deaths and it degenerates to today's code.**
Measured: with C dying first, its raw share is 0.3, nothing rebases it, `sharesAroundClaims`
returns `[0.35, 0.35, 0.30]` — byte-identical to the current output, and 0.24 on screen. The
death ordinal buys nothing that `claimForDeath` does not already have, because
`claimForDeath`'s eager `taken` correction *is* the ordinal composition, done at death
instead of at rebuild. This is the reviewer's candidate failing, not the reviewer failing:
it was offered as a candidate and not a mandate, and two traced cases is exactly the
evidence it was offered on.

**(c) There is a third ordering, never traced, in which the restarted pane itself is the
one that shrinks.** B dies, C dies, **B** is restarted while C stays a tombstone, split A.
Measured: main emits `[A 0.4, new 0.4, B 0.2]`, and the screen shows
`A 0.28 / new 0.28 / C 0.30 / B 0.14`. **B died at 0.20 and comes back at 0.14** — a 30%
shrink of the one pane the user did act on. This is the same root cause, and it is the most
user-visible face of it, because the pane that moves is the one the user just restarted.

### The root cause, stated once

`normaliseLayout` (`store.ts:172`) rescales every saved row to sum to 1 **over the panes
that exist**. So main's `config.tabs` row is, by the file format's own invariant, always in
what I will call the **live-remainder frame**: shares of what is left after every pane that
does not exist.

A claim, on the other hand, is defined as a fraction of the **whole tab** — that is Paolo's
ruling, and `claimForDeath` implements it correctly. I verified the traced claim values are
exact in every ordering: 0.2 for B and 0.3 for C, both orderings, both exactly what the
pane held of the whole tab when it died.

`sharesAroundClaims` then writes whole-tab claims into a live-remainder vector and calls it
done. When the tab holds no tombstone the two frames coincide and everything is right —
which is why this was invisible for a milestone. When the tab holds a tombstone they differ
by exactly the tombstone's share, the renderer scales main's already-whole vector down a
second time, and the difference lands on panes nobody touched.

**Neither recorded claim value can fix this, and I can now say why in one line.** I measured
that the *pre-fix* claim for C (0.375 — its share of the row as it stood, i.e. of the
live-remainder) composes through `withKeptPanes` to exactly `A .25 / new .25 / C .30 /
B .20`: perfectly right. And the *post-fix* claim (0.30) is the one that is right when B is
restarted before the split. The recorded number cannot be right for both because
**the frame a claim must be expressed in is not known at death — it depends on which panes
are still tombstones at rebuild.** So the claim must stay frame-independent (whole-tab, as
it is today) and **the conversion must happen at the rebuild, where the frame is known.**

Both defects are therefore the same sentence read twice: *main's row and the renderer's row
describe different tabs, and nothing converts between them.* CT-1 is that divergence
surfacing on the wire; CT-2 is it surfacing in the arithmetic.

---

## Part 2 — Rulings taken for this design (2026-08-02)

1. **A claim stays a whole-tab fraction. The frame conversion happens at the reader.**
   Measured above: no value recordable at death is correct for every rebuild, so recording
   a frame-relative number is recording a number that will be wrong later. The defect this
   prevents is the one the reviewer's candidate walks into — a fix that is exact in the
   case it was derived from and inert in that case's mirror.
2. **Main learns what a tombstone is, because it already half has.**
   `SessionManager.tabWasIn` (`manager.ts:186`) records which tab each *dead* pane was in;
   `register.ts`'s `shareWhenItDied` (`:448`) records what share it died at. Both are
   process-lifetime, keyed by pane id, written at death, dropped by the same two handlers
   (`dismissTab`, `closePane`). That pair **is** a tombstone record, split across two files
   and named after neither. The defect this prevents is the one in front of us: main
   currently cannot represent "a pane that is dead but still on screen", which is precisely
   the state the renderer is in, so it computes a whole-tab vector for a tab it will only
   ever be asked to describe part of.
3. **A layout message names its panes.** `setLayout(tabId, ratio: number[])` is positional
   and therefore fragile to exactly the divergence above. The defect this prevents is a
   silent dropped write today, and a silently *misaligned* write the day the superset
   invariant stops holding — an invariant that is currently maintained by four files and
   asserted by none.
4. **The renderer drops a kid when its pane leaves `state.panes`, and only then.**
   Dismiss and close remove the pane; death does not. The defect this prevents is CT-1's
   inert dividers. The defect it must not cause is 2b's Critical — see Direction A below
   for why the "and only then" is the whole safety argument.
5. **The sum comes out by construction, and the conversion is not a rescale.** Dividing a
   known-correct whole-tab vector by the total it holds for the live kids is a projection
   onto a smaller basis, not a renormalisation over an unknown total, and it sums to 1
   exactly. Written as one expression with the reason named, so nobody later "simplifies"
   it into a rescale that happens to agree.

---

## Part 3 — The design space

Four directions, weighed against what they fix, cost, risk, and which "What must not
regress" item they come near.

### A — Make the renderer drop dead kids, so both sides agree by construction

`died` removes the pane from `layout.kids` as well as recording it in `state.dead`.

**Fixes:** all of CT-1, by construction. Lengths can never differ; the dismiss leak goes
with it.
**Does not fix:** CT-2 at all.
**Reopens 2b's Critical, and I confirmed the mechanism rather than assuming it.** A pane
removed from `kids` but still in `state.panes` is a *stray*: `paneGroups` resolves
`tabOfPane` to undefined and gives it a group keyed by its own id. For a dead **founder**
that id is its row's id. `seen` then skips whichever is walked second, and in `state.panes`
order that is every live pane of the tab — each one unmounted, its scrollback destroyed.
That is `workspace.ts`'s own documented invariant (`:432-440`) and the case
`workspace.test.ts:1321` exists for. It also violates the standing ruling that
`withKeptPanes` keeps tombstones in their row at their share, since a tombstone outside
`kids` is not in the row at all.

**Rescuable only by adding a second structure** — a per-tab tombstone list the renderer
carries beside `kids`, with its own splice-back-in-order logic. That is `kids` under
another name, duplicated, with `paneGroups`'s stray/row dichotomy needing to learn about
it. **Rejected for `died`.**

**But it is right for `dismissed` and `removed`,** and the distinction is the whole point:
a dismissed pane leaves `state.panes` in the same reducer step, so it cannot become a stray,
so there is no id to collide. Even a dismissed *founder* is safe — the row keeps its id, no
stray carries that id, and the surviving kids still resolve through `tabOfPane`. This is
ruling 4, and it is the cheapest half of the whole fix.

### B — Make the wire carry kids, not just a ratio

`setLayout(tabId, shares: Record<paneId, number>)`.

**Fixes:** CT-1's persistence half, by construction — there is no positional pairing left to
misalign, so the superset invariant stops being load-bearing.
**Does not fix:** the inert dividers (renderer-side), or CT-2.
**Enables** something Direction D needs: it is the one moment main can learn a tombstone's
*current* share. Without it, a drag on a tombstone's own divider moves the renderer's
tombstone share and main's record goes stale, and CT-2 returns in a smaller form.

**A property worth having explicitly:** the renderer's shares are whole-tab and sum to 1
across live kids *and* tombstones. Main can therefore split the record — entries naming
saved kids become `layout.ratio` (divided by their own total, the same conversion as
ruling 5); entries naming a pane with a tombstone record update that record; anything else
is ignored **with a reason it can state**. That makes the commit a re-synchronisation of
main's frame from the renderer's own numbers at the one moment the user has just set them,
without making the renderer a second authority over *membership*.

**Cost:** one channel signature, `src/shared/ipc.ts`, `src/preload/index.ts`, one renderer
call site, one integration test. No config format change: main still writes `layout.ratio`
positionally against its own kids. Small.
**Risk:** the length guard's stated reason for existing ("a gesture that raced a split")
disappears, and the replacement must not become a silent drop wearing a new shape. The
guard becomes a per-name lookup that either lands, updates a tombstone, or is ignored — and
"ignored" is the only branch that should be able to log.

### C — Make a claim carry what it was a claim on (raw share + death ordinal)

The reviewer's candidate. **Measured not to work** — see Part 1(b). It is exact in the
traced case and inert in that case's mirror, because the ordinal reconstructs precisely
what `claimForDeath` already reconstructs. Its cost would be a map-shape change and a new
composition step in `sharesAroundClaims`; its benefit over today's code is zero in two of
the three orderings I ran. **Rejected, with the measurement rather than the opinion.**

It does contain the right instinct, and that instinct survives into the recommendation:
*do not collapse the frame at death; collapse it where the frame is known.* What the
candidate got wrong is **which** fact is missing at rebuild. It is not the order the panes
died in. It is which panes are still on screen.

### D — Teach main about tombstones

Promote the `tabWasIn` + `shareWhenItDied` pair into one explicit record, and give the row
builders the conversion that record makes possible.

**Fixes:** CT-2, in all three orderings I ran, exactly.
**Does not fix:** either half of CT-1 on its own.
**Depends on B** to stay true over time, per ruling 2.

Measured, on all three orderings plus the control:

| case | today, on screen | with D | truth |
|---|---|---|---|
| B dead, C restarted | C 0.24, A/new 0.28 | C 0.30, A/new 0.25 | C 0.30, A/new 0.25 |
| deaths reversed | C 0.24, A/new 0.28 | C 0.30, A/new 0.25 | same |
| C dead, B restarted | B 0.14, A/new 0.28 | B 0.20, A/new 0.25 | B 0.20, A/new 0.25 |
| no tombstone at all | 0.25/0.25/0.30/0.20 | identical | identical |

That last row is the important one: **with no tombstone in the tab the conversion is the
identity**, so this changes no number the app produces today except the ones that are
wrong. It is a strict superset of current behaviour, not a re-derivation of it.

**It also closes a ledger carry item rather than adding to it.** `claimForDeath`'s doc
currently declares, at length, that its `taken` and `sharesAroundClaims`'s `held` are "NOT
the same set, and that is a known, open gap". Under D they become the same set — *every
unspent claim for this tab* — evaluated at two different moments. The gap closes by
construction, and roughly forty lines of comment explaining why two things disagree get
replaced by one line saying they do not.

---

## Part 4 — Recommendation

**Take D, with B, and the `dismissed`/`removed` half of A. One name for the three:
main owns the tombstone, and every layout message names its panes.**

Four changes, in dependency order.

**1. Main gets a tombstone record.** `shareWhenItDied` already carries `{tabId, share}` and
already has the right lifetime and the right two deleters. It needs a name that says what
it is and a reader that can answer "which panes of tab T are tombstones right now": the
claims recorded for T whose pane is not among the kids being written. That predicate is
`claimForDeath`'s `taken` predicate, unchanged, evaluated at rebuild instead of at death.
`SessionManager.tabWasIn` is the same concept's other half and should be cited from the new
doc comment even if it is not moved — two process-lifetime maps recording facts about the
same dead pane, dropped by the same handlers, is one concept whether or not it is one map.

**2. Both row builders emit in the live-remainder frame.** `carveRatio` and `tabRowFor`
hand `sharesAroundClaims` entries for the live kids **and** for that tab's tombstones,
producing a whole-tab vector; then they emit only the live kids' shares, each divided by
the total those shares hold. That total is `1 − reserved` by construction, since the whole
vector sums to 1 — one expression, and the comment says which of the two readings is the
reason and which is the check. Guarded on that total being positive, in the same style and
for the same honesty as `sharesAroundClaims`'s existing `room > 0` note: the guard is not
provably unreachable, and pretending otherwise is the kind of comment this project treats
as a defect.

**3. `setLayout` becomes `(tabId, shares: Record<paneId, number>)`.** Main routes each
entry: a saved kid's share into `layout.ratio` (converted by the same division, so a drag
and a split cannot disagree about the frame); a tombstone's share into the tombstone record,
which is what keeps `reserved` honest after a drag on a tombstone's divider; anything else
ignored, and that branch — and only that branch — is the one worth a log.

**4. The renderer stops leaving dead kids behind after a dismiss.** `dismissed` and
`removed` drop the pane's id from `layout.kids` and its share from `ratio`, in the same step
that drops the pane. Safe by ruling 4. `grabPane`'s three refusal guards **stay** — they
guard a real hazard (a box index taken for a kid index) and this change means they can no
longer fire in ordinary use, which is the correct outcome for a guard.

### Where this comes near "What must not regress"

- **`withKeptPanes` keeps tombstones in their row at their share** — this is the ruling the
  whole recommendation is built around rather than against. Direction A for `died` is the
  one that violates it, and is rejected for that reason.
- **Row ids are never rewritten** — untouched. Nothing here renames a row or re-keys a
  group; ruling 4's safety argument turns on the row *keeping* its id while its founder's
  stray disappears.
- **Every terminal stays mounted; `visibility`, never `display`** — untouched by all four
  directions except A-for-`died`, which unmounts live terminals through the id collision.
- **`serialise` has no reentrancy protection** — `setLayout` stays exactly one pass. Writing
  a tombstone record is an in-memory map write, not a config write, so it adds no new path
  back into the queue.
- **The sum by construction, not a rescale** — ruling 5. This is the item the recommendation
  is closest to, and the reason the conversion must be written as a projection with its
  reason stated rather than as `x / sum(x)` with no comment.
- **No attach, split or drag drives a window to 80×24 or a pane to 2×1** — the conversion
  divides by a number in `(0, 1]`, so main's emitted shares get *larger*, never smaller, and
  the renderer scales them back to where they belong. On relaunch, restore prunes the
  tombstones and reads the row directly: the survivors' relative proportions are preserved
  and the tombstone's space is redistributed proportionally, which is `closePane`'s standing
  "close is already right" ruling. No new path to a zero-width box.
- **A comment asserting a mechanism that is not true is a defect** — see the list of
  comments this falsifies, below. They are part of the work, not tidying after it.

### Comments that become false and must be rewritten

Named now so no one has to find them later. Each currently asserts something true of
today's code and false of the fixed code:

- `register.ts`'s `claimForDeath` — the "`taken` and `held` are NOT the same set" section
  becomes false; they become the same set.
- `restore.ts`'s `sharesAroundClaims` — the traced-case paragraph describing C ending at
  0.24 becomes a description of a fixed defect, not of behaviour.
- `register.ts`'s `CHANNELS.setLayout` — the "the common case is structural" paragraph
  describes a guard that no longer exists in that form.
- `tests/unit/dividers.test.ts`'s header bullet "that main actually persists what this
  handler sends", which currently declares the CT-1 gap as permanent uncovered ground.
- `carveRatio`'s "dilutes every known share evenly" paragraphs remain true for an
  *unremembered* sibling and must not be deleted along with the rest.

### What would change my mind

- **If Paolo rules that main must never model a pane it does not have.** That is a coherent
  position — "main owns existence, and a tombstone is not existence" is this codebase's
  standing shape, and `restore.ts` is built on it. The alternative it forces is the mirror:
  main sends its row *plus* an explicit "these panes are owed this much" side-channel, and
  the renderer does the conversion. I would argue against it — it puts a second authority on
  numbers main computed, which is the thing ruling 3 of plan 2c rejected for the dead pane's
  share in the first place — but it is his call and it is in Open Questions.
- **If the `withKeptPanes` even-split fallback turns out to be reachable in practice.** It
  resizes every tombstone, by its own admission, which would make the renderer's tombstone
  shares disagree with main's records with no drag to re-synchronise them. I did not find a
  reachable path to it (`room > 0` needs a tombstone holding the entire tab), but I did not
  prove there is none, and if there is one then the tombstone shares need a commit path that
  is not the drag.
- **If measurement shows a fifth ordering the conversion gets wrong.** I ran three plus a
  control. The property to check before implementing is stronger than three cases: *for any
  set of deaths and restarts, main's row composed through `withKeptPanes` reproduces the
  whole-tab vector.* If that property fails for some input, the frame analysis is wrong and
  not merely incomplete.

---

## Part 5 — What is testable, and what is not

**The blind spot CT-2 lives in can be closed by a pure test today, and I proved it by
writing one.** No test anywhere composes `withKeptPanes` with `sharesAroundClaims`:
`carveRatio.test.ts` and `shares.test.ts` call the main side with hand-written inputs;
`workspace.test.ts` drives the reducer with hand-written `TabShape` fixtures; the two never
meet. I confirmed it mechanically — no unit file imports both `workspaceReducer` and any of
`carveRatio`/`sharesAroundClaims`/`tabRowFor`.

It needs no DOM and no ptys, and — this is the part worth knowing before anyone proposes an
export — **it does not require `withKeptPanes` to be exported.** Driving `workspaceReducer`
with a `{ type: 'split', shape }` action reaches it, which is how `workspace.test.ts`
already exercises the tombstone rules. Every measured number in Part 1 came out of exactly
that composition, running in `environment: 'node'` in under a fifth of a second.

That is the strongest argument for this shape: the recommendation's central claim — *main's
row, composed through the renderer's merge, reproduces the whole-tab vector* — is a pure
function of pure functions, and can be asserted as a property over death/restart orderings
rather than as three examples. The three orderings in Part 1 are the seed cases; the
control (no tombstone → identity) is what stops the property from being trivially satisfied
by an implementation that ignores its inputs.

**Also newly testable under the recommendation:**

- `setLayout`'s routing, through the mocked `ipcMain` `persistence.test.ts` already uses:
  a shares record naming a live kid and a tombstone must update `layout.ratio` and the
  tombstone record respectively, and must leave `config.panes` alone.
- The dismiss fix, in the reducer, with no DOM: kids and boxes stay 1:1 across a dismiss.
- `held.tabId === row.id` — the ledger's carry item, currently vacuously true everywhere
  because no test has two tabs with unspent claims at once. Under the recommendation the
  per-tab tombstone set is load-bearing in a second place, so this must be pinned, and it
  can be: two tabs, two claims, zero ptys.

**Still not testable, and it must be declared rather than implied:**

- That main's tombstone set and the renderer's `state.dead` actually agree at runtime. That
  is a cross-process fact, and the unit suite cannot see it. What *can* be pinned is each
  side's own rule, plus the round trip through the mocked `ipcMain`.
- The gesture itself — hit area, cursor, listener attach and teardown — unchanged from plan
  2c, and unchanged by this work.
- `grabPane`'s refusal guards and the floor derivation. Which brings in the deferred item
  below, because this design is the first thing that has a reason to touch them.

---

## Part 6 — Deferred items from the 2c ledger, folded in

Taken, because they are adjacent to the code this design touches and because leaving them
is how the next review re-finds them:

- **Extract `grabPane`'s pair resolution and the floor derivation into `workspace.ts`**
  (ledger: "Task 4: CANDIDATE FOR A LATER PLAN"). CT-1's inert-dividers half **is** a bug in
  that guard, and `dividers.test.ts`'s header measured three separate ways it cannot see it:
  deleting all three guards passes, swapping `minRatioFor`'s arguments passes, turning the
  `/` in `axisCells = grid.cols / low.share` into a `*` passes. This is the plan that has a
  reason to close it.
- **A shared `shares.ts`** (ledger: "Task 8 minor"). `sharesAroundClaims` sits in
  `restore.ts` for import-cycle reasons and is the main-side twin of `withKeptPanes`. The
  frame conversion belongs beside it, and the composition test's imports should not have to
  reach into `restore.ts` to find layout arithmetic.
- **The `remembered → claim` lookup written twice** (ledger: "Task 8 minor"), in
  `register.ts` and `restore.ts`, differing genuinely only in the even fallback. Both need
  the same conversion now, which makes a third divergence available.
- **`held.tabId === row.id` is pinned by no test** (ledger: "Task 8 CARRY, must not be
  dropped silently"). See Part 5.
- **`forgetTab`'s inline induction proof is incomplete** — `share` can be exactly 1 for the
  sole survivor of its row, so the strict inequality fails at that step (ledger: "Task 8
  minor"). The conclusion holds; the one-line proof does not establish it. Restate while the
  surrounding comment is being rewritten anyway.
- **`workspace.test.ts:92-95`'s `resized` fixture has one row**, so "replaces the tab's
  ratios and nothing else" cannot see other rows (ledger: "Task 3 minor", flagged for
  triage because a regression there wipes every other tab's layout on any drag). Two lines.

Named but **not** taken, with the reason:

- `data-testid="pane-divider"` is not unique per divider. Only worth it if a test needs to
  address a specific seam; the E2E plan's Task 8 might, so it belongs there rather than here.
- `PaneDivider` measuring through `ref.current.parentElement` rather than a `containerRef`
  prop. Real, unrelated to either defect, and the `inset-2` test pins the coupling today.
- A second concurrent pointer feeding one divider's delta into another's context.
  Unreachable with one mouse.
- The floor being conservative by 1–2%. Harmless direction, and the extraction above is what
  would make it measurable.
- `restore.ts`'s silent `catch { continue }`. Still ~250 lines from anything this touches;
  it was explicitly conditional on landing next to it. Remains open.

---

## Part 7 — Done when

- A drag on a tab holding a tombstone, or a restarted-but-unclaimed pane, is on disk after
  mouse-up and comes back on relaunch. The spec's existing "Done when" bullet becomes true
  for the first time.
- Dismissing a dead pane in a tab of three or more leaves every divider in that tab
  grabbable.
- In all three death/restart orderings above, a pane nobody touched keeps the width it had,
  and a restarted pane comes back at the width it died at — measured against the numbers in
  Part 1's table, not against `sum ≈ 1`.
- With no tombstone in a tab, every number the app produces is unchanged. Asserted, not
  assumed: this is what makes the change a superset rather than a rewrite.
- A pure test composes main's row builder with the renderer's merge, over orderings, with no
  DOM and no ptys.
- Every comment in the list above says something true of the new code.
- Unit, typecheck and `check-deps` green; integration green **once ptys are available** —
  see the constraint below.
- A/B every load-bearing assertion by breaking the production code it guards. This project
  has found fifteen dead tests, two of them in plan 2c's own final wave and one of them the
  controller's.

## What must not regress

Unchanged from the 2c spec, repeated because this design touches four of them:

- Every terminal stays mounted; a hidden tab uses `visibility`, never `display`.
- Both `fitToContainer` guards stay, above the fit.
- `withKeptPanes` keeps tombstones in their row at their share.
- Row ids are never rewritten — `TabRow.id` is the founder's, permanent, and the renderer's
  React key.
- `serialise` has no reentrancy protection; nothing reached from inside it may call back
  into it.
- Tests use `-L prcli-test` only; a bare `kill-server` is forbidden.
- A comment asserting a mechanism that is not true is a defect here.
- No attach, split or drag drives a window to 80×24 or a pane to 2×1.

## Out of scope

- The `⊞n` badge and the tab-bar selection model. Still its own plan.
- E2E coverage of any of this. `2026-08-02-prcli-e2e-revival.md` already carries the drag
  and the tombstone, and already asks in its own Open Questions whether the `setLayout`
  guard should be fixed in a plan of its own. **This is that plan.** The two should be
  sequenced, not merged: E2E Task 8 is the only mechanism in the repo that could watch this
  fix work in a real window, and it is worth more pointed at a fixed guard than at a broken
  one.
- Persisting a tombstone's share across a relaunch. Restore prunes dead panes at launch, so
  there would be no pane to apply it to — unchanged, and still right.
- Two-dimensional drag, arbitrary nesting, detach-a-pane-to-its-own-tab.

## Constraints carried into implementation

- **The pty budget.** 422 of 511 allocated, not recovering without a reboot.
  `persistence.test.ts` failed three times on the night of 2026-08-01 with the failure count
  exactly equal to the resource-error count — the environmental signature, confirmed by one
  failure being a test that cannot be broken by any change on that branch. Count resource
  errors, inside assertion text as well as in error lines, before believing any integration
  failure is a defect. The last clean whole-suite evidence is 763 green at `4a09847`.
- **Manual verification is still owed** from plan 2c and is not discharged by this design:
  the drag has never been watched in a real window. A dev build (PID 27959) and a packaged
  build (PID 23272) are both live against the real `~/.prcli` and the real default tmux
  socket. **The drag already exists in the running dev window**, so it can be watched
  without relaunching anything.

---

## Open questions — for Paolo

None of these is an agent's to settle.

1. **Does main get a tombstone concept?** This is the crux. Main currently cannot represent
   "dead but still on screen", which is exactly the state the renderer is in, and it already
   holds both halves of that record in two maps in two files. My recommendation says yes.
   Saying no is coherent and forces the mirror design — main publishes what a pane is owed
   and the renderer converts — which I would argue against, because it makes the renderer a
   second authority over a number main computed, and ruling 3 of plan 2c rejected exactly
   that for the dead pane's share.
2. **Does `setLayout` change shape to `Record<paneId, number>`?** It is a small, contained
   migration with no compatibility surface (no remote, no other client, config format
   untouched). What it costs is the length guard's stated reason for existing; what it buys
   is that the four-file superset invariant stops being load-bearing, and that main can keep
   a tombstone's share current after a drag on the tombstone's own divider. If the answer is
   no, CT-2's fix is still possible but drifts every time a user drags a tombstone's edge.
3. **When main and the renderer disagree about a tombstone's share, who wins?** My
   recommendation says the renderer, at the one moment a drag commits, and main at every
   other moment. The alternative — main always wins, and the renderer's `withKeptPanes`
   takes main's remembered share instead of its own prior row's — is arguably cleaner and
   changes what `withKeptPanes` reads. It also puts main's map on the render path, which is
   why I did not choose it.
4. **Should a refused grab be visible?** The 2c ledger deferred this as UX ("`grabPane`
   silently refuses a mismatched row, leaving a divider on screen that does nothing with no
   explanation"). After ruling 4 the guard should not fire in ordinary use, so this becomes
   a question about diagnosing the extraordinary case: nothing, a dev-only log, or not
   drawing the divider at all. Not drawing it is the honest answer and the most invasive.
5. **One plan or two?** The four changes are separable — the dismiss fix is two lines and
   fixes half of CT-1 on its own — but they share every comment they falsify, and splitting
   them means writing the same rewrite twice. My judgement is one plan, roughly eight tasks,
   with the dismiss fix first because it is the one that is worth landing even if everything
   after it is reconsidered.
6. **Does the whole-tab composition property get pinned as a property test or as the four
   measured cases?** A property test over generated orderings would be the first in this
   repo and would need a decision about whether that is a shape this project wants. Four
   named cases with A/Bs is the house idiom and is what I would default to.
