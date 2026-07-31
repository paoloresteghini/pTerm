# Scoped re-review of the fix wave — `31aa2f2..9f47b39`

Reviewer: rereview agent. 2026-07-31. Branch `m2c-splits`, 9 commits.
Read: the assembled fix diff, `branch-review.md`, `fixwave-report.md`, the design
of record, and the files at HEAD (`manager.ts`, `deathHook.ts`, `session.ts`,
`names.ts`, `adapter.ts`). Two behaviours were probed by me on
`tmux -L prcli-test`; the socket was left with no server running. Test suites not
re-run, as instructed.

**Verdict: MERGE WITH FIXES.** One pre-merge fix, four lines of docstring
(§New 2). Everything else is a carry item.

---

## 1. Per-finding verdicts

| # | Verdict | Note |
| --- | --- | --- |
| 1 | **ADDRESSED** | `-w` against a window id, on both windows. See the caveat in §3. |
| 2 | **ADDRESSED** | `resize` drives `resize-window`. See §New 1 for its side effect. |
| 3 | **ADDRESSED** | Two of three holes closed; the third documented, not denied. But a *fourth* comment asserting the disproved mechanism survives — §New 2. |
| 4 | **ADDRESSED** | `rollbackSplit` kills member session then window, in the hook's order. |
| 5 | **ADDRESSED** | Group fallback reads the id half only; slug never read. |
| 6 | **ADDRESSED** | Per-undo try/catch, loop runs to the end, `AggregateError` with the original first. |
| 7 | **ADDRESSED (narrowed)** | Ruling in §4b. |
| 8 | **ADDRESSED** | The test now observes the window list before and after, twice. |
| 11 | **ADDRESSED** | Spec block now `kill-session` then `kill-window`, with the reason inline. |
| 12 | **ADDRESSED** | `canBuildDeathHook` block + `PtySession remain-on-exit` argv tests. |
| 13 | **ADDRESSED** | Builds two divergent names and asserts the slugs differ. Still documents rather than proves; the fixer says so in the test's own comment, which is the honest form. |
| 9, 10 | parked | Not failures. `killWindow` gained its production caller (`rollbackSplit`), so finding 9's first half is discharged as a side effect. |
| 14 | **rejection holds** | Ruling in §5. |

### Findings 4, 5, 6 checked against their own paths

- **4.** Every exit from the guarded region was traced. Failure at
  `setWindowOption`/`resizeWindow` (member not yet created): `killSession` no-ops,
  `killWindow` reaps the orphan window. Failure at `newGroupMember` or
  `selectWindow`: same, plus a member that may or may not exist — both adapter
  methods tolerate an absent target (`adapter.ts:224-232`). Failure inside
  `finishSplit` after `wireDeathHook`: the hook is on the window, but the window
  is destroyed outright, and any `pane-died` that did fire would hit a
  `kill-session` for a name already gone and abort there. The founder's
  `setWindowOption`/`resizeWindow` are deliberately *outside* the try, which is
  right — nothing exists to undo at that point.
- **5.** The fallback cannot swallow a genuine miss (`tabIdFromGroupName('')` is
  null; group names carry a unique 16-hex id) and cannot resolve the wrong tab.
  It also survives a move, because the group name keeps the id and only the slug
  goes stale — the rule is upheld, not bent.
- **6.** `[...renamed].reverse()` fixes the in-place mutation of the array whose
  `length` the message then reports. Correct.

---

## 2. New breakage introduced by the fix diff

### New 1 — IMPORTANT (carry): `resize-window` itself sets `window-size manual`, so finding 2's fix converts every one-pane tab's window, and no attach path resizes a window

**Measured by me, tmux 3.7b, `-L prcli-test`, twice:**

```
$ tmux new-session -d -s f -x 100 -y 30 'sleep 300'
$ tmux show-options -w -t f: -v window-size      ->            (unset)
$ tmux resize-window -t @0 -x 120 -y 40
$ tmux show-options -w -t f: -v window-size      -> manual
```

`resize-window` flips the window to `manual` on its own. `SessionManager.resize`
(`manager.ts:564`) now calls it for **every** pane, not only split ones — so the
first renderer resize of an ordinary one-pane tab, the path that ships today,
takes its window off `latest` for good.

That is the direction the design wants, and it is not a leak. But it moves a load
bearing property: while a window was on `latest`, an attaching client sized it,
and that is what has been carrying the pane's live geometry onto the window on
every attach. A `manual` window ignores its client (the branch review measured
this; so does `splitTab`'s comment). `attach` (`manager.ts:132-202`) issues no
`resize-window` at all. So after this wave:

- `moveTabToProject` reattaches a **detached** pane with no entry and therefore
  no size (`manager.ts:791-792`, `size = {}` → 80×24). Under `latest` the window
  followed the client down to 80×24 — the shipped-twice defect. Under `manual` it
  now keeps its real size and the 80×24 client sees a clipped view instead. A
  different symptom of the same unstated dependency, and converging only because
  the renderer refits afterwards.
- Plan 2's restore is the first caller that attaches to a window it did not just
  size. It must resize the window explicitly; it can no longer inherit the size
  from the client it spawns.

The design of record says the window is sized "on attach **and** on every
renderer resize" (§Geometry). Half of that landed. And `manager.ts:552-557`
attributes the need for `resize-window` solely to `splitTab` putting `manual` on
every pane's window — true as far as it goes, but it does not record that
`resize` is now itself what makes every other window manual. That mechanism
belongs in the comment.

Not a merge blocker: nothing leaks, nothing is stranded, and the transient
resolves on the next refit. It is the first line of plan 2's carry list.

### New 2 — IMPORTANT (fix before merge): a fourth comment still asserts the mechanism finding 3 disproved

`src/main/pty/deathHook.ts:31-34`, untouched by this wave:

> Leaving the window id out costs nothing, because it is never the reason a hook
> is refused: it comes back from tmux itself as `@<digits>`, and **when tmux will
> not name a window there is no session left to leave a stray behind either.**

That second clause is exactly finding 3(a): `windowIdOf` swallows every failure
and answers `''` for all of them, so a session tmux has never heard of and a tmux
that will not answer are indistinguishable. The wave corrected the three comments
the review named (`manager.ts:184`, `:208`, `:218`, plus `session.ts`) and added a
new one at `manager.ts:229-241` that says the opposite in as many words — *"This
is NOT proof the session has gone."* The tree now holds two comments about one
mechanism, one of them false, and the false one sits on the guard that the whole
together-or-not-at-all rule is asked at spawn time.

Under this project's own rule that is a defect, and it is the same defect the wave
was sent to close. Four lines of docstring: say that the window id is never a
*reason* for refusal, and stop the sentence there — `wireDeathHook` now documents
what happens when tmux will not name a window, and this is not the place to
re-assert it.

### New 3 — MINOR: `moveTabToProject` can now block on a poll it did not before

`manager.ts:770-773` awaits `wireDeathHook(..., null)` per pane, and with a null
window id that runs `awaitWindowId` — 20 ms polls for up to **10 s**. A rename is
synchronous in tmux, so the first poll should answer; but a tmux hiccup now
stalls a user-visible move for up to 10 s per pane on a path that previously made
no blocking call there. The `.catch(() => {})` swallows the error, not the wait.
Cheap mitigation later: pass the window id, which `panesOfTab` could carry.

### New 4 — MINOR: `rollbackSplit` emits an exit event for a pane no caller has seen

`manager.ts:506-517`. If the failure lands after `attach` registered the entry,
the rollback sets `intent = 'killed'` and detaches, so `onExit` listeners fire
with a record whose id `splitTab`'s caller never received (it throws instead).
Harmless while no IPC exposes `splitTab`; worth a line before plan 2 wires the
renderer to exit events.

### Checked and clear

- **`remain-on-exit` on with no hook, by any ordering.** All four orderings
  traced. `splitTab`: the option goes on *after* the command is built and a
  `setDeathHook` throw unsets it before rethrowing into `rollbackSplit`, which
  kills the window anyway. `open()`: chained at spawn, unset by `wireDeathHook`
  on both reachable failure paths. `moveTabToProject`'s reinstall: the option was
  already on and a refusal now takes it off, which trades a red dot for no stray
  — the correct trade. The one surviving hole is `awaitWindowId` returning `''`,
  documented at `manager.ts:229-241`, and the fixer's reason for not closing it is
  sound: naming the window through `'=<session>:'` is the finding-1 mistake, and
  it would fail for the same reason `windowIdOf` just did.
- **Stray windows, member sessions, dead panes.** No new path. `rollbackSplit`
  closes the one the review found; `kill()` still leaks a window (finding 10,
  parked).
- **Target forms.** `setWindowOption`/`resizeWindow`/`killWindow` take a bare
  `@n`; `selectWindow` takes `=<name>:<index>`; `newWindow` takes `=<member>:`.
  All conform. No production `setSessionOption('window-size', …)` remains — the
  only `setSessionOption` left in `src/` is the adapter's own definition.
- **A pane's project comes from its own name.** `panesOfTab`'s new fallback reads
  `tabIdFromGroupName` only. The frozen slug is never read.
- **Config v4**, unchanged; the diff touches no store file.

---

## 3. Can the new tests fail?

Spot-checked against the production change each guards, by reading the assertion
and the code path rather than by re-running.

- **Finding 1 — "puts window-size manual on the new pane's own window, not the
  founder's".** **Yes**, for the fix as a whole: revert to
  `setSessionOption(tmuxSession, …)` before `selectWindow` and the split window
  reads `''`. **Caveat:** reverting only `setWindowOption(window.id, …)` while
  keeping `resizeWindow(window.id, …)` leaves the test green, because
  `resize-window` sets `manual` itself (§New 1, measured). The pair is
  falsifiable; the `set-option` line alone is not. Not a NOT ADDRESSED — the
  option lands on the right window either way and the explicit call states the
  intent — but the assertion does not distinguish the two, and a future reader
  who deletes the "redundant" line will get no failure.
- **Finding 2 — "resizes a split tab's window, not only its client".** **Yes.**
  Both windows are `manual` at 100×30 by the time it resizes, so the client
  resize provably cannot move them; only `resizeWindow` can. Removing the `void
  this.resizeWindow(...)` leaves both at 100×30.
- **Finding 3 — "takes remain-on-exit back off when the hook cannot be
  installed".** **Yes.** `setDeathHook` is mocked to reject, so the option is
  genuinely on when the catch runs; restore the bare rethrow and the poll on
  `.not.toBe('on')` never resolves. The `kill -9` half is the better assertion of
  the two: with no hook, tmux's own reaping is the only thing that can remove the
  session, and `remain-on-exit on` is exactly what stops it.
- **Finding 6 — "keeps undoing after one undo is refused".** **Yes, twice.**
  Abort-at-first-failure changes the thrown message; collect-then-`break` leaves
  `first.tmuxSession` gone. Both halves of the finding have their own mutation.
- Also noted: the fixer **deleted** one test it wrote because no single mutation
  could fail it, and **rewrote** the finding-7 test after the first draft passed
  with the fix removed. That is the seventh and eighth instance of this failure
  mode on this project, caught by the author rather than by review. The
  recording-based form the finding-7 test settled on — assert against a captured
  argument with no `await` between it and the call returning — is the shape to
  reuse whenever an asynchronous retry can mask the thing under test.

---

## 4. The fixer's two self-reported items

### 4a. `canBuildDeathHook` accepts a session name containing `;` — reasoning **sound**, unreachable-today **is** good enough to merge

Verified rather than taken on trust. `encodeSessionName` (`names.ts:33-40`)
**throws** for any slug outside `/^[a-z0-9_]+$/` and any id outside 16 hex — it
does not sanitise, so there is no silent path through it. Every session name
reaching `deathHookCommand` comes from one of exactly two places: that function
(`open`, `splitTab`, `moveTabToProject`), or a tmux row already filtered through
`decodeSessionName`/`isPrcliSession`, which enforces the same pattern. Neither can
yield a `;`, a space, or anything else that would break the command list. The
second half of the argument is also right: widening `UNSAFE_IN_HOOK` would break
the reporter path, which legitimately holds spaces and has a test saying so.

So: merge. But the guard *reads* as though it validates the session name, and it
does not — the thing that actually makes this safe lives in another file, and the
note saying so is currently in the test rather than at the guard. The cheap
correct fix, for plan 2, is one line: check `isPrcliSession(tmuxSession)` there
instead of `UNSAFE_IN_HOOK.test(tmuxSession)`. Same answer for every value the app
generates, no effect on the reporter path, and it makes the guard true rather than
incidentally sufficient. Until then the note belongs in `deathHook.ts` — fold it
into the §New 2 docstring edit.

### 4b. Finding 7's residue — **acceptable for merge**, not load-bearing

The exposure went from "the whole of a move — rename, detach, respawn, a polled
`awaitWindowId`, then `setDeathHook`" to "between one rename and the next", which
is a synchronous tmux round trip. The failure mode is unchanged in kind and
pre-existing in kind (the old `kill-session`-only hook had the same stale-name
gap); the cost of hitting it is one window and one member session left behind,
with the red dot still correct because `run-shell` runs before the failure. The
next restore's reconcile is what collects it.

It is not load-bearing for merge because nothing in plan 1 moves tabs
automatically or in bulk — a move is a deliberate drag, one at a time. It becomes
load-bearing if plan 2 ever moves a whole project's tabs in one action, because
the residue is per-rename and a bulk move multiplies the count of gaps by the
number of panes. Closing it properly means reinstalling inside the rename loop
and teaching the rollback to restore hooks too, which is the fixer's own
assessment and is correctly sized as a separate change.

---

## 5. Finding 14's rejection

**Holds.** The objection is not "too much work" — it is that `awaitWindowId`
answering `''` would come to mean three different things (session gone, tmux
failed, poll cancelled) in the same wave that made the comment distinguishing the
first two load-bearing for finding 3. That is a real coupling, and the third call
site (`moveTabToProject`'s reinstall) genuinely has no entry to test a
`stillWanted` predicate against. The residue is bounded — one dangling 10 s timer
per tab at shutdown, and test noise — and the ledger already measured the flake it
might contribute to on `ddd56c4`, before any of this. Carry it; do not hold merge
for it.

---

## Carry to plan 2

1. **Attach must size the window** (§New 1). The design already requires it; the
   client no longer does it for us now that every window ends up `manual`. This
   is the geometry rule's third disguise and it is now plan 2's to prevent, not
   to discover.
2. **Finding 10** — `kill()` reaps a member session but not its window, leaking a
   running process. Interacts with (1): both are attach/detach-path geometry and
   lifecycle gaps.
3. **Finding 7's residue** — reinstall inside the rename loop, and restore hooks
   in the rollback.
4. **Finding 3's `awaitWindowId === ''` hole** — needs a decision about how to
   name a window tmux will not name, which is a design call, not a fix.
5. **`canBuildDeathHook` should take `isPrcliSession`** (§4a) — one line.
6. **`resize` now issues one `execFile` per renderer resize** (the fixer's third
   concern). Coalesce if plan 2's drag-resize proves chatty.
7. **Finding 14** — cancellation for `awaitWindowId`, once the `''` return has one
   meaning again.
8. **`register.ts:376`'s `moveToProject`** — already on the list.

## Verdict

**MERGE WITH FIXES.**

One fix before merge, and it is a docstring: `deathHook.ts:31-34` still asserts
the mechanism this wave was sent to disprove, and now contradicts a comment the
same wave added twenty lines away in `manager.ts`. Four lines. Fold §4a's note
into the same edit.

Everything else the wave was asked to do, it did. Eleven findings addressed, two
parked as instructed, one rejected with reasoning that holds up under checking.
The four tests spot-checked all fail against their own reverts, and the fixer
deleted one test and rewrote another for the specific reason that they could not
— which is the failure mode this project keeps producing, caught this time before
review. The two self-reported items are both real, both correctly triaged, and
neither blocks.

The one thing to carry forward with more weight than its severity suggests is
§New 1: the wave's own fix changed which mechanism keeps a window's geometry
honest, and the half that used to be free — the attaching client sizing the
window — is no longer there. Plan 2 attaches.
