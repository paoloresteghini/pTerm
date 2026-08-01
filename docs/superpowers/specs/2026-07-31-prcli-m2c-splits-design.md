# M2c — Splits

**Date:** 2026-07-31
**Status:** Approved, pre-implementation
**Supersedes:** the "Every pane is one tmux session" paragraph in
`2026-07-30-prcli-design.md` §Process model, and the reason given for it.
**Discharges:** the "Known gaps, deliberately left" blocker in
`2026-07-31-prcli-crashed-reachable-plan.md` — the `pane-died` hook that kills
the whole session.

## The decision, and how it was reached

A tab was exactly one tmux session with exactly one pane, and that identity was
load bearing in session names, slugs, `PRCLI_TAB_ID`, restore's reconcile and
the project-by-slug scheme. Splits break it. Three models were on the table:
panes inside the existing session, one session per pane grouped by the app, or
something else.

The design of record argued for one-session-per-pane, on the grounds that
"windows within a shared tmux session resize together, which would make splits
fight each other". That premise was measured rather than inherited, and it is
false on tmux 3.7b.

### Measurements (tmux 3.7b, `-L prcli-test`, 2026-07-31)

| Probe | Result |
| --- | --- |
| `split-window -e PRCLI_TAB_ID=bbb` | **Reaches the pane process.** pane0 saw `aaa`, pane1 saw `bbb`. |
| `new-window -e PRCLI_TAB_ID=pane1` | **Reaches the pane process.** window0 saw `pane0`, window1 saw `pane1`. |
| two clients, one session, different windows | **Impossible.** Both are forced to the same window. |
| grouped members, one client each | **Independent current window per member.** |
| window sizes, `window-size latest` | Each window holds its own size, fixed when a client begins viewing it. |
| window sizes, `window-size manual` + `resize-window` | Exact, independent, identical as read from every member. |
| `window-size` set on one member | **`window-size` is a WINDOW option, not a session one.** `show-options -g` does not list it; `show-options -gw` does. Recorded here as a contradiction between two probes, wrongly: both were right. `set-option -t '=<name>:'` on a window option resolves to *that session's current window*, so the first probe read the option back through a member still showing the founder's window (the same window it had just been set on) and the second read it through a member showing its own. Nothing propagates and nothing is shared — set it with `-w` against a **window id**, which is the only target that says which window is meant. |
| `select-window -t @<id>` alone, or with a doubled `-t` | **Binds nothing, exits 0.** Binding a member needs `-t '=<member>:<index>'`. |
| `set-option -t '=<group>:'` after the founder dies | **`no such window`.** A group name is valid for `new-session -t` only; option and window targets must name a live member. |
| `set-option -w -t <windowId> remain-on-exit on` | Per window; the sibling window reads it unset. |
| `#{session_group}` on an ungrouped session | **Empty.** |
| `#{session_group}` on members | The founding session's name, readable via `-t '=name:'`. |
| founding member killed | Group name and windows survive; `group_size` drops. |
| `new-session -t <group>` after the founder is gone | **Accepted.** A group name is a valid `-t` even with no session of that name. |
| every member killed | Windows and their processes die with the last one. |
| `tmux ls` | Lists every member, annotated `(group <name>)`. |
| `pane-died` hook on a 2-pane window | Fires; `#{pane_id}` correct; **`#{window_panes}` still counts the dead pane**. |
| member's bound window killed | Member **silently falls back to a sibling's window**. |
| founder renamed | **`#{session_group}` does not follow.** Renamed `f`→`renamed`; group stayed `f`. |
| non-founder member renamed | Group unchanged, as expected. |
| joining by the original group name after a rename | Accepted. (Joining by the *new* name was not cleanly measured — the probe collided with an existing session name. Assumed to work, since `-t` takes a session name and uses its group; not relied on by this design.) |
| every member killed | Both pane processes confirmed gone by pid. |

Two of these overturn the cost table the ruling was first offered against:
per-pane `PRCLI_TAB_ID` is available, so panes-in-a-session costs no id
collision; and grouping is held by tmux, so one-session-per-pane costs no new
durable notion in config.

The third finding is the one that decides the shape: **a tmux client renders a
whole window, panes and borders included — there is no attach-per-pane.** So
literal panes-inside-one-window means one xterm per tab with tmux drawing the
splits, which contradicts the design of record's §Layout (renderer pane tree,
drag-resize, per-pane dots).

**Ruled: windows in a session group.**

## Object model

```
tab   = a tmux session GROUP,  named prcli-<slug>-<tabid>
pane  = one WINDOW (holds the process)
      + one MEMBER SESSION bound to that window (gives the xterm its own view)
xterm = one client attached to that member session
```

A one-pane tab is a group of size one: a single session, `session_group` empty —
byte for byte what the app creates today. **Splits are additive; nothing that
exists now changes shape.** That backward compatibility is the main practical
argument for this model over the alternatives.

Splitting a tab adds, to the existing group:

```
new-window   -t '=<founder>:' -e PRCLI_TAB_ID=<paneid> [command]
new-session  -d -t <group> -s prcli-<slug>-<paneid>
select-window -t '=prcli-<slug>-<paneid>:<index>'      # bind member -> window
```

then attaches a client to the new member at the renderer's size for that pane.

### Naming and identity

Member sessions are named `prcli-<slug>-<16 hex>` exactly like every session
today, so `decodeSessionName` is unchanged and the project-by-slug rule holds
for panes as it did for tabs. The group name is the founding member's session
name at the moment the group was created, because tmux offers no way to name a
group independently — `-t` takes a session or a group, and the group inherits
the founder's name. Measured: the name survives the founder's death and still
accepts new members.

**The group name is immutable, and its slug goes stale.** Measured: renaming the
founder does *not* rename the group. So after `moveToProject` renames every
member session to the new slug, the group name still contains the old one.

This matters because the group name is still a syntactically valid session
name: `isPrcliSession(groupName)` returns true and
`decodeSessionName(groupName).projectSlug` returns a plausible, wrong answer.
That is the failure mode this milestone is most likely to introduce.

So the rule is narrow and explicit: **exactly one field is ever read out of a
group name — the 16-hex id. The slug in it is never read for anything.**
Project membership is computed from the *member* session names, which do get
renamed.

**A tab's id is its founder pane's id**, the hex half of the group name. That is
stable across every rename, because `moveToProject` preserves the id and changes
only the slug. A one-pane tab has no tmux group; its tab id is simply its single
pane's id, which is the same value a group founded from that pane would carry.
So the identity is consistent whether or not a tab has ever been split, and
survives moving between projects in both cases.

Config stores the tab id, not the group name — a stored name would go stale on
the next move, while the id never does. The live group name is asked of tmux
when one is needed.

### Vocabulary

Today's `TabRecord` is, in this model, a **pane**. It is renamed `PaneRecord`,
and a thin `Tab` record wraps N panes with a layout tree.

**`PRCLI_TAB_ID` keeps its name.** It is on the wire, baked into the reporter
script, into `install.ts`'s `settings.json` entries, and into every currently
live session. Renaming it would stop roughly twelve live Claude sessions
reporting status until each was restarted. It identifies a pane; that is
documented at each definition rather than fixed by a rename.

The cost of this choice is that "tab" briefly means two things while the rename
lands. Every comment and identifier touched by this milestone must say which one
it means.

## Geometry

`window-size` is set to `manual` on each pane's **window**, and each pane's
window is sized explicitly:

```
set-option -w -t <windowId> window-size manual
resize-window -t <windowId> -x <cols> -y <rows>
```

on attach and on every renderer resize.

This is deliberately *not* left to `window-size latest`. Measured, `latest`
fixes a window's size when a client begins viewing it and did not promptly
resize on a later `select-window`. That is enough to work when each member is
pinned to one window and attaches once — and it is exactly the kind of
"works because of an incidental ordering" that has already shipped as an 80×24
defect twice. Manual sizing is deterministic and states the intent.

`window-size` is set with `-w` against a **window id**, not through a session
target and not once on the group. It is a window option (measurement table
above), and `set-option -t '=<name>:'` on a window option resolves to whatever
window that session is *currently showing* — which is a real target and, for a
freshly joined group member, the wrong one: its current window is a sibling's
until `select-window` binds it. The call then succeeds, sets a window that was
already set, and leaves the intended one on tmux's default. There is nothing
being propagated or shared to reason about; there is only a target that does not
name a window. A window id does, and needs no ordering to be right.

(The group name is not an option target at all once the founding session dies —
measured, `no such window` — which is a second, independent reason not to route
these through a name.)

`remain-on-exit` goes on the *window* the same way (`set-option -w`), which
measured as leaving a sibling pane's window untouched.

## Death, and the blocker this discharges

The shipped `pane-died` hook ends in `kill-session -t =<session>`. That is
correct when a session has one pane and wrong the moment it has two.

In this model the blocker largely dissolves: **a tab is no longer one session**,
so one pane dying can no longer take its siblings with it. Each window holds
exactly one pane, so no "is this the last pane" test is needed at all — which
matters, because the obvious form of that test does not work. Measured,
`#{window_panes}` still counts the dead pane under `remain-on-exit on`, so
`if window_panes == 1 then kill-session` never fires. Live panes have to be
counted with `list-panes -f '#{==:#{pane_dead},0}'`, and this design avoids
needing to.

The hook still changes. Killing only the member session leaks the window, which
stays in the group's shared window list holding a dead pane. So the hook reaps
both:

```
run-shell "<report>" ; kill-session -t =<member> ; kill-window -t <window>
```

Order matters, and is covered by finding 2 below: the member's client must be
gone before its window is, or the member falls back to a sibling's window and
two xterms render the same pane. When the dying pane is the tab's only pane,
`kill-window` takes the last window and every member with it — which is the
correct outcome, and is what happens today.

The cost of that order is that a tmux command list aborts at the first failure
(measured), so a `kill-session` that fails — a name gone stale after a move —
forfeits the `kill-window` behind it. `moveTabToProject` therefore reinstalls
each hook under the new name before it returns.

`deathHookCommand`'s guard applies unchanged to the added target, and it keeps
its all-or-nothing rule: a command it refuses means no `remain-on-exit` either,
so a refused hook costs a red dot and never a stray session.

## Pre-flight findings the implementation must not walk into

1. **`#{window_panes}` counts dead panes** under `remain-on-exit on` — measured
   2 after one of two panes was killed. Any last-pane test written that way
   never fires. This design needs no such test; the finding is recorded because
   the obvious implementation of the blocker fix reaches for it.

2. **A member whose bound window is killed falls back to a sibling's window** —
   measured, `g1` jumped to `@0` when its own window died. Two xterms then
   render the same pane. Member and window must be reaped together, and the
   member's client must be gone before its window is, or the fallback is
   briefly visible and — under any non-manual sizing — briefly resizes a
   sibling.

3. **A newly joined member's current window is arbitrary** (`@0` on every
   measurement). Attaching before `select-window` gives the new client a
   sibling's window, and under `window-size latest` it resizes that sibling.
   Bind first, attach second. This is the 80×24 geometry defect class in a new
   disguise, and the standing rule applies: assume any new attach path lacks
   the client's live geometry until proven otherwise.

4. **The `=name:` trailing-colon rule bit three times during these probes**, on
   `split-window`, `display-message`, `set-option` and `show-options`, each time
   producing a plausible-looking wrong answer (`can't find pane`, `no such
   window`, an empty format) rather than an obvious failure. Every new adapter
   method added by this milestone is window- or pane-scoped and therefore needs
   the colon. `rename-session`, `has-session` and `kill-session` take a session
   target and must not have it.

## Config v5

Orientation and drag ratios are not derivable from tmux, so they live in config
— order and selection, in the same sense the existing tab order is. What exists
is still decided by live tmux.

```jsonc
{
  "version": 5,
  "panes": [
    { "id": "…", "projectSlug": "…", "cwd": "…", "command": "…",
      "type": "shell", "tmuxSession": "prcli-…-…" }
  ],
  "tabs": [
    { "id": "<founder pane id, 16 hex>", "activePaneId": "…",
      "layout": { "dir": "row", "ratio": [0.5, 0.5], "kids": ["paneId", "paneId"] } }
  ]
}
```

**`layout.kids` is a flat list of pane ids — one axis per tab, never a tree**
(ruled 2026-07-31). A tab is a row *or* a column of N panes. `ratio` has one
entry per pane and sums to 1.

The design of record says "panes nest arbitrarily and resize by drag". That is
deferred, not dropped: nesting costs a recursive layout component, recursive
pruning with redistribution at every level, and two-dimensional drag-resize —
realistically doubling the renderer work — while split-right and split-down
cover how this app is actually used. **Nesting can be added later without
touching the tmux model at all**, because the model has no opinion about
arrangement: every pane is a window plus a member session however the renderer
chooses to lay them out. It is purely a config-shape and renderer concern.

`id` is the founder pane's id — see §Naming and identity for why the group name
itself is not stored.

**A drag writes config once, on mouse-up** (ruled 2026-07-31). Ratios live in
renderer state during the gesture and `resize-window` fires live, so the pane
reflows under the cursor; only persistence waits. Throttled writes during a drag
would push several writes a second through the `serialise` queue, which is shared
with restore and the exit handler.

`migrate` gains a v4 branch: every v4 `tabs[]` row becomes a `panes[]` row plus
a single-pane `tabs[]` row whose layout is that one leaf. This is lossless — a
v4 tab genuinely is a one-pane tab. `write()`'s refusal to overwrite a newer
version on disk is unchanged and now matters more, because a v4 build reading a
v5 file would drop every split.

Reconcile prunes: a layout leaf whose pane has no live session is removed and
its ratio redistributed; a tab whose panes have all gone is dropped.

## Status

Per-pane status is unchanged from M3 — same hooks, same socket, same
`PRCLI_TAB_ID`, same inbox queue. What is new is aggregation: a tab's dot is the
worst state among its panes, and a project row is the worst among its tabs,
using the severity order already in `shared/status.ts`
(`crashed` > `waiting` > `thinking` > `running` > `idle` > `unknown`).

The tab bar entry gains the `⊞n` badge the design of record specifies.

## Change set by file

- **`tmux/names.ts`** — unchanged for member names. Adds group-name helpers
  (a group name *is* an encoded session name, so this is mostly type-level).
- **`tmux/adapter.ts`** — `newWindow`, `killWindow`, `selectWindow`,
  `resizeWindow`, and a `listSessions` variant returning `#{session_name}` with
  `#{session_group}`. All window-scoped, all with the trailing colon.
- **`sessions/manager.ts`** — `TabRecord` → `PaneRecord`; `open()` either founds
  a group or joins one; `findOrphans` reassembles tabs by `session_group`, with
  an empty group meaning a one-pane tab. **`moveToProject` becomes a per-tab
  operation**: it must rename *every* member session, not one. Renaming a single
  member of a split tab would split the tab across two projects, since project
  membership is per member session name. Its existing guarantees carry over
  unchanged — rename before touching any client, a refused rename changes
  nothing — but they now have to hold across N renames, so a partial failure
  mid-way needs a defined outcome rather than whatever falls out.
- **`pty/session.ts`** — bind-then-attach ordering; manual window sizing;
  `resize` drives `resize-window` as well as the client.
- **`pty/deathHook.ts`** — adds `kill-window` before `kill-session`, guard
  extended to the new target, ordering per finding 2.
- **`state/store.ts`** — v5, the v4→v5 migration above.
- **`ipc/restore.ts`** — restores panes, rebinds members to windows, prunes dead
  leaves.
- **`ipc/register.ts`** — per-pane IPC; split/close-pane commands.
- **`renderer/App.tsx`, `TabBar.tsx`, `Terminal.tsx`** — pane tree, one xterm per
  pane, drag-resize writing ratios, `⊞n` badge, worst-state aggregation.

## Test plan

**Unit.** Layout tree operations (split, close, ratio redistribution, pruning a
dead leaf); v4→v5 migration including the lossless single-pane case and refusal
of a v6 file; `deathHookCommand` with the added target, including a refused
command still disabling `remain-on-exit`; worst-state aggregation across panes
and across tabs.

**Integration, real tmux on `-L prcli-test`.** Found a group and add a second
pane; assert two members, two windows, `session_group` on both, and each pane's
`PRCLI_TAB_ID` reaching its own process. Kill one pane's process and assert the
sibling survives with its client intact — this is the blocker, and it must fail
against the current hook. Assert window and member are both gone afterwards.
Kill the founder member and assert the tab is still reassembled from the group.
Assert independent per-window sizes after explicit `resize-window`. Move a split
tab between projects and assert every member was renamed, the tab lists under
the destination, and it still lists correctly *despite* its group name retaining
the source slug — the stale-slug trap from §Naming and identity.

**E2E.** Split a tab, assert two panes render; crash one and assert a red dot on
that pane, the tab dot going red by aggregation, and the sibling still live.

**A/B every load-bearing assertion.** Per the standing rule: sabotage the
production code and watch each new test fail. The blocker test in particular is
worthless unless it fails against today's `kill-session` hook, and three tests
were found to be passing against broken code this way earlier today.

## Done when

- A tab splits, both panes run independently, and each reports its own status.
- A crashed split shows a red dot on that pane and leaves its siblings running —
  the blocker, verified against a real tmux session.
- A crashed or closed pane leaves no window and no member session behind;
  `tmux ls` shows what it shows today.
- Closing the last pane closes the tab.
- Relaunch restores splits with their orientation and ratios, and reattaches
  every pane at the renderer's size — no pane wrapped at 80 columns.
- A v4 config opens with every tab intact as a one-pane tab.
- A session created outside the app is still adopted as a one-pane tab.

## Out of scope

Detach-a-pane-to-its-own-tab, and dragging a pane between tabs. Both are
reasonable and neither is needed to call splits done; both are listed in the
design of record's context menu and are deferred rather than dropped.

Letting a preset declare `type: 'claude'` in `.prcli.json`, parked from M3, stays
parked — it changes a user-facing surface and belongs in its own plan.

## Plan 2 rulings (2026-07-31, after plan 1 merged)

- **Layout is one axis per tab, not a tree.** See §Config v5. Nesting deferred,
  and deferrable because the tmux model has no opinion about arrangement.
- **A drag writes config once, on mouse-up.** See §Config v5.
- **`awaitWindowId` stops returning `''` for three different things.** It returns
  a discriminated result instead:

  ```ts
  type WindowLookup =
    | { kind: 'found'; id: string }
    | { kind: 'gone' }        // tmux says no such session — nothing to hook, nothing to leak
    | { kind: 'unreachable' } // tmux would not answer — do NOT read this as 'gone'
  ```

  Today every failure collapses to `''`, so a tmux that will not answer is
  indistinguishable from a session that has genuinely gone, and a tab can end up
  with neither `remain-on-exit` nor a hook while nothing reports it. This closes
  the hole the plan-1 fix wave documented rather than fixed, and it unblocks
  cancellation for the poll — which could not be added while `''` already meant
  two things.

## Known gaps carried in

- The E2E suite is intermittently flaky under load — roughly three of ten full
  runs failed today, each in a different test, each passing alone straight
  after. Failures track wall-clock and load average, not logic. Not papered over
  with retries; splits will add E2E surface to an already-flaky suite, so the
  cheap experiment (quit everything heavy, run the suite idle) is worth doing
  before reading any new flake as a splits defect.
- No linter. `typescript-eslint` cannot run against TypeScript 7; `oxlint` needs
  an `npm install`, which breaks node-pty's spawn-helper permissions.
- The visual pass owed from M3 — ⌥⌘1 on a real keyboard, M2a's I3, M2b's I3 —
  is still owed, and splits need their own visual pass on top.

## Environment rules for this work

`-L prcli-test` and `PRCLI_TMUX_SOCKET` only; never the default socket. Capture
`tmux ls` before and re-verify after. Never a bare `kill-server`.
`PRCLI_CONFIG_DIR`, `PRCLI_PROJECTS_ROOT` and `PRCLI_CLAUDE_SETTINGS` set in
every test that could reach the real ones — the last is read by roughly twelve
live Claude sessions. Never run `npm install`/`npm ci` casually: it breaks
node-pty's spawn-helper permissions and fails all integration tests with
`posix_spawnp failed`.

## Plan 2b rulings (2026-08-01, after plan 2a merged)

Plan 2a shipped the model headless: a split tab survives a relaunch with its
axis, ratios and selected pane. **Nothing can create a split from the UI** —
`splitTab` has no IPC, no keybinding and no menu item, and its only callers are
tests. Plan 2b's job is to make a split visible and usable.

### Scope

**2b:** split/closePane IPC; `RestoreResult` carrying tab rows; the renderer
pane tree; focus; ⌘W; per-pane death; worst-state aggregation.
**2c:** drag-resize, the `⊞n` badge, E2E.

**Worst-state aggregation moved from 2c into 2b.** With splits visible and no
aggregation, a split tab's tab-bar dot shows its founder pane's state, so a
crashed second pane leaves the tab looking green. That is not missing polish, it
is a dot that lies — on a tool whose purpose is saying which of a dozen sessions
needs attention. The severity order already exists in `shared/status.ts` and M3's
registry already tracks per-pane state, so this is a fold over a tab's panes and
the same fold over a project's tabs.

### Focus

**Click, plus ⌘⌥←/→/↑/↓ to move directionally.** The parent design specifies
⌘D / ⇧⌘D to split and ⌘W to kill a pane but never says how a pane is *selected*,
and with two panes on screen something must decide which receives keystrokes.

Directional rather than cycling because one axis per tab makes direction
unambiguous — the property the one-axis ruling was made for. ⌘-chords rather
than ⌥ or ctrl because every keystroke this app does not intercept goes into a
terminal where Claude and the shell already claim most of the keyboard; on macOS
terminals do not consume ⌘.

The selected pane is `TabRow.activePaneId`, which config already carries.

### A pane that dies stays until it is dealt with

**A dead pane keeps its place in the layout, red, until restarted or dismissed.**
It does not collapse and let its siblings take the space.

The reason is scrollback: when a pane dies the thing you need is what it printed
just before, and collapsing it discards exactly that at the moment it matters. It
also keeps one mental model — a dead pane behaves like today's dead tab.

This diverges from restore, where `normaliseLayout` prunes a pane whose session
is gone and redistributes its ratio. That is correct and not a contradiction: a
pane dead *in this session* still has a window, a preserved dead pane and
scrollback to read, while a pane missing at restore has nothing left to show.

**This makes carried finding I4 live, so it must be fixed in 2b.** `restartTab`
recreates a pane with a bare `new-session -A` and no `-t <group>`, so restarting
a pane inside a split resurrects it *outside* its tab's group and silently
un-splits the tab. It is inert today only because nothing can split from the UI.

### Renderer state: flat panes plus a parallel tab index

`state.panes: TabDescriptor[]` and `state.tabs: TabRow[]` — the same shape config
v5 uses, rather than nesting panes inside tabs.

One shape end to end (config, IPC payload, renderer state) means no translation
layer and no second place for the tab-versus-pane distinction to drift. That
distinction has already produced a `forgetTab` that pruned the wrong array while
type-checking cleanly, and a tab row named after a pane id instead of the group's
frozen id. Flat pane lookups also leave the existing reducer actions —
`activatedTab`, `died`, `statusChanged`, `removed`, `movedTab` — working with a
rename rather than a nested search, and they are the actions with coverage today.

The cost is two arrays to keep consistent. **Main's payload is authoritative and
the renderer never invents membership**: `normaliseLayout` already drops kids
naming panes that do not exist and `tabRows` already dedupes cross-row claims.

### What must not regress

`App.tsx` keeps every terminal mounted across every project — unmounting
disposes the xterm and loses scrollback — and toggles `visibility`, not
`display`, so a hidden pane stays laid out and can measure itself. A hidden pane
measuring 0×0 would resize its real tmux session to nothing. **Both properties
survive splits:** every pane of every tab stays mounted, and only the current
tab's panes are visible and arranged along the axis.
