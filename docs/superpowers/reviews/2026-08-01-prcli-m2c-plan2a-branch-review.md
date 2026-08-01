# M2c Plan 2a — whole-branch review

**Branch:** `m2c-plan2a-persistence` at `d51c455` (11 commits from `81cd203`)
**Reviewer:** whole-branch, one pass, no per-task reviews preceded it
**Date:** 2026-08-01

## What I ran

- `npm test` — **580 passed / 580, 29 files, 38.59 s**. One clean run, complete capture.
- `npm run typecheck` — clean. `npm run check-deps` — clean.
- Four throwaway probe files under `tests/integration/`, run against real tmux on
  `-L prcli-test`, then **deleted**. `git status` is clean and both tmux sockets
  are empty (`no server running` on `prcli-test` and on the default socket).
  Every "verified by running" claim below cites one of those probes; the probe
  source is reproduced inline where it matters.

## Headline

The branch does what it set out to do: a split tab comes back from disk as a
split tab, with its axis, its ratios and its selected pane. I confirmed that
independently of the branch's own tests (probe D below restores a real split
twice). Config v5 is careful work — `normaliseLayout`'s all-or-nothing share
check, the v6 refusal, and `forgetTab` being pointed at `config.panes` with the
reason written on it are all correct, and the store tests are the strongest set
on the branch.

What the cross-task view shows is that **Task 5 (attach sizes the window) and
Task 7 (restore) were each right on their own and wrong together**, and that
**Task 7 taught `restore.ts` about a tmux state — a member that fell back onto a
sibling's window — that no other caller in `manager.ts` knows about**, while
Task 5 gave that state a new way to do damage.

Counts: **0 Critical, 5 Important, 9 Minor.**

---

# Important

## I1. Restore drives every restored pane's window to 80×24 — the geometry defect this project has shipped twice, in its third disguise

**Files:** `src/main/ipc/restore.ts:284-293`, `src/main/sessions/manager.ts:203-223`
**Tasks:** 5 × 7
**Verified by running.**

`restoreWorkspace` reattaches each pane with

```ts
manager.open({ id, projectSlug, cwd, command, tmuxSession, type })
```

and no `cols`/`rows`, so `open()` falls to `DEFAULT_COLS`/`DEFAULT_ROWS`
(`manager.ts:64-65`). Before this branch that only sized the *client*, and a
split pane's window — which `splitTab` had put on `window-size manual` — kept
its real size. Task 5 made every `attach` issue a `resize-window` against the
window id, so restore now actively drives each window down to 80×24.

Measured (probe B, real tmux 3.7b, `-L prcli-test`): a tab opened at 120×40 and
split at 100×30, detached, then reconciled by `restoreWorkspace` against a v5
file.

```
before relaunch                      : ["120x40","100x30"]
restore with sizeWindowOnAttach stubbed out : ["120x40","100x30"]   <- what 2a inherited
restore as shipped                   : ["80x24","80x24"]            <- what 2a produces
```

The A/B is the whole finding: neutralising *only* Task 5's call site restores
the correct geometry, so this is Task 5's resize landing on a caller that has no
size to give it.

**Failure it produces.** Relaunch with a split tab open. Both panes' tmux windows
are re-wrapped at 80 columns before the renderer's first fit, which reflows the
scrollback of a `claude` session permanently — the exact harm `Entry.cols`'s own
doc comment (`manager.ts:38-44`) and `register.ts:114-121` were both written to
prevent. In the current 2a renderer a restored split shows as two tab-bar
entries and only the *visible* one is ever fitted, so the hidden pane simply
stays at 80×24 until it is selected.

**The branch's own test locks this in.** `tests/integration/restore.test.ts:575-579`:

```ts
// Each pane's own window, sized to the client restore attached to it —
// 120x40 and 100x30 before the relaunch, so a window nothing re-sized
// reads back its old geometry rather than the reattached client's.
await expect.poll(() => windowSize(founder.tmuxSession), …).toBe('80x24')
await expect.poll(() => windowSize(second.tmuxSession), …).toBe('80x24')
```

The comment is honest about the mechanism, and the assertion does fail without
Task 5 — but it certifies 80×24 as the intended outcome. The plan's Task 7 Step 1
asked for "each pane's window at its saved size"; **no size is saved anywhere**
— `PaneRecord` has no `cols`/`rows` and neither does `TabRow` — so that step was
unimplementable as written and was closed against the default instead of being
raised.

The spec's Done-when list says: *"Relaunch restores splits with their
orientation and ratios, and reattaches every pane at the renderer's size — no
pane wrapped at 80 columns."* Orientation and ratios: delivered. The second half:
regressed by this branch.

**Suggested fix (candidate, not a mandate).** Cheapest correct thing for 2a:
have `sizeWindowOnAttach` skip the resize when the caller gave no explicit size
— i.e. thread `input.cols === undefined && input.rows === undefined` through
`attach` as "leave this window alone", so a defaulted attach cannot shrink a
window it knows nothing about. That keeps Task 5's guarantee for every caller
that *does* know a size (renderer opens, restart, `splitTab`, move of an
attached pane) and removes it for the one that does not. The durable fix is to
persist per-pane `cols`/`rows` in `PaneRecord` (or return the layout to the
renderer and let 2b fit before attach), but that is a config-shape change and
belongs to 2b.

## I2. Restore prunes a shadowing member but never kills it, leaving a live prcli session that is unreachable from the UI for good

**File:** `src/main/ipc/restore.ts:124-149` (`withoutSharedWindows`)
**Task:** 7
**Verified by running.**

When a member's own window has died it silently falls back onto a sibling's
(spec finding 2). Task 7 detects that — correctly, and the reasoning in the doc
comment is sound — and drops the shadowing pane from the tab. But the dropped
pane never reaches `ordered`, so it is never written to `panes`, and nothing
kills its session.

Measured (probe D): open, split, kill the second pane's window only, then
`restoreWorkspace` twice.

```
restored panes   : [ 'd47270782b6d967c' ]          # founder only
config panes now : [ 'd47270782b6d967c' ]          # sibling's row deleted
tmux ls after restore, and again after a SECOND restore:
  prcli-lumio-af8676cbe9a8e7d6: 1 windows (group prcli-lumio-d47270782b6d967c)
  prcli-lumio-d47270782b6d967c: 1 windows (group prcli-lumio-d47270782b6d967c)
```

`prcli-lumio-af8676…` is alive, in the group, has no config row, has no tab-bar
entry, and will be pruned identically on every future restore. It is
self-perpetuating: nothing in the app can ever see it or kill it again.

**Why this matters beyond tidiness.** The spec's Done-when says *"A crashed or
closed pane leaves no window and no member session behind; `tmux ls` shows what
it shows today."* This is a member session left behind. It is also the shape of
failure the branch's own architecture note names — a live session the app has
lost track of, unreachable from the UI. What Task 7 traded away is reachability:
before it, both members came back and the user saw the pane twice (wrong, but
recoverable); now the user sees it once and one session is orphaned forever.

**Suggested fix.** In `withoutSharedWindows`, when a pane is skipped for a
claimed window, `await manager.<something that calls adapter.killSession(pane.tmuxSession)>`
— the session has no window of its own, so killing it destroys nothing the
sibling needs. **Do not** route this through `SessionManager.kill()`: that
resolves a window id and would kill the sibling's window (see I3). A
`killShadowMember` on the manager that calls `adapter.killSession` and nothing
else is the safe shape. If killing is judged too aggressive, at minimum log it —
silence is what makes it permanent.

## I3. `lookupWindow` is trusted to name "this pane's window" everywhere outside restore; for a fallen-back member it names the sibling's

**Files:** `src/main/sessions/manager.ts:277-279` (`wireDeathHook`), `:245-251`
(`sizeWindowOnAttach`), `:690` and `:702` (`kill`)
**Tasks:** pre-existing for the hook; **new for geometry (Task 5)**
**Verified by running (hook and geometry); read-verified for `kill`.**

`restore.ts` is now the only place in the codebase that knows two members can
report one window. Every other path takes `display-message -t '=member:'
'#{window_id}'` to mean "the window this pane's process is in", which is false
for exactly the member restore was taught to detect.

**Consequence A — a move rewrites the sibling's death hook** (probe C). Split a
tab, kill the second pane's window (its member falls back onto `@0`), then
`manager.moveTabToProject(founder.id, 'gco')`:

```
founder window: @0
hook BEFORE move: pane-died[0] run-shell "PRCLI_TAB_ID=749a2253ec4a8079 …"
                  ; kill-session -t =prcli-lumio-749a2253ec4a8079 ; kill-window -t @0
hook AFTER  move: pane-died[0] run-shell "PRCLI_TAB_ID=a7f2c47b783372b5 …"
                  ; kill-session -t =prcli-gco-a7f2c47b783372b5   ; kill-window -t @0
```

`a7f2c47b…` is the *other* pane. The founder's window now carries a hook that,
when the founder's pane dies, reports the wrong tab id (wrong pane goes red,
right pane stays green) and reaps the wrong session — leaving the founder's own
member session behind as a stray, which is the failure class this project has
already shipped once. The reinstall call itself
(`manager.ts:836`, `wireDeathHook({ …pane, tmuxSession: to }, null)`) is
byte-identical to the one at `81cd203`, so this is **pre-existing**, not
introduced by Task 4 — but Task 4 touched this exact line and Task 7 established,
in the same branch, that the state is real and detectable.

**Consequence B — an attach resizes the sibling's window. This one is new**
(probe C2). With the same fallen-back member, reattaching it at 60×20 (which is
what `moveTabToProject`'s reattach loop does, and what `restartTab` does):

```
founder window 120x40 -> 60x20 after the fallen-back sibling reattached at 60x20
```

Before Task 5 there was no attach-time `resize-window` at all, so this could not
happen. Now one pane's reattach silently reshapes its sibling's pane.

**Consequence C — read-verified, not run.** `kill()` at `:690` uses
`entry.windowId ?? await windowIdOf(...)`, and Task 5 now populates
`entry.windowId` on *every* attach from the same `lookupWindow`. So killing a
fallen-back pane kills the sibling's window and the process inside it.

**Suggested fix.** Give `SessionManager` the check `restore.ts` already has —
one helper that answers "is this member the sole claimant of the window it
reports?", built from `panesOfTab` — and consult it in `wireDeathHook` and
`sizeWindowOnAttach` before writing to a window id, and in `kill()` before
reaping one. Cheaper interim: have `wireDeathHook` refuse to install when the
window it resolved already carries a `pane-died` hook naming a *different* tab
id, which is a single `show-hooks -w` read and turns the clobber into a no-op.

## I4. `restartTab` still recreates a pane outside its tmux group — the hazard Task 4 carried forward and only Task 7 closed

**File:** `src/main/ipc/register.ts:460-487`
**Tasks:** 4 (flagged) → 7 (closed for restore only) → 8 (not revisited)
**Read-verified.**

The ledger records this as Task 4's carry-forward: `manager.open()` creates with
`new-session -A` and no `-t <group>`, so recreating a pane whose session has
died puts it *outside* the tab's tmux group and silently un-splits the tab.
Task 7 answered it structurally and well — restore's existence comes from
`findOrphanTabs`, so `ordered` only ever holds panes tmux already has, and
`open()` can never create one.

`CHANNELS.restartTab` is the other caller of `manager.open()` on a pane whose
session is gone, and nothing was done to it. Restarting one pane of a split tab
will create a brand-new ungrouped session under the pane's id; `findOrphanTabs`
will then report it as its own one-pane tab and the split is gone.

Not reachable today — no IPC splits a tab in 2a — so this is a latent 2b
defect. It is called out here because the ledger routed it to this review and
because the closing argument for Task 7 ("existence comes from `findOrphanTabs`")
does not extend to this handler.

**Suggested fix.** Either make `restartTab` refuse when the pane belongs to a
group with other live members (and let 2b's close-pane handle it), or give
`SessionManager` a `reopenInGroup` that resolves the group with `groupNameOf`/
`panesOfTab` and goes through `newGroupMember` + `newWindow` rather than
`new-session -A`. Whichever, it should be a named entry in plan 2b, not an
assumption.

## I5. The layout config now stores never reaches the renderer

**Files:** `src/main/ipc/restore.ts:362`, `src/shared/ipc.ts:218-222`
**Task:** 7
**Read-verified.**

`restoreWorkspace` computes `tabRows` and writes them to disk, then returns
`{ projects, tabs, activeProjectId }` where `tabs` is `TabDescriptor[]` — the
*panes*. `RestoreResult` is unchanged, so `dir`, `ratio`, `kids` and
`activePaneId` are written and read on every launch and never leave the main
process. Nothing consumes them.

That is defensible as a 2a/2b split, and I am not calling it a defect on its
own. It is here because it changes how I read I1: the branch's stated goal, "a
split tab reopens as a split tab after a relaunch, with each pane at the right
size", is currently true only of the *file*, not of anything a user sees. If
plan 2b is not next in the queue, this branch ships a config field with no
reader, and a v4 build reading it will drop it (which `write()`'s refusal
correctly guards against, and the new test at `store.test.ts` covers).

Also worth noting for 2b's brief: `RestoreResult.tabs` now means panes,
`WorkspaceState.tabs` means panes, and `describeProjects(projects, tabs)` is
given panes. The vocabulary the spec warned about ("tab briefly means two
things") has drifted about as far as it can without a compile error. A rename of
`RestoreResult.tabs` → `panes` is a one-commit job and would stop 2b inheriting
the ambiguity.

---

# Minor

## M1. `oneTabPerPane`'s doc comment asserts a reuse that Task 7 declined

`src/main/state/store.ts:219-232`:

> *Exported because `restoreWorkspace` writes a workspace of one-pane tabs too;
> a second copy of this there would be one place for the two to drift.*

`grep -rn oneTabPerPane src/ tests/` returns exactly two hits: the definition and
one internal caller in `migrate`. Task 7 correctly overruled the instruction to
reuse it (a tab row must carry the group's frozen id, not a pane's), and the
deviation was accepted — but nobody went back to store.ts. This is the branch's
own "comment asserting a mechanism that is not true" class, and it is not a nit
by the branch's own rule. Fix: drop the `export` and the sentence, or, better,
say why restore deliberately does *not* use it — that is the more useful comment
and it stops the next implementer re-deriving Task 7's argument.

## M2. `moveTabToProject`'s "no worse than today" comment was made false by Task 5

`src/main/sessions/manager.ts:891-895`:

> *A detached pane has none, and no client to take a size from either, so the
> default is all there is — no worse than today, and the renderer refits it when
> it is next shown.*

True when it was written; false since Task 5. Moving a detached pane now sizes
its **window** to 80×24 as well as its client, which for a split pane's `manual`
window is a real change, not a default. Same root cause as I1, different call
site — worth fixing in the same edit, and worth the comment being corrected
either way.

## M3. The attach-time `awaitWindowId` poll is now unconditional, uncancellable, and can spawn ~370 tmux processes

`src/main/sessions/manager.ts:223, 239-251, 372-380`.

Before Task 5 the poll only ran when `options.deathReporter` was set. It now runs
on every `attach()`. In the happy path it costs 2 calls and ~25 ms (measured).
In the path where the session never appears it runs to the full 10 s deadline at
20 ms intervals: **measured 111 `tmux display-message` spawns in 3 s**, so ~370
per abandoned poll, and nothing cancels it — `detach()` does not, and it outlives
the test or the tab that started it. A dead tmux server answers `no server
running`, which `lookupWindow` maps to `gone`, which is the answer
`awaitWindowId` *keeps polling on*.

The plan deferred cancellation with the reasoning "the poll is not a live defect
— it ends after 10 s and its result is swallowed". That reasoning was written
when the poll was reporter-gated. Task 5 changed its premise and the deferral was
not revisited. Combined with the ledger's own deferred Task 5 item (two
concurrent polls when a reporter *is* set), that is up to ~740 subprocesses for
one bad attach.

Fix: share one lookup between `wireDeathHook` and `sizeWindowOnAttach`, and give
`awaitWindowId` an abort signal that `detach()`/`kill()` trip. Neither is
required for correctness today.

## M4. `sizeWindowOnAttach`'s staleness re-check is against the wrong object

`manager.ts:239-251` sets `entry.windowId` and calls `resizeWindow(entry, …)`,
whose guard is `if (entry.cols !== cols || entry.rows !== rows) return`. That
guard is against the entry captured at attach time. If the pane has since been
detached and reopened (which `moveTabToProject` does, and which
`manager.test.ts`'s new "sizes the window to the client on every attach" test
does deliberately), the *old* entry's `cols`/`rows` are unchanged, the guard
passes, and the resize lands with the old size after the new attach has already
set a different one. This is the "last writer wins by accident" the guard's own
comment says it prevents, reached through entry identity rather than through
time. Narrow window (the poll normally resolves in ~25 ms) so I did not provoke
it. Fix: check `this.entries.get(entry.record.id) === entry` before resizing —
the same identity check `session.onExit` already uses at `:173`.

## M5. `moveTabToProject` awaits `wireDeathHook` inside the rename loop, so a `gone` answer stalls a half-renamed tab for 10 s

`manager.ts:836`. The reinstall is `await`ed, and `wireDeathHook` with
`windowId: null` goes through `awaitWindowId`, which polls for the full 10 s on
`gone`. A pane that dies in the window between its rename landing and the lookup
answering therefore blocks the loop — and the whole `serialise` queue, since the
IPC handler holds it — for ten seconds, with the tab genuinely split across two
projects for the duration. Unlikely (the rename just succeeded, so the session
exists) but the cost is disproportionate. Fix: pass the window id when it is
already known, or bound this particular lookup to a single `lookupWindow` call
rather than the polling wrapper — there is nothing to wait *for* here, the
session already exists.

## M6. A move loses a detached pane's `type`

`manager.ts:1059-1065` (`panesOfTab` synthesises `type: 'shell'` for a pane with
no open entry) → `:897-907` (`known` overrides only `cwd`/`command`) →
`register.ts:419-424` (the record is written over the config row). So moving a
**detached** `claude` or `preset` pane saves it back as `shell`, and the next
restore opens it as a shell. Pre-existing — `moveToProject` had the same hole —
but Task 8 widened the blast radius from one row to every pane of the tab, and
`restore.ts:276` shows the correct pattern (it explicitly restores
`type: row.type` from the saved row). Uncovered: the persistence test for a
detached move asserts `cwd` only. Fix: widen `known` to
`Pick<PaneRecord, 'cwd' | 'command' | 'type'>`.

## M7. A test name that no longer says what the test asserts

`tests/unit/store.test.ts:269`: `it('reads a v2 file as v4, keeping tab order')`
now asserts `config.version === 5`. Two others in the same file were renamed to
"…to v5"; this one was missed. Same class as M1.

## M8. Two vacuous or unreachable assertions in the new tests

Neither is a test that cannot fail — both do fail under their intended mutation —
but both are weaker than they read.

- `tests/integration/restore.test.ts:768-772`: the duplicate-window invariant is
  asserted after `expect(result.tabs).toHaveLength(1)`. With one pane,
  `new Set(windows).size === windows.length` is true by construction, and if the
  prune regressed the `toHaveLength(1)` above aborts the test first. The comment
  says it is "stated as the invariant rather than as a count, because it is the
  invariant that matters" — in this test it is the count that is doing the work.
- `tests/unit/deathHook.test.ts:53-69` (the deferred Task 2 item): the loop is
  over a four-element **literal**, so it cannot silently empty. Real, just not
  the idiom the rest of the file uses (`it.each`).

## M9. `tabRows` does not stop two tab rows claiming the same pane

`src/main/state/store.ts:195-217`. `normaliseLayout` dedupes kids *within* one
row (`kids.includes(kid)`), but nothing dedupes *across* rows, so a hand-edited
or half-written file can have pane A in two tabs. Harmless today because restore
rebuilds tab membership from live tmux on every launch and never consults
`saved.tabs` for existence — which is the invariant working exactly as intended.
Worth one line in `tabRows` when 2b starts writing tab rows from the renderer.

---

# Things I checked and found sound

Said briefly, so the report is not read as uniformly negative.

- **The group-name rule holds.** `grep` for `decodeSessionName|tabIdFromGroupName`
  across `src/` returns nine sites; every one either decodes a *member's own*
  name or takes only the id half via `tabIdFromGroupName`. No slug is read out of
  a group name anywhere. This was the single likeliest defect the milestone could
  introduce and the branch did not introduce it.
- **Target syntax is right in all eleven adapter methods.** Session targets
  (`has-session`, `kill-session`, `rename-session`) take `=name` with no colon;
  window/pane-scoped calls (`display-message`, `set-option -w`, `new-window`,
  `select-window`) take `=name:` or a bare `@n`. `selectWindow` correctly uses
  `=name:index` rather than the bare `@id` the spec measured as binding nothing.
- **`remain-on-exit` and the hook stay coupled.** `wireDeathHook`'s three early
  returns are each individually justified and each one either takes the option
  back off or has no window to take it off. `PtySession.start()` gates the
  chained `set-option` on `canBuildDeathHook`, which Task 2 tightened to
  `isPrcliSession` without touching the reporter's separate charset — the right
  call, and the comment explaining why the two guards differ is accurate.
- **`ConfigStore` v5 is the strongest part of the branch.** `read()` never throws
  on any of the hostile shapes tested; `write()`'s newer-version refusal is
  intact and now covers the v5→v4 case that matters most; the v1–v4 collapse into
  one migration branch is justified by measurement, not by tidiness; the v6 test
  is the right test to have added.
- **`serialise` reentrancy.** I traced every new call path into `restoreWorkspace`
  and the move handler. Nothing inside the queue calls back into it. The
  `setActive` handler still reads `store` directly with the reason on it.
- **Task 4's invariant test is real.** The spy reads every already-installed hook
  back from tmux before each rename and checks the session it names still exists;
  under the "reinstall after the loop" mutation it fires on the second rename.
  That is a state read-back, not an exit code, and it is the right shape.
- **Task 3's `kill()` asserts on the process pid, not the window count.** Correct
  instinct, and `panePid` was measured to name `sleep` directly.

---

# Verdicts on the seven items the ledger deferred

| # | Item | Verdict |
| --- | --- | --- |
| 1 | Task 2: new test loops a four-element array **literal** with no non-empty assertion | **Can stand.** A literal cannot silently empty; every `expect` inside runs. See M8 for the style note. |
| 2 | Task 5: `wireDeathHook` and `sizeWindowOnAttach` each run their own `awaitWindowId` on the `open()` path | **Can stand for merge, but fix with I1.** The duplication is not the problem; the poll being unconditional and uncancellable is (M3), and both are one edit. |
| 3 | Task 7: which member owns a shared window is not recoverable; prunes founder-first | **Can stand.** The measurement is symmetric in both directions, the reasoning for not reading the window's hook is correct, and founder-first is the direction pre-flight measured. What must *not* stand is what happens to the pruned member — I2. |
| 4 | Task 7/6: nothing outside restore writes a tab row, so a live split reaches disk with an even share | **Can stand — 2b's, correctly.** No UI path can split a tab in 2a, so no ratio exists to lose. Needs an explicit line in plan 2b. |
| 5 | Task 8: `SessionManager.moveToProject` has no production caller | **Can stand.** It is a four-line wrapper with a corrected doc and two real test callers; deleting it would mean rewriting two geometry regressions for no gain. Revisit if 2b adds a third caller-less method. |
| 6 | Task 8: the new test seeds the sibling's config row by hand | **Can stand.** The assumption (2b's split handler will `rememberTab` each pane) is the only sane design, and the test asserts against live tmux as well as against config. Must be a named line in plan 2b's split task, not an inherited assumption. |
| 7 | Suite: one gate run went 579/580 with the failing test's name lost | **Not a blocker; do not write it off.** See below. |

## On the suite flake

`npm test` here: **580/580 in 38.59 s**, one run, complete capture, both sockets
empty afterwards. I could not reproduce a failure and I have no evidence for a
specific intermittent test in the changed code.

What I *can* say is that this branch added a new, measurable load source that did
not exist when the earlier flake pattern was characterised, and it is of exactly
the shape the pattern describes (always a timeout, never the same test). Task 5
made `awaitWindowId` run on **every** `attach()` rather than only on managers
with a `deathReporter`, it is uncancellable, and a poll whose session never
appears spawns **111 `tmux` processes in 3 seconds** for a full 10 seconds
(M3) — bleeding into whichever test file runs next, since `fileParallelism` is
off and `afterEach(killServer)` makes `lookupWindow` answer `gone` forever rather
than ending the poll. Every integration file builds managers without a reporter,
so every one of them now polls where it previously did not.

That is a mechanism, not a diagnosis. I would not hold the merge for it, but I
would fix M3 before adding 2b's E2E surface to this suite, and I would re-run the
gate with full capture rather than `tail` until a 579/580 recurs with a name
attached. The two tests the ledger already fingered under load —
`manager.test.ts > findOrphans > ignores sessions already open` and
`persistence.test.ts > durable tab record > reattaches a detached tab` — remain
the ones to look at first.

---

# Verdict on the accepted deviations

- **Task 1's 4th test** — right, and necessary. The three prescribed tests reach
  `lookupWindow`'s `unreachable` return only through `TmuxNotInstalledError`,
  which throws out of `exec` before the mapping runs; the added stub test is the
  only one that exercises the branch the task exists for. Keep.
- **Task 6 changing two Task 8 sites, name-only** — right. They were hard `tsc`
  errors, the change was mechanical, and Task 8's real work (singular →
  plural, the `known` map, the write-back) was left intact and done.
- **Task 6 collapsing v1–v4 into one branch** — right, and better than the
  brief. Verified: v1/v2 files carry no `projects`/`notifications` key, so
  reading for them is identical to defaulting, and the tests cover v1, v2, v3 and
  v4 through the collapsed path separately.
- **Task 7 declining `oneTabPerPane`** — right, for the reason given: a tab row
  must carry the group's frozen id, and a group outlives its founder. Byte-
  identical for one pane, wrong for the case the milestone is about. The only
  residue is the stale comment left on the helper (M1).
- **Task 8 replacing `tab` with `panes: TabDescriptor[]`** — right. `tab` *is*
  the one-tab-one-pane assumption the milestone deletes, the renderer cost was
  one `Map` lookup, and the reducer test added for it (`re-slugs every pane the
  reply names`) is a real test with three panes and a deliberate non-mover.

---

# What I would fix before merge

1. **I1** — restore must not shrink a window it has no size for. One edit,
   plus correcting the test's assertion and M2's comment.
2. **I2** — kill (or at minimum log) the shadowing member restore prunes.
3. **I3** — at least the geometry half, which this branch introduced; the hook
   half is pre-existing and could go to 2b with a named entry.
4. **M1, M2, M7** — the three false comments/names, per the branch's own rule
   that these are defects rather than nits.

**I4, I5, M3–M6, M8, M9** I would carry into plan 2b as named entries rather
than hold this branch for.
