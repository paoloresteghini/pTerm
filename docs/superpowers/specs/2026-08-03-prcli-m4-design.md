# PRCLI — Milestone 4 Design

**Date:** 2026-08-03
**Status:** Approved, pre-planning
**Base:** `master` at `ad7ba67`

## What M4 is

The UI surfaces the master design promised and no milestone built, ordered by
what actually costs time at twelve live sessions.

Two things M4 is explicitly *not*. It is not shipping-readiness — bundle id,
icon, app name, packaged-app E2E and the lint gate all stay out, and so do the
known live defects listed under "Out of scope" below. And it is not new
terminal behaviour: no milestone-sized change to how panes, sessions or tmux
work.

## What exists already, so it is not re-planned

Measured against the code at `ad7ba67`, not against memory:

- Quiet hours, mute-when-focused, the notification rule editor and the settings
  pane all ship and work.
- xterm scrollback is capped at 5000 per pane (`Terminal.tsx:53`).
- Keyboard: ⌘T, ⌘W, ⌘D, ⇧⌘D, ⌘⌥arrows, ⇧⌘\, ⌘,, ⌘1–9, ⌥⌘1–9. The one
  keystroke the design names and the app lacks is ⌘K.
- `CHANNELS.input` and `CHANNELS.reorderProjects` already exist. Inserting a
  skill into a pane and reordering the sidebar need no new IPC.
- `TabDescriptor.tmuxSession` is already on the wire, so "copy tmux attach
  command" needs no new field.
- `stateOfTab` exists in `workspace.ts`, is correct, and has no UI caller.

## Facts measured off the target machine

These are premises the implementation depends on. Each was read off disk on
2026-08-03 rather than assumed, because each is the kind of thing that gets
transcribed wrong.

- **`enabledPlugins` in `~/.claude/settings.json` is a `{name: boolean}` map,
  not a list.** 22 entries, and some are `false` —
  `security-guidance@claude-plugins-official` is one. "Enabled" means
  `=== true`, never "key is present".
- **`~/.claude/plugins/installed_plugins.json` is `version: 2`** and maps
  `plugin@marketplace` to an *array* of installs. Each install carries `scope`
  (`user` or `project`), `projectPath` when project-scoped, `installPath`, and
  `version`.
- **Multi-install is real but narrow.** 23 plugins, 25 installs, 22 user-scope
  and 3 project-scope. Exactly two plugins have more than one install:
  `superpowers` (6.1.1 scoped to `~/Code/Lumio`, 6.2.0 user-wide) and
  `solutions-architect-skills`.
- **The cache holds stale versions.** `supabase` 0.1.11, 0.1.12 and 0.1.13 are
  all on disk simultaneously.
- **Not every `skills/` directory under `~/.claude/plugins` is a Claude skill
  directory.** `plugins/marketplaces/caveman/.cursor/skills` and
  `.windsurf/skills` exist and belong to other tools.
- 73 personal skills in `~/.claude/skills`; one directory in
  `~/.claude/commands` (`gsd`). PRCLI's own repo has no `.claude/`.

## Sequencing

Four plans, in this order. The shape is deliberately the one M2c used —
data layer, then the thing that shows it, then interaction — because that split
worked here before.

1. **The resolution layer.** Main-process only, no UI.
2. **Skills panel and ⌘K.** Both consume plan 1.
3. **Chrome.** Context menu, tab names, drag reorder, onboarding screen.
4. **The tab-bar collapse.** ⊞n, and the selection unconflation underneath it.

Plan 4 is last on purpose. It is the only one of the four that can regress
behaviour that already works, so it lands with the suite at its strongest
rather than at its weakest.

The known cost of this order: plan 1 delivers nothing visible. M2c's review
filed exactly that complaint as I5 — "the layout config 2a stores never reaches
the renderer" — and then concluded it was the split working as intended rather
than a defect. The same conclusion applies here, and is recorded so the next
reviewer does not re-litigate it.

---

## Plan 1 — the resolution layer

New module `src/main/skills/`, splitting pure logic from filesystem access the
way `notify/rules.ts` and `tmux/resolve.ts` already do.

### `resolve.ts` — pure

Takes the parsed `enabledPlugins` map, the parsed `installed_plugins.json`, and
a project `cwd`. Returns the list of directories to scan. Nothing else.

Every rule that can be wrong lives here, and every one is testable with no disk:

- A plugin counts as enabled only when its `enabledPlugins` value is `=== true`.
- For a plugin with several installs, pick the install whose `scope` is
  `project` and whose `projectPath` equals the project's `cwd`; failing that,
  the `user`-scoped install; failing that, contribute nothing.
- A malformed or absent registry contributes nothing.

`ProjectDescriptor.cwd` is the scope key. It already exists and already carries
the project's real path.

### `scan.ts` — filesystem

Reads, for one project:

- `~/.claude/skills`
- `~/.claude/commands`
- the project's own `.claude/commands`
- `installPath/skills` for each plugin `resolve.ts` returned

Parses YAML frontmatter for `name` and `description`.

### Two properties worth defending

**Stale versions and foreign directories are excluded by construction, not by a
filter.** Scanning resolves *from* the `installPath` the registry names, so
`supabase` 0.1.11 and 0.1.12 are never candidates, and
`marketplaces/caveman/.cursor/skills` is not reachable because `marketplaces/`
is not an `installPath`.

No exclusion rule should be written for these. A filter would imply the scan
could otherwise reach them, and a comment asserting a mechanism that is not
true is a defect in this repo.

**It never throws.** Same rule and the same reason as `manifest.ts`: a damaged
`settings.json`, or an `installed_plugins.json` whose shape has changed under a
Claude Code update, must contribute nothing rather than stop the panel opening.

**It never writes.** This reads `~/.claude/settings.json`, a file this repo is
under standing orders never to write outside `install.ts`'s explicit,
backed-up, idempotent merge.

### Wire

One channel, `prcli:skills`, taking a project id — named to the convention
every entry in `CHANNELS` already follows. Called on panel open and on ⌘K open.
No cache, no watcher: 73 skills plus plugin resolution is a few dozen file
reads, and re-reading on open means a skill added a minute ago is there. The
accepted cost is that an already-open panel does not update behind the user's
back.

---

## Plan 2 — skills panel and ⌘K

### Skills panel

A second section in `RightPanel.tsx`, above Presets, in the same shape as the
presets list beside it: label, origin tag (`user`, `repo`, or the plugin's
name), description in `title`.

**Clicking a skill writes `/name` to the focused pane via `CHANNELS.input`,
with no trailing `\r`.** It types; the user presses enter. A skill invocation is
often the start of a line that wants arguments, and auto-submitting into a pane
that is not sitting at a prompt turns one click into stray keystrokes in
whatever is running.

**It inserts into any focused pane, not only `claude`-type ones.** This follows
the ruling already recorded in `decisions.md` about not sniffing commands:
`tabs[].type` declares *intent*, and the app has explicitly decided it cannot
know whether a `shell` tab currently has Claude in it — that is the case the
hollow `unknown` dot exists for. Refusing to insert would require exactly the
knowledge the app has ruled it does not have. `/name` typed into a shell is
text the user deletes.

### ⌘K

One overlay, two source groups.

**Sessions** come from renderer state that already exists — no IPC. Each row is
a **pane**, and selecting one runs the same two dispatches `onSelectNeedy`
already runs at `App.tsx:611`: `activatedProject`, then `activatedTab`.

Targeting panes rather than tab-bar entries is deliberate: it is what makes the
palette survive plan 4's restructure without rework.

**Actions** — presets and skills — come from plan 1's channel, fetched on open.

**Ranking, deliberately dumb:** fuzzy score over `project › label`; sessions
always sort above actions regardless of score; ties within sessions broken by
state severity, worst first. No recency, no frecency, no learning. If recency
turns out to be wanted it is a small change made against real use, rather than
a ranking rule invented before anyone has used the thing.

### One structural rule for this plan

**The palette does not get its own copy of the session list.** It reads the
same `state.projects` and pane records the sidebar reads. A second index that
can disagree with the sidebar is the shape that produced the
`TabRow.activePaneId` shadow already on the open-loops list.

**The palette and the tab bar read one shared `label(tab)`.** Tab names land in
plan 3; a shared label function means plan 3 improves the palette by
construction, with no plan 2 rework and without reordering the plans.

Plan 4 changes what a tab-bar entry stands for, so it changes what `label`
is given. The palette is unaffected either way, because its rows are panes and
a pane keeps its identity across that restructure — which is the reason its
rows are panes.

---

## Plan 3 — chrome

### Context menu

Right-click a tab-bar entry or a pane. Five items:

| Item | Nature |
|---|---|
| Split Right ⌘D | Route — `splitActive('row')` |
| Split Down ⇧⌘D | Route — `splitActive('col')` |
| Kill pane ⌘W | Route — `closePane` |
| Copy tmux attach command | `tmux attach -t <tmuxSession>` to the clipboard; already on the wire |
| Rename | New behaviour — see below |

Duplicate and Detach-to-tab are named in the master design and are deliberately
**not** in M4. Detach-to-tab pulls a pane out of its tab's `kids` and makes it a
tab row of its own: reducer, persistence, tmux group membership, and the
question of what happens when detaching beside a tombstone. That is its own
milestone-sized problem and it would dominate this one.

### Tab names

There is no tab name anywhere in the app today. `TabBar.tsx:6` computes
`` `${tab.projectSlug} · ${tab.id.slice(0, 6)}` ``, so every tab is called
something like `lumio · a3f9c1`.

- `name?: string` on `TabRow`, absent meaning "compute the label as today".
- Inline edit reusing `Sidebar.tsx`'s existing rename field — **including its
  `data-shortcuts="off"` attribute**, which is load-bearing: without it, ⌘W
  during a rename destroyed the tab, its tmux session and the half-typed name.
  That is a bug this repo has already paid for once.

**The config bump to v6 is not ceremony.** `name` is additive and optional, so
v6 code reads a v5 file without trouble. The bump exists because a v5 build
reading a file *with* names drops them on its next write, silently. Bumping
arms `write()`'s existing refuse-if-newer guard, which is the only thing that
turns that data loss into a refusal. `migrate()` gains one branch; it has done
this cleanly four times.

### Drag-to-reorder the sidebar

Renderer-only. `CHANNELS.reorderProjects` exists and `onMove(id, ±1)` already
drives it; drag replaces the Move Up / Move Down buttons as the primary
gesture.

⌘1–9 follows sidebar order, so reordering silently rebinds those shortcuts.
That is the intent, and it is why order is persisted rather than view state.

### Onboarding screen

Replaces the raw system dialog at `src/main/index.ts:329`, whose own comment
reads *"Milestone 4 replaces this with a proper onboarding screen."*

A real window: what is missing, the `brew install tmux` command as copyable
text, and a Retry that re-runs the check rather than requiring a relaunch. It
is the only screen a first run can reach, and today it is an alert with no way
forward except quitting.

---

## Plan 4 — the tab-bar collapse

### What this actually is

`App.tsx:98` is `const activePaneId = currentTabId`. The renderer's notion of
focused pane *is* the tab-bar selection, because a tab-bar entry is a pane —
`TabBar.tsx:38` maps a flat list and keys `status[tab.id]`, `dead[tab.id]` and
`close-${tab.id}` off it. A split tab therefore renders **two** tab-bar
entries today.

Collapsing the bar breaks that identity: selecting a tab must resolve to a
pane. So this plan is **unconflating selected-tab from focused-pane**, and ⊞n
is the visible symptom of having done it.

It also cashes in an open loop: *"`TabRow.activePaneId` is a shadow of
`ProjectRecord.activeTabId` and goes stale on click — nothing writes it on
selection, only `splitPane` and `tabRowFor`. Worth collapsing when 2c touches
selection."* This plan is what touches selection. `activePaneId` stops being a
shadow and becomes the field selection writes.

### What changes

- One entry per tab, carrying `⊞n` when the tab renders more than one box.
  **`n` counts boxes, not live sessions**: a tombstone occupies a box, is
  visible, and is a thing the user can restart, so a tab holding one live pane
  and one tombstone reads `⊞2`. Counting live sessions instead would make the
  badge disagree with the screen beside it, which is the class of defect
  `stateOfTab` was written to prevent.
- **The entry's dot comes from `stateOfTab`.** That function exists, is
  correct, has no UI caller, and carries the warning at `workspace.ts:186-193`:
  reading `status[tab.id]` for a collapsed entry gives the founder pane's state
  wearing the whole tab's dot — green over a crashed sibling. It was written
  ahead of this plan; wiring it is the plan's point.
- **Close on a collapsed entry closes the tab** — every pane in it. Today close
  removes one pane.
- **Restart and Dismiss are per-pane and cannot live on a collapsed entry.** A
  tab with one dead pane among live ones already renders its tombstone inside
  the pane area via `DeadPane`, so the collapsed entry shows severity only and
  the tombstone controls stay where they are. **Open for the plan to decide,
  not for this spec:** a tab whose panes are *all* tombstones.
- **⌥⌘1–9 changes meaning.** It currently indexes `currentTabs`, which is
  panes; after the collapse it indexes tabs.

### Blast radius, counted

12 test files reference tab-bar test ids; 41 uses of `tab-`. Four E2E specs,
including `splits.spec.ts`, which is the only thing in the repo that can see
splits at all.

### The rule this plan is written under

**Assert the observable, not the mechanism.** "A split tab shows one entry"
survives a refactor. "`stateOfTab` is now the caller" is the exact shape of
premise that did not survive being written last round — three of the E2E
revival plan's four disproved premises were disproved *after* being transcribed
into the code.

---

## Testing and safety

### The safety requirement plan 1 creates

Reading skills means reading `~/.claude/skills`, `~/.claude/commands` and
`~/.claude/plugins/`. `PRCLI_CLAUDE_SETTINGS` covers only `settings.json`.
Without new overrides every test resolves against the developer's real 73
skills and 25 plugin installs — read-only, so not destructive, but it makes
assertions depend on what happens to be installed that week.

**`PRCLI_CLAUDE_HOME`, injected and required — not defaulted.** `harness.ts`
gains a sixth mandatory option with a runtime assertion that it sits under the
temp root, exactly like the four paths it already asserts before any spawn, and
`tests/unit/e2eSafety.test.ts` gains the enumeration for it.

The harness's own comment already makes this argument: *"A required parameter
is the fix; a default would restore the hole with better manners."* Three of
four spec files went without `PRCLI_CLAUDE_SETTINGS` until 2026-08-02. A
defaulted sixth option repeats that hole exactly.

### Per plan

- **Plan 1** — `resolve.ts` is pure, so its tests are pure: `enabled === true`
  rather than key-present (the `false` entries on the real disk are the test
  case), project-scope match, user-scope fallback, no match at all, damaged
  JSON contributing nothing. `scan.ts` runs against a fixture tree under the
  temp root, including a frontmatter file with no `name`.
- **Plan 2** — unit on ranking (sessions above actions, severity tiebreak);
  E2E on the panel rendering, on a click inserting `/name` *without*
  submitting, and on ⌘K landing on the correct pane.
- **Plan 3** — unit on `migrate()` v5→v6 and on a v6 file meeting a v5 build;
  E2E on rename, the context menu, copy-attach and drag reorder.
  **Onboarding needs a launch with `tmux` absent from `PATH`** — a harness
  capability that does not exist yet and should be built as one rather than
  faked per-spec.
- **Plan 4** — E2E, in `splits.spec.ts` and the tab-bar specs, asserting what
  renders.

### Gates

Typecheck, `check-deps`, full unit and integration, full E2E, tree clean, on a
branch off `master`. Plus this repo's actual discipline:

1. **A/B every load-bearing assertion, including newly written ones.** Twenty
   tests here have been found incapable of failing. Confirm the mutation landed
   and that the test which went red is the one intended.
2. **Restore an A/B by snapshot copy** (`cp file file.bak` … `cp file.bak
   file`), never `git checkout -- <file>` — that has wiped an uncommitted fix
   twice on this project.
3. **Count `posix_spawnp failed`, `Device not configured` and `fork failed` —
   inside assertion text as well as error lines — before believing any
   integration failure is a defect.** Orphan zsh stands at 2 as of
   2026-08-03; 91 is the count that starved this machine, and repeated
   integration runs across four plans is how it climbs.
   Count with:
   `ps -eo pid,ppid,comm | awk '$2==1 && $3 ~ /zsh$/' | wc -l`

## Out of scope for M4

Stated so none of it is assumed to be included:

- Duplicate, and Detach-to-tab.
- Bundle id, app name, icon, first `npm run make`, packaged-app E2E.
- The lint gate (oxlint is viable — own parser, one warning, that warning a
  false positive — but adding it needs `npm install`, which breaks node-pty's
  spawn-helper permissions).
- `splitTab`'s founder resize, the one looked-up window write with no
  `ownsWindow` guard.
- `resize()` issuing one `execFile` per renderer resize.
- A split tab holding a tombstone appearing under two projects.
- Watching a drag in a real window. Still owed, still only Paolo's, and not
  discharged by anything in this milestone.
