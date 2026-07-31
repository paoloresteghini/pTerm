# PRCLI Milestone 3 — Awareness: Hook Bridge, Status and Notifications

**Date:** 2026-07-30
**Status:** Approved, pre-planning
**Parent spec:** `docs/superpowers/specs/2026-07-30-prcli-design.md` — the design of record. This document refines it for one milestone and does not supersede it.
**Builds on:** Milestone 2b (`docs/superpowers/plans/2026-07-30-prcli-m2b-projects.md`), merged to `master` at `2354c98`.

## Goal

Know, without looking, which of twelve sessions is blocked on you.

## Where this starts

M1, 2a and 2b delivered many tmux-backed tabs in one window, grouped under projects in a sidebar, with per-project presets and an Unsorted bucket, all restored from live tmux and surviving quit, relaunch and ⌘R. What none of it has is any notion of what a session is *doing*. 2b deliberately shipped no status model, on the reasoning that a dot which can only ever say `unknown` trains you to ignore the affordance this milestone needs you to trust.

That reasoning is discharged here: this milestone builds the thing that makes a dot mean something.

## Scope

In:

- `prcli-hook`, a POSIX shell script installed to `<configDir>/bin/`
- A Unix-socket hook server in the main process, with a spool file for events that arrive while the app is down
- Install and uninstall of PRCLI's entries in `~/.claude/settings.json`, behind an explicit gesture that shows the diff first
- The state machine, severity aggregation, and dead-tab handling
- Status dots in the tab bar and sidebar, a "Needs you" list, and Restart / Dismiss for a dead tab
- The notification rules engine, toasts with click-to-focus, sounds, dock badge, `muteWhenFocused`
- A settings pane: one row per state, plus a per-project mute
- Config v4: `tabs[].type` and a `notifications` key
- An ESLint config, so `npm run lint` runs for the first time

Out, with reasons:

- **Splits.** Milestone 2c. Aggregation is written so panes cost nothing to add: a tab will take the worst of its panes exactly as a project takes the worst of its tabs.
- **Quiet hours.** The field ships in the schema and the rules engine honours it; there is no editor for it. One user, no night shift.
- **A faithful editor for the whole rules array.** The engine supports the design's later-wins, project-scoped rules and hand-editing `config.json` reaches all of it. The pane exposes the two axes actually wanted: per-state defaults, and mute-this-project.
- **The skills panel and ⌘K.** Still unscoped, still need their own sourcing design. Untouched here.
- **Status for sessions attached from outside the app.** They resolve to `unknown` and render hollow, as the parent spec specifies.

## Decisions

### The state machine lives in the main process

Notifications, sounds and the dock badge are all main-process concerns and all need state. Putting the machine in the renderer would mean shipping every event back over IPC for main to act on, and would blank the board on ⌘R. Main owns a `StatusRegistry` keyed by tab id; the renderer receives a `status` event and holds a derived map for rendering only.

### Hooks decide state; a stored `type` only declares intent

`TabRecord` and `TabDescriptor` gain `type: 'claude' | 'preset' | 'shell'`. It drives the launch command and lets the right panel tell a preset from a shell — and nothing else. In particular it does not gate status.

**Every** tab gets `PRCLI_TAB_ID` in its environment regardless of type, because the way this app is actually used is to open a tab and type `claude` into it. A `shell` tab someone runs `claude` in gets full status the moment its first hook arrives, and behaves identically to a `claude` tab thereafter. Nothing about a tab's declared type can make a real Claude session invisible.

A `claude`-type tab that has produced no events yet renders a hollow dot rather than nothing, so a broken hook install is visible instead of silent. That is the only behaviour `type` buys.

The id is stable across relaunch — it is the second half of the tmux session name — so a session created by a previous run reattaches with a correct `PRCLI_TAB_ID` already in its shell's environment.

### `PRCLI_TAB_ID` reaches the session at creation, and only then

`PtySessionOptions` already declares `env`; `SessionManager.open` has never passed it. Threading it is a two-line change, but the semantics matter: tmux gives a session the client environment it was *created* with. A reattach does not update it, which is correct — the shell inside already has the value, and it is the same value.

A pane created inside the session from a plain terminal later (`tmux new-window` from Ghostty) may not inherit it. That session resolves to `unknown`, which is the honest answer.

### The hook sends an event name, never a payload

Each subscribed event gets its own entry in `settings.json`, with the event name passed as an argument: `prcli-hook UserPromptSubmit`. The script discards stdin entirely.

Two reasons, both concrete. `PostToolUse` payloads carry tool output and can be large; concurrent large appends to one spool file can interleave and corrupt it, while a fixed-shape one-line record cannot. And parsing Claude's JSON in shell without `jq` — which is not guaranteed present — means grep and sed against a payload shape that is free to change. The state machine needs the event name and nothing else, so the hook should carry nothing else.

The wire record is `{"tabId":"…","event":"…","at":<epoch ms>}`.

### The hook backgrounds its write, because Apple's `nc` will not exit

Probed on this machine, not assumed:

- `/usr/bin/nc` supports `-U` and delivers to a Node `net` Unix socket correctly.
- Apple's `nc` has **no `-q`**, and its `-N` means "number of probes", not "shutdown on EOF".
- It does **not** exit when the server closes the connection. A foreground write hangs until `-w` fires — a full second with `-w 1`, measured.
- Backgrounding the write returns control in **3ms** with delivery confirmed.

A hook that costs a second, seven times a turn, across twelve sessions, is not acceptable — and `PreToolUse` blocks Claude. So the script backgrounds the write in a subshell and returns immediately:

```sh
{ printf '%s\n' "$line" | nc -U -w 2 "$SOCK" 2>/dev/null || printf '%s\n' "$line" >> "$SPOOL"; } &
exit 0
```

`-w 2` bounds a wedged server. The `||` fallback runs inside the same background subshell, so a failed write still spools without the foreground waiting to find out. The script exits 0 unconditionally, on every path.

### Events that arrive while the app is down are spooled and replayed

A session sitting in `waiting` is, by definition, doing nothing that would fire another hook. Without a spool it would render hollow after every relaunch — indistinguishable from dead, and precisely the signal this app exists for.

`prcli-hook` appends to `<configDir>/hook.spool` whenever the socket write fails. At launch the app **renames the file aside and reads the renamed copy**, rather than reading then truncating: a backgrounded hook can append between those two steps, and truncation would swallow it silently. The rename is atomic and a hook appending to the old inode after it simply loses one event it was already going to lose.

Replay runs **after** `restoreWorkspace` has reconciled against live tmux, so events for tabs tmux no longer has are discarded rather than resurrecting dots for dead sessions.

Entries older than 24 hours are discarded unread. The file is capped at 4096 lines — roughly a day of seven events across twelve sessions, and a few hundred kilobytes at this record size; past the cap the oldest are dropped, since the newest describe the present.

Order is append order, which is chronological. Duplicates are impossible: an event spools only when its socket write failed.

### Installing into `~/.claude/settings.json` is an explicit gesture

The hook goes in the **global** settings file, so it fires for every Claude session on the machine, including ones started outside PRCLI. That is harmless by design — no `PRCLI_TAB_ID`, or no socket, means `prcli-hook` exits 0 having said nothing — but it is a real edit to a live file that every session reads.

A Settings row shows `Claude Code hooks: installed / not installed` with Install and Uninstall. Install renders exactly what will be added, then writes a timestamped backup, then merges. Nothing touches the file until the button is pressed.

`merge(settings, hookPath) → { next, added }` is a pure function, so the diff shown and the bytes written come from the same call and cannot disagree.

**The real file this must not break.** Inspected on this machine: `~/.claude/settings.json` already holds twelve top-level keys and five of the seven events PRCLI subscribes to. `PreToolUse` carries a `matcher: "Bash"` entry; `SessionStart` and `Stop` each hold **multiple** groups. So the merge appends one new group object to each event's array and edits no existing element, ever. PRCLI's own `PreToolUse` entry carries no matcher, so it sees every tool.

Uninstall removes only groups whose single hook command is PRCLI's own script path, and leaves an event's array in place if anything else remains in it.

### Default rules ship with sound off

The design's defaults are `waiting → Funk`, `idle → Glass`, `crashed → Basso`. On this machine those first two would double-fire: `~/.claude/settings.json` already runs `afplay /System/Library/Sounds/Funk.aiff` on `Notification` and `Glass.aiff` on `Stop`.

So the shipped defaults are toast-only, `sound: null` on every rule, and the settings pane offers the sound pickers unset. The install screen additionally warns when it finds an existing `afplay` hook on an event PRCLI subscribes to, naming it, so the collision is visible rather than discovered by ear.

### A dead tab lingers instead of vanishing

Today `App.tsx` dispatches `removed` on any exit with `sessionAlive: false`, so a crashed `npm run dev` disappears and tells you nothing. As it stands `crashed` is a state that can never be rendered.

A tab whose tmux session dies stays in the bar with its scrollback readable: red for a non-zero exit, dim for a clean one. It offers **Restart** — `open` with the same id, cwd, command and type, which recreates the session under the same name — and **Dismiss**.

These tombstones are renderer-side only. Main already forgets the record on exit and config is written from live state, so a dead tab never reaches disk and a relaunch prunes it exactly as it does today. No persistence, no dismissed flag, no migration.

### `Notification` means `waiting`, both times it fires

Claude fires `Notification` for a permission prompt and again after roughly sixty seconds idle at the input. Both genuinely mean *you are the blocker*, so both are correctly `waiting`. This is written down because it looks like a bug the first time it is read.

## Data model

Config v4:

```ts
interface PrcliConfig {
  version: 4
  projects: ProjectRecord[]      // unchanged from v3
  activeProjectId: string | null
  tabs: TabRecord[]              // gains `type`
  notifications: NotificationConfig
}

interface TabRecord {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  tmuxSession: string
  type: 'claude' | 'preset' | 'shell'
}

interface NotificationConfig {
  rules: Rule[]
  muteWhenFocused: boolean
  quietHours: null | { from: string; to: string }   // honoured, no editor
}

interface Rule {
  on?: TabState                  // absent matches every state
  project?: string               // project id; absent is global
  toast?: boolean
  sound?: string | null          // a macOS system sound name
  urgency?: 'low' | 'high'
}
```

Migration v3 → v4 assigns `type: 'preset'` to a tab carrying a `command` and `'shell'` otherwise, and installs the default `notifications` block. It cannot know that a v3 tab was running Claude — but it does not need to, because hooks decide.

A v4 file missing or malforming `notifications` is tolerated rather than rejected, the same way `normaliseProject` already tolerates a project row missing its optional arrays: the defaults are substituted and the rest of the file is kept. Losing every open tab because a rules array was hand-edited badly is not a trade `read()`'s never-throws contract permits.

`migrate()` gains element validation for `tabs`, closing the carried-forward hole where `tabs: [null]` defeats `read()`'s never-throws contract by way of `restore.ts`. Project rows have been validated since v3; this brings tabs to the same standard while the function is open anyway.

State, and the severity order aggregation uses:

```
crashed > waiting > thinking > running > idle > ended > unknown
```

Claude tabs: `unknown → idle → thinking → waiting`, per the parent spec's diagram — `Notification` is the only edge into `waiting`, and any other event leaves it. Non-Claude tabs: `running → ended | crashed`, from the exit code.

A project row takes the worst of its tabs. When splits land in 2c, a tab takes the worst of its panes and nothing else about this changes: every pane is already its own tmux session in the same id space.

## Architecture

### Main process

| Module | Responsibility |
|---|---|
| `src/main/hooks/server.ts` | Unix socket at `<configDir>/hook.sock`; one JSON line per event |
| `src/main/hooks/spool.ts` | Drain, age-filter and replay `<configDir>/hook.spool` |
| `src/main/hooks/install.ts` | Pure merge/unmerge of `~/.claude/settings.json`; backup; script installation |
| `src/main/status/machine.ts` | Pure. `(state, event) → state`, and `worst(states)` |
| `src/main/status/registry.ts` | State per tab id; emits transitions |
| `src/main/notify/rules.ts` | Pure rule resolution `(rules, transition, context) → outcome` |
| `src/main/notify/router.ts` | Electron `Notification`, `afplay`, `app.dock.setBadge` |
| `src/main/sessions/manager.ts` (modify) | Pass `env` through to `PtySession`; carry `type` on the record |
| `src/main/state/store.ts` (modify) | Config v4, migration, tab element validation |
| `src/main/ipc/restore.ts` (modify) | Replay the spool after reconcile |
| `src/main/ipc/register.ts` (modify) | The new channels below |

`server.ts` trusts nothing on the wire: an unknown `tabId`, an unrecognised event name, a malformed line and an over-long line are all dropped without a throw. It is reachable by anything on the machine that can open the socket, so it behaves like a parser of hostile input even though in practice it is not.

**Socket path length.** macOS caps `sun_path` near 104 bytes. A deep `PRCLI_CONFIG_DIR` — plausible in a temp directory under CI — fails as an obscure `EINVAL`. The server checks the length up front and reports it plainly.

**New IPC:** `status()` returning the current map, an `onStatus` event, `restartTab(id)`, `dismissTab(id)`, `hooksState()`, `installHooks()`, `uninstallHooks()`, `updateNotifications(patch)`.

Everything that writes config goes through `register.ts`'s existing `serialise` queue, which has no reentrancy protection: nothing reached from inside it may call `serialise`. Spool replay runs inside restore, which is already inside the queue, so replay must not write config itself — it only feeds the registry, and the registry persists nothing.

### The hook script

Installed to `<configDir>/bin/prcli-hook`, mode 0755, rewritten on every install so an upgrade cannot leave an old copy behind. Roughly twelve lines of POSIX shell: compose one line, background the write with the spool fallback, `exit 0`.

It hardcodes the absolute socket and spool paths at install time rather than reading an environment variable, because the hook runs in Claude's environment, not the app's — and that is also what lets a test install one against a temp directory.

### Renderer

| Component | Responsibility |
|---|---|
| `src/renderer/StatusDot.tsx` | One dot, one state; the only place colour maps to state |
| `src/renderer/NeedsYou.tsx` | Pinned sidebar list of every tab in `waiting` or `crashed` |
| `src/renderer/SettingsPane.tsx` | Hook install row, per-state notification rows, `muteWhenFocused` |
| `src/renderer/ui/Dialog.tsx` (reuse) | Hosts the settings pane; the Radix dialog 2b already installed |
| `src/renderer/Sidebar.tsx` (modify) | Dots on tab rows, aggregated dot and mute toggle on project rows |
| `src/renderer/TabBar.tsx` (modify) | Dots; dead-tab affordances |
| `src/renderer/workspace.ts` (modify) | `status` map, and dead-tab tombstones in the reducer |
| `src/renderer/App.tsx` (modify) | Subscribe to `onStatus`; stop removing dead tabs unconditionally |

Settings opens from the `⚙ Settings` row the parent spec's layout already puts at the foot of the sidebar, and from ⌘, — the macOS convention, and free of collisions with the bindings 2b claimed.

Dot colours follow the parent spec: grey `idle`, blue `thinking`, amber `waiting`, green `running`, red `crashed`, hollow `unknown`, dim grey `ended`.

The dock badge counts tabs in `waiting`. The "Needs you" list shows `waiting` and `crashed` — the two states that mean a human is required — and clicking an entry selects that project and that tab.

`muteWhenFocused` suppresses a toast when the window has focus *and* the transitioning tab is the active tab of the active project. A background tab going `waiting` still toasts while the window is focused, which is the common case at twelve sessions.

## Also folded in

`npm run lint` has never run. There is no `eslint.config.*` anywhere, and the script still passes `--ext`, removed in ESLint 9 — so three milestones have shipped with no lint gate at all. That is why `lucide-react` sits in `dependencies` imported nowhere.

This milestone adds a shell script, a socket protocol and a rules engine. Task 0 is a flat config using the `@typescript-eslint` and `eslint-plugin-import` packages already installed, a fixed `lint` script, and dropping `lucide-react`.

## Failure handling

| Failure | Behaviour |
|---|---|
| App not running when a hook fires | Written to the spool; replayed at next launch |
| Socket present but server wedged | `-w 2` bounds the write; then spooled |
| `nc` missing or refusing `-U` | Write fails, event spools, hook still exits 0 |
| Spool grows unbounded | Capped by size; oldest dropped. Entries over 24h discarded on drain |
| Spool event for a tab tmux no longer has | Discarded on replay — reconcile runs first |
| Malformed or hostile line on the socket | Dropped; server does not throw |
| `PRCLI_CONFIG_DIR` too deep for `sun_path` | Reported plainly at startup, not as `EINVAL` |
| `~/.claude/settings.json` malformed | Install refuses and says so; nothing is written |
| Settings already contains PRCLI's entries | Merge is idempotent; install is a no-op |
| An `afplay` hook already bound to a subscribed event | Named on the install screen as a sound collision |
| Uninstall when the user has added their own hooks | Only PRCLI's own groups removed; the arrays survive |
| A Claude tab whose hooks never fire | `unknown`, hollow dot; never a guessed state |
| tmux session dies | Tab lingers as dead with Restart / Dismiss; nothing reaches config |
| Restart of a dead tab | Same id, cwd, command and type; new tmux session under the same name |
| Notification fired for a tab that has since gone | Resolved against the live map at fire time; dropped if absent |

## Testing

**Unit** — the state table exhaustively, every event against every state; `worst()` across the full severity order; rule resolution, later-wins ordering and project-scoped override; `muteWhenFocused` and quiet-hours predicates; `merge`/`unmerge` against a fixture modelled on the real `settings.json`, including an event holding multiple groups and a `PreToolUse` carrying a matcher; idempotency of a second install; the v3 → v4 migration; `tabs: [null]` surviving `read()`.

**Integration** — a real Unix socket, a real spool file, and `prcli-hook` **executed as a subprocess**, which is the only way to test that it exits 0 and does not block: assert it returns in single-digit milliseconds, that the line arrives, and that it spools when no server is listening. Real tmux on `-L prcli-test` for `PRCLI_TAB_ID` reaching the session environment and surviving a detach and reattach.

**E2E** — inject synthetic events over the socket and assert dot colour, project-row aggregation, the "Needs you" list, the dock badge count, click-to-focus landing on the right tab; kill a tmux session out from under a tab and assert it lingers, then restarts; install and uninstall against a `PRCLI_CLAUDE_SETTINGS` fixture and assert the pre-existing entries are byte-identical afterwards.

**Not covered by any automated test:** whether a toast actually appeared, whether a sound actually played, and whether Claude's real hooks fire as modelled — every automated test above uses synthetic events. Confirming the real wire end to end, once, by hand, joins the outstanding manual checklist.

## Constraints inherited from M1, M2a and M2b

- macOS only. No Windows or Linux branches.
- All tmux invocations go through `TmuxAdapter`.
- Session names are `prcli-<slug>-<id>`, built only via `encodeSessionName`. Slugs are immutable and match `/^[a-z0-9_]+$/`.
- A tab belongs to a project by the slug in its session name, never by a stored id.
- Live tmux decides what exists; config supplies only order and selection.
- Never infer a session's death from a client's death.
- Any new attach path carries the client's live geometry, or tmux resizes the session to 80×24. This has now shipped as a defect on two separate paths; **Restart is a new attach path** and must be assumed to have it until proven otherwise.
- `register.ts`'s `serialise` queue has no reentrancy protection.
- `ConfigStore.read()` never throws.
- Tests never touch the real `~/.prcli` (`PRCLI_CONFIG_DIR`), the real `~/Code` (`PRCLI_PROJECTS_ROOT`), the default tmux socket (`PRCLI_TMUX_SOCKET`), or — new here — the real `~/.claude/settings.json` (**`PRCLI_CLAUDE_SETTINGS`**). Every test that can reach install must set it, checked at every call site by the pre-flight scan.
- `strict: true`. No `any`, no non-null assertions, no `@ts-` suppressions.
- `node-pty` is main-process only; the renderer reaches privilege only through `window.prcli`.

## Milestone 3 done when

- Installing hooks from Settings shows the diff, backs up, and merges without disturbing an existing entry
- A `claude` started in any tab — including one launched as a shell — shows `thinking` while it works and `waiting` when it needs you
- A project row shows the worst state among its tabs, and the "Needs you" list names every tab that is blocked
- The dock badge counts waiting sessions with the window hidden
- A toast for a background tab fires while the window is focused; one for the tab you are looking at does not
- Quitting with a session in `waiting` and relaunching shows it still `waiting`, from the spool
- A tab whose session dies stays put, red, and restarts into a working session at the right size
- Uninstalling removes PRCLI's entries and leaves every other hook byte-identical
- `npm run lint` runs and passes
- Suite, typecheck and E2E green; no `prcli-*` session left on the default tmux socket; `~/.claude/settings.json` untouched by any test
