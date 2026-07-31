# Whole-branch review — M2c splits core (`m2c-splits`, ddd56c4..31aa2f2)

Reviewer: branch-review agent. 2026-07-31.
Read: the assembled diff, the design of record, the plan, the ledger, and the
files at HEAD. Behavioural claims below marked **measured** were probed by me on
`tmux -L prcli-test` (tmux 3.7b) during this review; the socket was left with no
server running.

**Verdict: MERGE WITH FIXES.**
0 Critical · 7 Important · 7 Minor.

Nothing here breaks what ships today — no IPC exposes `splitTab`, so every tab
the app can build is still a group of one and takes the unchanged `new-session
-A` path. The findings matter because plan 2 attaches clients to exactly the
objects findings 1–4 mis-wire, and because findings 3 and 7 touch the one-pane
path that is live now.

---

## Findings

### 1. IMPORTANT — the split pane's window never gets `window-size manual`; the call lands on the founder's window

**`src/main/sessions/manager.ts:346`** (`setSessionOption(tmuxSession,
'window-size', 'manual')`), issued *before* `selectWindow` at `:348`.

**Measured.** `window-size` is a **window** option in tmux 3.7b, not a session
option:

```
$ tmux -L prcli-test show-options -g  | grep -c '^window-size'   -> 0
$ tmux -L prcli-test show-options -gw | grep -c '^window-size'   -> 1
```

`setSessionOption` targets `=<name>:` (`adapter.ts:148`), which for a
window-scoped option resolves to **that session's current window**. And a freshly
joined group member's current window is arbitrary — the spec measures this
itself, finding 3: "@0 on every measurement", i.e. the founder's window. Because
`selectWindow` runs *after* this line, the option is applied to the founder's
window (already `manual` from `:327`) and the new pane's window is left at the
tmux default, `latest`.

Replaying `splitTab`'s exact order by hand:

```
window opt on @0 (founder)   -> manual
window opt on @1 (new pane)  -> <empty>
```

**What breaks.** The design's central geometry rule is not in force for split
panes. §Geometry: "This is deliberately *not* left to `window-size latest` …
exactly the kind of 'works because of an incidental ordering' that has already
shipped as an 80×24 defect twice." Split panes are on `latest`.

I confirmed the two modes behave differently, on the same socket: a 200×49 client
attached to the `latest` window `@1` resized it to 200×48; the same client
attached to the `manual` window `@0` left it at 100×30.

**Failure scenario.** Plan 2's restore reattaches each pane. Any client that
begins viewing the split pane's window at a size other than the renderer's —
restore attaching before a refit, the sibling-fallback of spec finding 2, or a
user running `tmux attach` from a terminal — resizes that window and SIGWINCHes
everything in it. Under the intended `manual` it could not. This is the 80×24
defect class, third disguise.

**It also means the split geometry test passes for the opposite reason to the one
its comment gives.** `tests/integration/manager.test.ts:307` asserts the new
window reads `200x50`; it reads that *because* `latest` let the client size it.
Delete `manager.ts:346` entirely and the test still passes — so that line has no
test at all, and this is a command that exits 0 and does nothing.

**Fix.** Move the call after `selectWindow`, or better use
`setWindowOption(window.id, 'window-size', 'manual')` followed by
`resizeWindow(window.id, cols, rows)` — which is what §Geometry actually
specifies ("each pane's window is sized explicitly … on attach and on every
renderer resize"). Then assert `show-options -w -t <new window> -v window-size`
is `manual`, which is the assertion that would have caught this.

---

### 2. IMPORTANT — `resize()` never drives `resize-window`, so after a split the founder pane is frozen

**`src/main/sessions/manager.ts:399-406`.**

`splitTab` puts `window-size manual` on the founder's window (`:327`) and pins it
with an explicit `resizeWindow` (`:329`). **Measured:** a `manual` window ignores
an attaching client of a different size — 200×50 client, window stayed 100×30.

`SessionManager.resize()` updates `entry.cols/rows` and calls
`entry.session.resize()`, which resizes the node-pty and hence the tmux *client*.
It never calls `adapter.resizeWindow`. So once a tab has been split, every
renderer resize of the founder pane is silently discarded by tmux and the pane's
content stays at whatever geometry it had at split time.

The spec's change-set for `pty/session.ts` requires exactly this and it was never
implemented: "**`resize` drives `resize-window` as well as the client**". No task
in the plan carried it, and the ledger does not list it as deferred.

Combined with finding 1 the two halves of a split tab behave *differently*: the
new pane follows its client (`latest`), the founder ignores it (`manual`). That
asymmetry is harder to diagnose than either bug alone.

**Failure scenario.** User splits a tab, then drags the window wider. The new
pane reflows; the founder does not, and stays wrapped at the old width until
something else forces a `resize-window`. Not reachable from the UI in plan 1, but
it lands the instant plan 2 exposes split.

---

### 3. IMPORTANT — a hook that fails to install leaves `remain-on-exit` on with nothing to reap, and three comments claim the opposite

**`src/main/sessions/manager.ts:186`, `:208`, `:218-227`, `:240-247`;
`src/main/pty/session.ts:149`.**

On the `open()` path `remain-on-exit` is chained into the spawn (`session.ts:149`)
*before* any hook exists — deliberately, and the reasoning for it is sound.
`wireDeathHook` then has three ways to finish without installing one:

- **(a)** `awaitWindowId` returns `''` (`:246`). `windowIdOf` swallows *every*
  error, not only "session gone", so a transient tmux failure is indistinguishable
  from a dead session — and after a 10 s poll the function gives up either way.
- **(b)** `deathHookCommand` returns null (`:222`, the `@<digits>` guard).
- **(c)** `setDeathHook` throws anything the adapter does not tolerate. The
  rejection is swallowed whole by `.catch(() => {})` at `:186`.

In all three the option is already on. An ordinary `exit` then leaves a dead
pane, its window and its session behind permanently — the stray this project has
already shipped once — and the next restore adopts it as a live tab.

Three comments assert this cannot happen:

- `:218` — "the command is built BEFORE the option is set, and a refused one
  leaves the window exactly as tmux made it — the cost is a red dot, never a
  stray." True only on the split path; on `open()` the option was set at spawn.
- `:208` — "Nothing to hook and nothing to leak: a session tmux will not name
  has gone, taking its window with it." An assumption, not a fact:
  `windowIdOf` answers `''` for any failure.
- `:184` — "the cost of that is a tab whose death shows grey instead of red."
  The cost is a grey dot **and** a session nothing reaps.

Under this project's own rule — a comment asserting a mechanism that is not true
is a defect — that is three.

**In practice the trigger is narrow.** `canBuildDeathHook` (`session.ts:143`)
checks exactly what `deathHookCommand` will minus the window id, so (b) is
unreachable while `windowIdOf` returns tmux's own `@<n>`; (a) and (c) both need a
tmux error. So this is not a routine failure. It is, however, precisely the
invariant the together-or-not-at-all rule exists to hold, and the code currently
believes it is protected when it is not.

**Fix.** On any path where the hook does not go on, best-effort
`setWindowOption(window, 'remain-on-exit', 'off')` before returning — cheap, and
it makes the rule true rather than asserted. At minimum, correct the three
comments.

---

### 4. IMPORTANT — `splitTab` has no cleanup; six awaits after the window exists can leave a window and a member session behind

**`src/main/sessions/manager.ts:334-380`.**

After `newWindow` succeeds, `newGroupMember` (`:345`), `setSessionOption`
(`:346`), `selectWindow` (`:348`), `wireDeathHook` (`:371`), `respawnPane`
(`:373`) and `attach` (`:377`) all run unguarded. Any throw leaves:

- an orphan **window** holding a running shell in the tab's shared window list —
  invisible to the app, visible only to `list-windows`; and
- if the failure is at or after `:345`, a **member session** named
  `prcli-<slug>-<id>` that `findOrphans` will happily report as a real pane. The
  next restore then resurrects a pane the user never created, attached to a
  window the app has no record of.

**Failure scenario.** The placeholder shell created by `newWindow` dies on its
own before `respawnPane` runs — a login shell that fails on a bad rc file, or a
`cwd` removed under it. The hook installed a moment earlier at `:371` fires,
reports an `Exit` for an id the renderer has never seen, and reaps the window and
session. `respawn-pane` then fails "can't find window" and `splitTab` rejects,
having already emitted a phantom exit event.

**Fix.** Wrap from `newWindow` onward in try/catch; on failure
`killWindow(window.id)` and `killSession(tmuxSession)` before rethrowing. Both
adapter methods already tolerate their target being gone — and this would give
`killWindow` its first production caller (see finding 9).

---

### 5. IMPORTANT — `panesOfTab` returns `[]` once the founder pane is gone, so a surviving split tab becomes unmovable

**`src/main/sessions/manager.ts:673`.**

```ts
const founder = rows.find((row) => decodeSessionName(row.name)?.id === tabId)
if (!founder) return []
```

The spec measures that a group outlives its founder: "founding member killed |
Group name and windows survive; `group_size` drops." `findOrphanTabs` handles
that case correctly — the tab id comes from the frozen group name, which is still
there. `panesOfTab` cannot: with no session whose *own* id is `tabId`, it returns
`[]`, and `moveTabToProject` (`:519`) then throws `moveTabToProject: no session
for tab <id>`.

So the two tab-resolution paths disagree about whether a tab exists, and the
disagreement appears exactly when the founder pane has crashed — the scenario
this milestone is built around.

**Failure scenario.** User splits a tab, the founder pane crashes (red dot,
sibling keeps running as designed), then the user drags that tab to another
project. The move throws "no session for tab" and the tab is stuck in its old
project for as long as it lives.

The spec's test plan asks for "Kill the founder member and assert the tab is
still reassembled from the group"; that is covered for `findOrphanTabs` only.

**Fix.** Fall back to the group when no founder row exists:
`rows.find((r) => tabIdFromGroupName(r.group) === tabId)`, then take that row's
group as the member filter. Add the founder-killed case to `panesOfTab`'s tests.

---

### 6. IMPORTANT — the rollback has no rollback: a failing undo replaces the original error and abandons the rest

**`src/main/sessions/manager.ts:538-543`.**

```ts
} catch (error) {
  for (const { from, to } of renamed.reverse()) {
    await this.adapter.renameSession(to, from)
  }
  throw error
}
```

If any undo rename throws — the source name has been taken in the meantime, or
tmux is transiently unavailable — the loop aborts on the spot. The remaining
already-moved panes are never restored, and the error that propagates is the
*undo's*, not the cause. The caller is told the wrong thing about a tab that is
now genuinely split across two projects: the single outcome this method exists to
prevent, arrived at silently.

**Failure scenario.** A three-pane tab moves `lumio` → `gco`. Panes 1 and 2
rename; pane 3 is refused. Rollback renames pane 2 back, then pane 1's rollback
is refused because something recreated `prcli-lumio-<pane1 id>` in between. Pane
1 stays in `gco`, panes 2 and 3 in `lumio`, and the caller sees "duplicate
session" — a message about the undo, describing nothing that happened.

**Fix.** Wrap each undo in its own try/catch, keep going through the whole list,
and rethrow the original error with the undo failures attached (`cause`, or an
`AggregateError`).

**The two cases the brief asked about are otherwise correct.** First rename
fails: `renamed` is empty, nothing is undone, the original error is rethrown —
correct. Founder-first ordering: real, and the reasoning behind it (measured
alphabetical `list-sessions` ordering vs. random hex ids) is sound. One caveat —
`panesOfTab`'s doc at `:658` calls element 0 "the founder", but it is really "the
pane whose own id was passed". `moveToProject`, still live at
`register.ts:376`, passes an arbitrary pane id. Harmless today because the
rollback is position-independent, but the comment names something the code does
not guarantee.

---

### 7. IMPORTANT — a stale hook forfeits the window reap, because a tmux command list aborts at the first failure

**`src/main/pty/deathHook.ts:66-71`, `src/main/sessions/manager.ts:556-576`.**

**Measured:**

```
$ tmux -L prcli-test kill-session -t '=prcli-gone-0000000000000000' ';' kill-window -t @1
can't find session: prcli-gone-0000000000000000
windows after: @0 @1        # @1 survived — the list aborted
```

The hook is `run-shell "<report>" ; kill-session -t =<name> ; kill-window -t
<@n>`, with the session name baked in as a literal. `moveTabToProject` renames
every member (`:535`) and only afterwards detaches and re-opens each pane
(`:562-573`), whose hook is reinstalled **asynchronously** — `awaitWindowId`
poll plus `setDeathHook`. Between the rename and the reinstall the installed hook
names a session that no longer exists.

A pane dying in that gap reports its status (`run-shell` runs first, so the red
dot is correct) and then reaps **nothing**: dead pane preserved by
`remain-on-exit`, window and session both left behind.

Pre-existing in kind — the old `kill-session`-only hook had the same stale-name
gap — but M2c widens it, because hook installation moved from a command chained
into the attach to a polled asynchronous call, and it adds the window to what
leaks. Nothing tests it.

**Fix (cheap).** Reinstall the hook *before* cycling clients in
`moveTabToProject` — the window ids are already knowable there — or accept it and
say so in a comment. Right now the ordering choice (`kill-session` before
`kill-window`, which spec finding 2 requires) silently means any failure of the
first command forfeits the second, and no comment records that.

---

### 8. IMPORTANT (test) — the `killWindow` adapter test cannot fail

**`tests/integration/adapter.test.ts:280`** — "kills a window without killing the
session that also holds another".

```ts
await adapter.killWindow(doomed)
expect(await adapter.hasSession('f')).toBe(true)
await expect(adapter.killWindow(doomed)).resolves.toBeUndefined()
```

Neither assertion observes the window. Stub `killWindow`'s body to `return` and
the test still passes: `f` still exists, and a no-op still resolves `undefined`.

The mutation it fails to catch is this project's signature one — a wrong target
form (`=@7`, `@7:`, a dropped `-t`) that exits 0 and kills nothing. That is the
same class as the four `select-window` / `set-option` forms the pre-flight scan
caught, and `killWindow` is the one new adapter method whose correct target form
(*no* `=`, *no* colon) differs from every other method in the file.

**Fix.** Assert the window is gone:
`expect(await windowsOf('f')).not.toContain(doomed)`, or a `list-windows` count
dropping from 2 to 1.

Everything else in the new test surface holds up under mutation. I checked each:
`selectWindow`'s binding test fails if `selectWindow` no-ops (the `new-window`
without `-d` leaves `f` on the second window, so the `f` assertion catches it);
`setWindowOption` and `setWindowHook` both assert the sibling is *not* set, so a
`-g` mutation fails them; `findOrphanTabs`, `moveTabToProject` and the blocker
test all assert a non-empty collection before iterating it; the rollback test's
A/B is confirmed in the ledger and the founder-first fix is what makes it
deterministic.

---

### 9. MINOR — `killWindow` and `setWindowHook` have no production caller

`adapter.ts:224` and `adapter.ts:265`. `killWindow` is exercised only by the
vacuous test in finding 8; `setWindowHook` only by an adapter test — production
installs hooks through `setDeathHook` (`:289`), which builds its own `set-hook`
args rather than calling it. Two exported methods that nothing ships.
`check-deps` will not catch a class method.

Wiring `killWindow` into finding 4's cleanup and into finding 10 would justify
it; otherwise drop it. `setWindowHook` is arguably worth keeping as the tested
primitive `setDeathHook` should be built on — but then `setDeathHook` should call
it rather than duplicating the argument construction.

---

### 10. MINOR (carry to plan 2) — `kill()` reaps a member session but never its window

`src/main/sessions/manager.ts:426-438` calls `adapter.killSession(name)` only. In
a session group the window list is shared, so killing one member unlinks nothing:
killing a split pane leaves its **window and its running process** in the
sibling's window list forever.

This is exactly the leak the death hook was extended to fix, on the closing path
instead of the crashing one. The spec's "Done when" requires "A crashed **or
closed** pane leaves no window and no member session behind."

Unreachable today (no pane-close IPC), so it belongs beside the ledger's existing
`register.ts:376` carry item — but it is not on that list, and it is the more
dangerous of the two because it leaks a *running process*, not just a name.

---

### 11. MINOR — the spec's §Death code block gives the reverse hook order to its own finding 2 and to the implementation

`docs/superpowers/specs/2026-07-31-prcli-m2c-splits-design.md:182`:

```
run-shell "<report>" ; kill-window -t <window> ; kill-session -t =<member>
```

Finding 2 in the same document says the member's client must be gone before its
window is, or the member falls back to a sibling's window and two xterms render
the same pane. The code and the unit test both do `kill-session` then
`kill-window`. A reader reaching for the block would reintroduce the defect
finding 2 exists to prevent. One-line fix to a document this branch is adding.

---

### 12. MINOR — `canBuildDeathHook` has zero direct tests, and nothing asserts that a refused hook means no `remain-on-exit`

`src/main/pty/deathHook.ts:36`. This branch moved the together-or-not-at-all rule
from `if (deathHook)` to `if (canBuildDeathHook(...))` (`session.ts:143`) and
neither half is covered. The spec's test plan asks for it explicitly:
"`deathHookCommand` with the added target, **including a refused command still
disabling `remain-on-exit`**."

An unsafe reporter path today produces no test failure whichever way the code
goes. Given that this rule is the one whose violation already shipped a stray,
one test — construct a `PtySession` with a reporter containing a single quote and
assert `remain-on-exit` is absent from the spawned args — is cheap insurance.

---

### 13. MINOR — `names.test.ts` "returns the same id after the tab has moved project" moves nothing

Already on the ledger as a deferred minor, with the condition "fine as long as
Task 8 lands; flag to the branch review if Task 8 weakens". Task 8 did land the
real proof (`moveTabToProject` plus the stale-slug assertion in
`findOrphanTabs`), so the gate is satisfied. Recording it only so the ruling is
closed: the test documents an invariant against a static string rather than
proving it, and is harmless.

---

### 14. MINOR — `wireDeathHook` on the `open()` path is a detached 10 s poll with no cancellation

`manager.ts:186`, `:240-247`. `awaitWindowId` polls every 20 ms for up to 10 s and
nothing cancels it when the pane is detached or the app quits. `detachAll()` on
shutdown leaves one live timer per tab. In tests it can outlive the test that
started it and issue tmux calls against a socket the next test has already
`kill-server`'d — invisible, because `windowIdOf`'s catch-all swallows the error
and the loop simply runs to its deadline.

A plausible contributor to the integration flakiness the ledger records, though
the ledger measured that flake on `ddd56c4` too, so it is not the cause.
Worth an `AbortController` or a check against `this.entries.get(id) === entry`
inside the loop.

---

## What this branch does well

- **The blocker is genuinely discharged, and the test that proves it earns its
  keep.** The window assertion is the one that fails against the pre-M2c hook,
  and it exists because an implementer refused to accept a blocker test that
  could not fail and built the difference table instead. That is the right
  instinct applied to the most important test on the branch.
- **The `set-hook … ; if-shell -F '#{pane_dead}' … -R` catch-up is the right
  shape.** No sleep, no retry, no widened timeout — the race is closed by making
  a late hook fire against the already-dead pane. The single-invocation argument
  for why it cannot double-report is correct. I checked the adjacent risk
  separately: **measured**, `set-hook` *replaces* rather than appends
  (`pane-died[0]` after three calls), so repeated reattaches — restore on every
  app start, every project move — do not accumulate hooks or duplicate reports.
  That was a real way to report a death N times and it is closed.
- **Death is never reported under the wrong pane's id.** Each window carries its
  own `-w`-scoped hook with its own baked-in literals, so there is no shared
  state to cross-attribute through.
- **`panesOfTab` sourcing `id`/`projectSlug`/`tmuxSession` from the live tmux row
  and `cwd`/`command`/`type` from the cached entry is exactly right**, and the
  founder-first ordering rests on a measured fact about `list-sessions` ordering
  rather than an assumption about insertion order.
- **The stale-group-slug rule is enforced narrowly and proved.**
  `tabIdFromGroupName` reads one field, and Task 7's third test fails under the
  plausible mutation rather than merely documenting the rule.
- **Comment quality is unusually high and mostly load-bearing** — the
  `respawn-pane -k` reasoning, the "`window-size manual` reverts to the size
  recorded at window creation" explanation, and the reconciliation of the two
  contradictory 80×24 measurements are all measured rather than assumed. The
  three that are wrong (finding 3) stand out precisely because the rest are
  right.
- **Task 4's rename is genuinely mechanical.** `PRCLI_TAB_ID` is untouched — 13
  references in `src/`, all intact — `TabDescriptor` did not move, and the
  transitional `TabRecord` alias and the Task 1 `windowId: string | null` seam
  are both fully deleted, as the ledger promised.
- **Constraints held.** Config is still v4 (`store.ts:26`). Every test touches
  `-L prcli-test` only; no bare `kill-server` anywhere. No `npm install`.

---

## Verdict

**MERGE WITH FIXES.**

Nothing on this branch regresses live behaviour: one-pane tabs still take the
byte-for-byte-unchanged `new-session -A` path, and `splitTab` has no caller
outside tests. The plan's promised surface is all present and the blocker is
really discharged.

Fix before plan 2 builds on this, in this order:

1. **Finding 1** — the split pane's `window-size manual` is a no-op, and plan 2's
   restore is the first thing that will attach a differently-sized client to that
   window. Fix it and give it the assertion that would have caught it.
2. **Finding 8** — the vacuous `killWindow` test, because finding 4's fix wants
   `killWindow` to actually work and there is currently no test that says it does.
3. **Finding 3** — either unset `remain-on-exit` when the hook does not go on, or
   stop three comments claiming it already happens.
4. **Findings 4, 5, 6** — the splitTab leak, the founder-gone `panesOfTab` hole,
   and the rollback's un-rolled-back rollback. All three are small, local
   changes.
5. **Finding 2** and **finding 10** are plan-2 scope but belong on the carry list
   beside `register.ts:376`, not discovered again later.

Findings 7, 9, 11–14 are worth a cleanup pass but should not hold the merge.
