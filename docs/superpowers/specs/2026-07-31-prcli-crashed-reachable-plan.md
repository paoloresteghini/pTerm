# Follow-up: make `crashed` reachable

**Status:** implemented on `crashed-reachable`, TDD throughout, not merged
**Ruling it discharges:** M3 merged at 05328ab with `crashed` unreachable and its
"stays put, **red**" acceptance criterion knowingly unmet. See `todo.md`.

## The defect

`stateForExit(code)` returns `crashed` for a non-zero code, and nothing ever
hands it one. Measured three times, most recently on tmux 3.7b:

| Probe | Result |
| --- | --- |
| default `remain-on-exit off`, inner command `exit 3` | attached client exits **0**, session gone |
| `remain-on-exit on`, inner command `exit 3` | session **survives**, `pane_dead=1`, `pane_dead_status=3` |
| `pane-died` hook under `remain-on-exit on` | **fires**, and `#{pane_dead_status}` expands inside the hook's own command |
| attached client while its pane dies under `remain-on-exit on` | client **stays attached**; `list-clients` still 1 |
| `respawn-pane -k` on a dead pane | revives in place, `pane_dead` → 0, client survives |

So the exit status is reachable only through a dead pane, and a dead pane means
the client no longer exits — which is the whole difficulty.

## Shape (ruled 2026-07-31): report, then kill

At session creation, turn `remain-on-exit` on and install a `pane-died` hook
that reports the status and then kills the session. tmux does the kill, not the
main process — so from `manager.onExit` downwards **every path behaves exactly
as it does today**: reason `exited`, `sessionAlive` false, the renderer marks
the tab dead, `forgetTab` prunes the row.

Two shapes were rejected:

- **Dead pane lingers** (no kill). Sets `crashed` once with nothing able to
  clobber it, and would let status survive a relaunch via `#{pane_dead_status}`.
  Rejected: dead sessions accumulate on the tmux server until dismissed — the
  stray-session failure M2a already hit — and it moves restore, restart and kill.
- **Wrap preset commands** in `sh -c '<cmd>; prcli-hook exit $?'`. Cheapest, but
  covers only presets, and still needs the same no-downgrade rule below.

## Pre-flight findings — three constraints the obvious implementation breaks

1. **Main must not reap with a `killed` intent.** `App.tsx:148` returns early on
   `reason === 'killed'`, so a main-side kill would stop the tab being marked
   dead at all. Letting the tmux hook do the kill keeps the reason `exited` and
   sidesteps this entirely — this is the main reason the ruled shape kills from
   inside tmux rather than from `register.ts`.
2. **The code-0 client exit still follows the death and would clobber it.**
   Ordering is genuinely racy: the hook's socket write is backgrounded (`&` in
   the script, because Apple's `nc` does not exit when the server closes) while
   `kill-session` runs immediately after. If the death event lands first,
   `applyExit(0)` overwrites `crashed` with `ended`. If the kill wins the race,
   `ended` lands first and `crashed` corrects it — right answer, two toasts.
   Needs a no-downgrade rule, which is required for one order and harmless in
   the other.
3. **The reporter script is written only by `installHooks()`** (`install.ts:405`)
   and deleted by `uninstallHooks()` (`:419`). Wiring `pane-died` to it would
   make the red dot for a crashed `npm run dev` depend on the *Claude* hooks
   gesture, and vanish when the user uninstalls them. The script must be written
   unconditionally at startup instead.

## Change set

1. **`install.ts`** — split writing the script from editing settings.json.
   Export `writeScript()`; `installHooks()` calls it, `uninstallHooks()` stops
   deleting the script (it deletes only the settings.json entries).
2. **`index.ts`** — call `writeScript()` at startup, beside the existing
   `mkdir(hookPaths().dir)` at `:269`. The reporter then exists for every tab
   regardless of whether Claude hooks are installed.
3. **`renderScript()`** — accept an optional second argument, the exit status,
   and emit `{"tabId":…,"event":"Exit","status":N,"at":…}` when present. The
   existing Claude call sites pass one argument and are unchanged byte for byte.
4. **`protocol.ts`** — `parseHookLine` returns a discriminated union: today's
   `HookEventMessage`, plus `{kind:'exit', tabId, status, at}`. `status` must be
   a finite non-negative integer; anything else is dropped like any other
   malformed line. This is still the app's only untrusted input.
5. **`PtySession.start()`** — chain two more tmux commands after the existing
   `set-option status off`:
   - `set-option remain-on-exit on`
   - `set-hook pane-died` running the reporter with the literal tab id (known
     here — it is `options.env.PRCLI_TAB_ID`, so no `#{}` substring games) and
     `#{pane_dead_status}`, then `kill-session -t =<name>`.
   Unlike `-e`, these are chained *commands* rather than arguments to
   `new-session`, so — corrected during implementation — they do run on the
   adopt path. That is a feature: a session created by an older build gets the
   wiring the moment it is reattached.
6. **`registry.ts`** — `applyDead(tabId, status, tab?)` sets `stateForExit(status)`
   and records that this id has an authoritative verdict; `applyExit` returns
   early when a verdict is already recorded. `applyOpen` and `forget` clear it,
   so a restarted tab under the same id starts clean.
7. **`register.ts`** — subscribe to the new message kind and call
   `applyDead`. No change to the existing `manager.onExit` handler.

## Done when

- A preset whose command exits non-zero shows a **red** dot, not grey, and the
  tab stays put with its restart affordance.
- A tab whose command exits 0 still shows grey `ended` — unchanged.
- Killing a tab with ⌘W still shows no dead tab and no toast.
- No tmux session survives its pane's death: `tmux ls` after a crash shows what
  it shows today.
- A tab with the Claude hooks *uninstalled* still reports a crash.
- Both orderings in finding 2 are covered by a test, not just the likely one.

## Test plan

Unit: `stateForExit` already covered; add `applyDead` + the no-downgrade rule
(both orderings), `parseHookLine` accepting the new kind and rejecting a
negative / fractional / absent status, `renderScript` with and without a status.
Integration: a real tmux session on `-L prcli-test` whose command exits 3,
asserting the registry lands on `crashed` **and** that the session is gone
afterwards. E2E: extend `status.spec.ts`'s "a dead tab lingers, then restarts"
with a crashed sibling asserting the red dot.

## Found while implementing

- **A fourth pre-flight finding, caught in self-review rather than by a test.**
  The first version embedded the reporter path in the hook command behind a
  comment claiming `renderScript` already refused unsafe paths. It does not:
  `UNSAFE_IN_PATH` covers the *socket* and *spool* paths, not the script's, and
  its charset contains no single quote — the exact character that would end the
  quoting. The string is re-parsed by tmux and then by `/bin/sh`, and `#` opens
  a tmux format expansion. Extracted to `deathHookCommand` with its own guard
  (`['"$`\\\n#]`), a tab-id shape check, and ten unit tests. It returns null
  rather than a half-escaped command, and `remain-on-exit` is only set when a
  command survives the guard — the two go on together or not at all, or a
  refused hook would leave every ordinary `exit` as a stray session.
- **Spooled `Exit` lines are dropped rather than replayed.** A tab that died
  while the app was down has no session left, so reconcile has already pruned
  its row and the existing membership check drops the line anyway. The only
  states the branch could otherwise reach are wrong ones (an id reopened since
  would be painted red for a life that already ended, and the verdict would
  then outrank how the new one really ends).

## Known gaps, deliberately left

- **A pane killed by a signal reports nothing.** `#{pane_dead_status}` is empty
  when `#{pane_dead_signal}` is set, so the script sends an `Exit` with no
  status, the parser refuses it, and the tab falls back to the client-exit path
  and shows `ended`. Segfaults and OOM kills therefore still read grey. The fix
  is to pass the signal as well and decide what it maps to.
- **The hook kills the whole session when any pane dies.** Correct today, when
  every session has exactly one pane. Milestone 2c is splits, and this becomes
  wrong the moment a session has two panes — one crashed split would take the
  tab down with it. 2c has to revisit this, and this is a good reason to plan
  it before 2c rather than after.
- **The one-off E2E flake seen during this work** was `app.firstWindow()`
  timing out in the run that had just rebuilt the package — a launch flake, not
  a logic failure. Two full 32/32 runs since. Recorded rather than fixed.

## Environment rules for this work

`-L prcli-test` and `PRCLI_TMUX_SOCKET` only; never the default socket (one live
irreplaceable session, `prcli-scratch-d44d959949ebc3ae`). Capture `tmux ls`
before and after. Never a bare `kill-server`. `PRCLI_CONFIG_DIR`,
`PRCLI_PROJECTS_ROOT`, `PRCLI_CLAUDE_SETTINGS` set in every test that could
reach the real ones — the last is read by ~12 live Claude sessions.
