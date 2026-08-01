# M2c Plan 2a — scoped re-review of the fix wave

**Branch:** `m2c-plan2a-persistence` at `eeca830` (6 commits from `d51c455`)
**Scope:** `review-d51c455..eeca830.diff` only. I4 and I5 are deferred to 2b and
were not reopened.
**Answers:** `docs/superpowers/reviews/2026-08-01-prcli-m2c-plan2a-branch-review.md`
**Date:** 2026-08-01

## What I ran

- `npm test` — **595 passed / 595, 29 files, 42.40 s**. One run, full capture.
- `npm run typecheck` — clean. `npm run check-deps` — clean (9/9).
- **Seven A/B sabotage runs**, one per claimed fix, each reverting the fix in
  `src/` and running the test that is supposed to catch it. Results inline below.
- **Four real-tmux probes** on `-L prcli-test`, as throwaway test files under
  `tests/integration/`, since deleted. `git status` shows only the untracked
  branch-review report. Both sockets answer `no server running` — the default
  socket was never touched and no bare `kill-server` ran anywhere.

---

# 1. Verdict per finding

| # | Verdict | How I know |
| --- | --- | --- |
| **I1** | **ADDRESSED** (code) / **test does not hold it** — see N3 | A/B: `sized = true` → both windows go to `80x24`. The gate is load-bearing. But the shipped assertion passes with the defect in place. |
| **I2** | **ADDRESSED** | A/B: remove `killShadowMember(pane.tmuxSession)` → `expected true to be false`. |
| **I3** | **ADDRESSED** | A/B: `ownsWindow` → `return true` fails all three new tests: `'60x20' to be '120x40'`, `expected false to be true` (founder's session gone), hook naming the wrong tab id. |
| **M1** | **ADDRESSED** | `export` dropped, comment replaced with why restore does *not* reuse it. `typecheck` clean; sole caller is `migrate`. |
| **M2** | **ADDRESSED** | Comment now states the absent size as deliberate and names I1. True as of the I1 gate. |
| **M3** | **ADDRESSED** (both halves) | A/B: drop `if (entry?.abandoned) return lookup` → `expected 35 to be 24`. Un-memoise `pending` → `expected 2 to be 1`. |
| **M4** | **ADDRESSED**, and the "no test" excuse does not hold — see §M4 below | Guard present in `resizeWindow`, identity comparison matches `session.onExit`. |
| **M5** | **ADDRESSED** | `wireDeathHook` now takes `() => this.adapter.lookupWindow(to)` in both the forward loop and the rollback; the polling wrapper is out of the rename loop. Task 4's per-iteration reinstall is intact. Read-verified. |
| **M6** | **ADDRESSED** | A/B: `const type = pane.type` → `expected 'shell' to be 'claude'`. |
| **M7** | **ADDRESSED** | Name says v5; the test asserts `version === 5`. |
| **M8** | **ADDRESSED** | Vacuous set-size check removed from the one-pane test and replaced with two assertions that do fail (one is I2's RED). `deathHook.test.ts` loops are `it.each`. |
| **M9** | **ADDRESSED** | A/B: drop `known.delete(kid)` → both new store tests fail. |

## M4 — the missing test

The guard is right and in the better place (`resizeWindow`, so the renderer path
gets it too). But **"could not be provoked" is not correct**: the two tests
added for M3 in the same file already carry the tool. Spy on
`adapter.lookupWindow` with a delay, attach at 120×40, and while that lookup is
still pending, `detach` + re-`open` the same id at 60×20 with a size. Without
the identity guard the stale entry's `resizeWindow` lands last and the window
reads 120×40; with it, 60×20. That is the same delaying-spy idiom as
`runs one lookup per attach`. Not a merge blocker — three tokens, reasoning at
the site — but it should be a named line in 2b rather than closed as untestable.

---

# 2. The three deliberate departures

### 2a. `ownsWindow` on `listSessionsWithGroups`, not `panesOfTab` — **right**

`panesOfTab` costs a `paneCurrentPath` subprocess per pane and synthesises
records, none of which this question needs. `ownsWindow` short-circuits on
`if (!group) return true`, so an ordinary never-split tab costs exactly one
`list-sessions` and asks tmux nothing else — confirmed by reading and consistent
with the measured suite time (595 tests, 42.4 s, unchanged from 580 tests /
38.6 s at the same per-test rate). Keep.

### 2b. `withoutSharedWindows` kept as its own function — **right**

They answer different questions: one prunes a whole pane list in one pass, the
other vetoes a single write. Collapsing them would make restore ask tmux once
per pane where it now asks once. The tie-break is stated identically at both
sites and each names the other. The residual risk is drift, and the fixer named
it. Keep.

### 2c. `wireDeathHook`'s new early return does not take `remain-on-exit` off — **accept, with one caveat, and one false comment**

I scrutinised this against the standing rule and it survives it in the ordinary
case. The mechanism, read-verified end to end:

- `PtySession.start()` chains `set-option -w remain-on-exit on` with **no `-t`**,
  and the comment there says explicitly that this runs on the adopt path too. So
  a fallen-back member reattaching resolves `-w` to its *current* window, which
  is the sibling's — and the option there is already on, set by the sibling and
  paired with the sibling's hook. The reattach changes nothing.
- The early return therefore leaves an option the reattaching pane did not own
  and did not change, still paired with the hook it belongs to. Turning it off
  would indeed cost the sibling its reaping. **The reasoning genuinely escapes
  the rule** for this case.

**The caveat.** It escapes the rule only because the sibling's window is assumed
to carry a `pane-died` hook. If the sibling's own install failed earlier —
`unreachable`, or a `setDeathHook` throw, both of which take the option off and
leave no hook — then the fallen-back member's reattach turns `remain-on-exit`
back **on** via that same chained `set-option`, and this return declines to take
it off: option on, no hook, on a live window. That is the stray class. It needs a
prior hook failure to reach, and the pre-diff behaviour in the same case was
arguably worse (a hook naming the wrong tab, reaping the wrong session), so this
is not a blocker. The cheap guard is the one the fixer declined for the main fix
and which is exactly right *here*: one `show-hooks -w` read, and leave the option
alone only when a `pane-died` hook is actually present.

**And one thing that must be fixed either way.** The function's own doc block —
edited in this diff — still ends:

> *That asymmetry is what makes every early return below load-bearing… So each
> one takes the option back off first.*

That is now false of the return this commit added, which is the whole point of
departure 2c. The explanation lives at the call site; the doc still says the
opposite. By the branch's own rule that is a defect, in the function where the
rule matters most.

---

# 3. New breakage introduced by the fix diff

`ownsWindow` is consulted on four paths that previously did not call it. Here is
what each does when it answers "no", and when it cannot answer.

## N3. Important — the I1 regression test passes with the I1 defect in place

`tests/integration/restore.test.ts:575-580`.

```ts
await expect.poll(() => windowSize(founder.tmuxSession), { timeout: 10_000 }).toBe('120x40')
await expect.poll(() => windowSize(second.tmuxSession), { timeout: 10_000 }).toBe('100x30')
```

**Measured.** With `sized` forced to `true` — i.e. the I1 defect fully restored —
this test **passes**, in 283 ms:

```
✓ … > brings a split tab back as one tab, at its saved axis and ratios   283ms
```

`expect.poll` evaluates immediately and returns on the first match. At the moment
the assertion runs the windows are *still* 120×40 and 100×30, because
`sizeWindowOnAttach` is a `void`-ed async call that resolves ~25 ms later. The
poll is being used to assert the **absence** of a change, and a poll cannot do
that — it stops the instant the value it wants is already there.

Adding a 1.5 s settle before the same two assertions makes the A/B behave:

```
# with the settle, fix in place:      ✓ 1818ms
# with the settle, `sized = true`:    × expected '80x24' to be '120x40'
```

So the fix is real and load-bearing — and the guard on the branch's single most
important guarantee is a coin flip that happened to land red for the fixer and
green for me. This is the third time this one assertion has been wrong (`'80x24'`
was finding I1; this is the correction to it), and it is the same defect class
this project has now found twelve times.

**Fix:** the idiom is already in this diff. `manager.test.ts`'s
`does not resize the sibling's window when it reattaches` does
`await new Promise(r => setTimeout(r, 1000))` and then a plain `expect`, with a
comment saying exactly why. Do that here.

## N1. Important — `ownsWindow` throwing leaves `remain-on-exit` on with no hook

`listSessionsWithGroups` returns `[]` only for `isNoServer`; **everything else it
rethrows**. `ownsWindow` does not catch, and its call in `wireDeathHook` sits
between the `found` lookup and the hook install — on the `open()` path, where the
option is already on and where the only handler is `.catch(() => {})` at the
attach call site.

**Measured** (probe B, real tmux, `listSessionsWithGroups` rejecting):

```
PROBE B remain-on-exit: remain-on-exit on
PROBE B hooks:          ""
PROBE C (baseline)      remain-on-exit on, hooks present: true
```

Option on, no hook, on every ordinary attach — the stray this project has
shipped once. Before this diff there was no throwing tmux call between `found`
and the try block on the `open()` path, so this failure mode is new.

The realistic trigger is not an exotic tmux error: it is a failed `spawn` under
load. This branch's own review measured 111 tmux spawns in 3 s from one abandoned
poll and named suite-wide resource pressure as the likeliest flake mechanism.

## N2. Important — `ownsWindow` throwing makes a tab unkillable

Same root cause, worse handling. `kill()` now runs `ownsWindow` **before**
`killSession`, and nothing catches it.

**Measured** (probe A):

```
PROBE A kill threw:                     tmux said something odd
PROBE A session still alive after kill: true
PROBE A manager still lists tab:        true
```

The session survives, the entry stays registered, and `CHANNELS.kill`'s handler
rejects so `forgetTab` / `registry.forget` / `lastGeometry.delete` are all
skipped. Before this diff the only pre-kill tmux call was `windowIdOf`, which
swallows every error into `''`, so `kill()` could not fail this way.

**Fix for N1 and N2 together — one edit.** Make `ownsWindow` **fail open**:
wrap its body in `try { … } catch { return true }`. An unanswerable question then
degrades to exactly the pre-diff behaviour for one call rather than breaking the
option/hook pairing and rejecting a kill. Failing *closed* is not the safe
direction here: it would leave the option on and skip the window kill just the
same, for a pane that probably does own its window.

## N4. Minor — a denied resize re-asks tmux on every frame, and its comment says it does not

`resizeWindow`:

```ts
if (!found || !(await this.ownsWindow(entry.record.tmuxSession, found))) return
entry.windowId = found
```

When ownership is denied nothing is cached, so the next renderer `resize()` runs
`windowIdOf` **plus** `list-sessions` **plus** one `windowIdOf` per sibling —
again, and again, once per drag frame. The comment two lines above claims the
opposite:

> *Asked once per entry rather than per resize — a drag would otherwise put a
> `list-sessions` between every frame — because this branch only runs while the
> entry has no window id, and it either gets one here or stays out of the way for
> good.*

It stays out of the way, but it does not stop asking. Narrow (only a fallen-back
pane being dragged) and the same subprocess-storm shape M3 exists to remove.
Caching a `deniedWindow` on the entry, or a `windowChecked` flag, closes it.

## N5. Minor — the founder-first veto inverts, and `kill()` then leaks a live window

The tie-break is a guess about an unrecoverable question, and it is applied as a
veto on writes. In the mirror-image direction — the **founder's** window dies and
the founder falls back onto the second pane's — `ownsWindow(second, @1)` finds
the founder among the claimants, the founder wins, and the pane that genuinely
owns `@1` is denied it.

**Measured** (probe D, founder's window killed with no reporter so no hook fires):

```
PROBE D founder now reports: @1        # fallen back
PROBE D second still reports: @1       # its own window
PROBE D second session after kill: false
PROBE D windows left in the group: 1: zsh* (1 panes) [100x30] … @1 (active)
```

`kill()` on the second pane killed its session and **left its own window and the
`zsh` inside it running**. Before this diff `killWindow` would have taken it.

I am not calling this a blocker: it needs the same precondition as the case being
fixed (a window dying without its hook running), the leaked window stays linked
into the surviving session so it is visible rather than orphaned, and it is
strictly less destructive than the pre-diff behaviour it replaces (killing the
*other* pane's window and process). It belongs in 2b's brief alongside deferred
item 3.

## N6. Minor — comments added in this diff that do not match the code

The branch treats these as defects, so they are listed as such.

1. `manager.ts` `wireDeathHook` doc: *"So each one takes the option back off
   first."* — false of the return this commit added. See §2c.
2. `manager.ts` `attach`, the `sized` comment: *"Restore is that caller and is
   the only one."* — false. The renderer's `CHANNELS.open` reaches
   `manager.open(request)` with no `cols`/`rows` (`App.tsx:59` passes
   `projectSlug`, `cwd`, `command`, `type` only), and `moveTabToProject`'s
   detached branch passes no size either — which the fixer's own M2 comment 600
   lines later says out loud. Three unsized callers, not one. (The *behaviour* is
   right in all three: a fresh `new-session` window is on `window-size latest`
   and follows its client until the renderer's first resize. Only the "only one"
   claim is wrong.)
3. `manager.ts` `splitTab`: *"`sized: true` … this window was just resized
   explicitly, two lines up."* — the resize is ~10 lines up with `newGroupMember`
   and `selectWindow` between, and the `sized: true` being annotated is not on
   the line the comment sits above; it is inside `finishSplit`. The mechanism is
   true, the locator is not.
4. `resizeWindow`'s *"asked once per entry … for good"* — see N4.

---

# 4. The spec's §Done when items plan 2a owns

- **"Relaunch restores splits with their orientation and ratios"** — **met.**
  Confirmed by the branch's tests and by the previous review's independent probe.
- **"…and reattaches every pane at the renderer's size — no pane wrapped at 80
  columns."** — the second half is **met in behaviour** (A/B proves the `sized`
  gate is what delivers it) but is **not guarded by a test that can fail** (N3).
  The first half — *at the renderer's size* — remains deferred: nothing persists
  a per-pane `cols`/`rows`, so a restored pane keeps its pre-relaunch geometry
  and the renderer fits the visible one afterwards. That is the review's own
  ruling (durable fix is 2b's) and I do not reopen it.
- **"A crashed or closed pane leaves no window and no member session behind"** —
  the restore-prune leak (I2) is **closed**; the close-a-pane path is 2b's. N5 is
  a new, narrow exception to the "no window behind" half.
- **"A v4 config opens with every tab intact as a one-pane tab"** — **met**,
  covered by the store suite (and M7's rename made its assertion legible).
- **"A session created outside the app is still adopted as a one-pane tab"** —
  **met**, unchanged by this wave.

---

# 5. Merge recommendation

**Merge after three small edits.** Nothing on this list changes a design
decision; all three are minutes of work, and two of them are in the two defect
classes this project actually produces.

1. **N3** — settle-then-assert on the I1 geometry test, using the idiom already
   in `manager.test.ts` in this same diff. Without it the branch's most important
   guarantee has no working guard, and this project has already found eleven
   tests that could not fail.
2. **N1 + N2** — one `try/catch` making `ownsWindow` fail open. It restores
   pre-diff behaviour on the one condition it cannot answer, instead of leaving
   `remain-on-exit` on with no hook and making a tab unkillable.
3. **N6** — the four comments, per the branch's own rule. Item 1 in particular:
   the doc that says every early return takes the option off, in the function
   whose new early return deliberately does not.

Everything else — M4's missing test, N4, N5, and the `show-hooks` guard for §2c —
belongs in plan 2b as named entries, not as a reason to hold this branch.

---

# 6. Out of scope, for 2b's brief

- The founder-first tie-break is now load-bearing in **three** places
  (`withoutSharedWindows`, `ownsWindow`, and by consequence `kill`'s window
  reap). Deferred item 3 said the direction "can stand"; it now also decides
  whether a surviving pane may write to its own window. Worth one measured
  re-examination when 2b adds a close-pane path.
- `ownsWindow` adds one `list-sessions` per attach for every manager with a death
  reporter, plus one `windowIdOf` per sibling for a split tab. Fine today; worth
  a glance when 2b's E2E surface joins the suite.
- `tabRows` still does not dedupe tab **ids** across rows, only kids. Same class
  as M9, same "2b writes these from the renderer" trigger.
