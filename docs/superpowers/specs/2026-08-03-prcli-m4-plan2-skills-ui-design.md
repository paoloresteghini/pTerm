# PRCLI — M4 Plan 2: Skills Panel and ⌘K

**Date:** 2026-08-03
**Status:** Approved, pre-planning
**Base:** `master` at `5b8467c`
**Parent spec:** `docs/superpowers/specs/2026-08-03-prcli-m4-design.md`, "Plan 2 — skills panel and ⌘K"

## What this covers

The two surfaces that consume the resolution layer merged as Plan 1
(`860fe64`): a skills section in the right panel, and the ⌘K command palette.

It also covers **Plan 1b**, a correctness fix to Plan 1's shipped module that
must land first. That fix was not foreseen by the parent spec; it was found by
measuring what Claude Code actually accepts.

Everything the parent spec already settled stands unchanged and is not
re-litigated here: ⌘K is a switcher first with actions below, clicking a skill
types `/name` without submitting, ranking puts sessions above actions, and the
palette's rows are panes so it survives Plan 4's tab-bar restructure.

## Facts measured on the target machine, 2026-08-03

Run against the real `~/.claude` through the shipped `listSkills`:

- **155 entries** for this project — 119 skills, 36 commands. Plan 1b adds the
  6 unscanned plugin commands, taking it to **161**; the panel and palette
  should be designed against that figure, not 155.
- **109 from `~/.claude`**, 46 across 10 enabled plugins (superpowers 14;
  atlassian, stripe and chrome-devtools-mcp 6 each; caveman 5;
  solutions-architect-skills 4; supabase 2; three plugins with 1).
- **119 skill directories, zero directory-name collisions.**
- **3 of 119 skills declare a frontmatter `name` differing from their
  directory**: `_gstack-command` declares `gstack`, `connect-chrome` declares
  `open-gstack-browser`, and `jira-sprint-dashboard-canvas` declares
  `jira-sprint-dashboard`.

**In all three cases Claude Code uses the directory name, not the declared
one** — this session's own skill listing offers `_gstack-command`,
`connect-chrome` and `atlassian:jira-sprint-dashboard-canvas`. It also
namespaces plugin skills (`superpowers:brainstorming`, not `brainstorming`)
and path-namespaces commands, including the one command file that declares no
`name` at all, which it offers as `gsd:reapply-patches`.

---

## Plan 1b — the invocation name (prerequisite)

### The defect

The whole feature is "click it, get the string you would have typed".
`scan.ts` currently returns the frontmatter `name`, unprefixed. That string is
wrong in three ways:

1. **All 46 plugin entries lack their namespace.** It yields `brainstorming`
   where Claude Code wants `superpowers:brainstorming`.
2. **Three skills return a declared name Claude Code does not offer.**
3. **A command with no declared name falls back to its bare filename** —
   `reapply-patches` rather than `gsd:reapply-patches`.

And one thing is missing entirely:

4. **Plugin commands are never scanned.** `scan.ts` reads
   `<installPath>/skills` but not `<installPath>/commands`. Measured: 6 command
   files across 5 enabled plugins that Claude Code does offer —
   `feature-dev:feature-dev`, `stripe:explain-error` (and one sibling),
   `code-review:code-review`, `claude-md-management:revise-claude-md`,
   `agent-sdk-dev:new-sdk-app`. The panel would silently lack all of them.

### The rule

Derive from path. Do not consult frontmatter for identity. `<rel>` below means
the path relative to the scanned root, without `.md`, with separators replaced
by `:` — so a file directly in the root is just its basename, and one nested a
level down is `dir:basename`.

| Source | Entry name |
|---|---|
| `~/.claude/skills/<dir>/` | `<dir>` |
| plugin `P`, `<installPath>/skills/<dir>/` | `P:<dir>` |
| `~/.claude/commands/<rel>.md` | `<rel>` |
| plugin `P`, `<installPath>/commands/<rel>.md` | `P:<rel>` |
| project `.claude/commands/<rel>.md` | `<rel>` |

Worked examples, each matching what Claude Code offers today:
`commands/gsd/stats.md` → `gsd:stats`; `commands/gsd/reapply-patches.md` →
`gsd:reapply-patches` (it declares no name at all);
`feature-dev`'s `commands/feature-dev.md` → `feature-dev:feature-dev`.

Skills are one directory deep by construction (`<dir>/SKILL.md`), so `<rel>`
does not apply to them.

`description` still comes from frontmatter, so `frontmatter()` keeps its job.

### Three consequences, each of which is a deletion

- **`parsed.name ?? name` goes.** Identity no longer comes from the file.
- **The `|| undefined` empty-name guard goes with it.** That guard cost this
  plan a BLOCKED round and a measured argument about `name: ""`; it protected a
  field that turns out never to have been the key. Deleting it is the honest
  outcome of that discovery, not a regression.
- **`SkillEntry`'s "name is not unique" doc comment goes.** 119 directory
  names, zero collisions. That comment was added in Plan 1's final fix wave and
  becomes false here. This branch has already shipped a stale comment twice;
  this one is caught before it lands.

### Its A/B

Keep preferring the frontmatter `name` and assert `superpowers:brainstorming`
is what comes back. If that stays green the change is not pinned. Each deletion
also needs the test that proves the deleted branch was dead.

This is a behaviour change to code on `master`, so it gets its own branch and
its own review rather than riding inside a UI plan.

---

## The skills panel

A second section in `RightPanel.tsx`, above Presets, with a filter input at its
head.

### Why a filter rather than a plain list

The parent spec said "same shape as the presets list". Presets is 5 rows.
Skills is **161**, in a 208px column. The filter is what makes that usable, and
it uses the **same matcher module as ⌘K** — one ranking rule in the codebase is
the point; two that drift is the failure. Unfiltered, the section still renders
all 161 in a scroller; the filter means nobody scrolls it.

### Fetching

`App.tsx` renders `{panelOpen ? <RightPanel/> : null}`, so the component mounts
on open and unmounts on close. "Re-read when the panel opens" therefore falls
out of a mount effect keyed on the project's `cwd` — no cache, no extra state,
and the parent spec's freshness decision is satisfied by construction rather
than by a rule someone must remember.

### Inserting

Clicking writes `/name` through `CHANNELS.input` with **no trailing `\r`**, per
the parent spec. `RightPanel` gains an `onInsert(name)` callback beside its
existing `onRun`; `App` supplies the active pane. The panel does not learn what
a pane is.

### Provenance

Presets tag `repo` and nothing else. Skills mirror that exactly: a project's
own `.claude/commands` entry gets `repo`; everything else gets nothing, because
after Plan 1b a plugin's provenance is **in the name**.
`superpowers:brainstorming` needs no badge. A 208px column should not spend
width restating what the row already says.

### States

Loading shows `…`, matching `SettingsPane`'s existing idiom for its hooks
readout. A filter matching nothing says so. Both are real: 161 entries means
you will type something that matches nothing.

---

## ⌘K

A new `CommandPalette.tsx` on the existing Radix `Dialog` primitive, mounted in
`App` beside `AddProjectDialog` and `SettingsPane` with the same
`open`/`onOpenChange` shape.

### Binding

One more branch in `App`'s existing keydown handler:
`event.code === 'KeyK' && !event.altKey`. It sits below the
`data-shortcuts="off"` guard already at the top of that handler, so it inherits
that protection.

**The palette's own input must carry `data-shortcuts="off"`.** Without it,
typing in the palette leaves ⌘W live, and ⌘W closes a pane and destroys its
tmux session. This repo has already paid for that once: during a project
rename, one keystroke lost the tab, the session and the half-typed name. The
attribute is load-bearing, not decoration.

### Sources

- **Sessions** come from renderer state — no IPC. One row per **pane**.
  Selecting one runs the same two dispatches `onSelectNeedy` runs at
  `App.tsx:611`: `activatedProject`, then `activatedTab`.
- **Actions** — skills and presets — come from Plan 1's `prcli:skills` channel,
  fetched on open. A skill inserts; a preset launches.

### Behaviour

**Empty query shows sessions only.** Typing brings actions in below them.
Showing 161 actions before anything is typed buries the twelve things the user
actually switches between, and the switcher is what this app's problem
statement is about.

**Ranking** is as the parent spec fixed it: fuzzy score over `project › label`,
sessions always above actions regardless of score, ties within sessions broken
by state severity worst-first. Nothing learned, nothing remembered.

**Escape and arrow-key navigation come from Radix**, not hand-rolled.

**⌘K must work while a terminal has focus.** ⌘T, ⌘W and ⌘D already do through
the same window listener, so this should be free — but "should be free" is how
three dead tests happened in Plan 1, so it gets a test rather than an argument.

---

## Testing

- **Plan 1b** — unit tests on the derivation; integration on `scan` against a
  fixture tree. A/B as described above, plus a test per deletion proving the
  removed branch was dead.
- **The matcher** is pure, so unit — including that its ranking orders a
  session above a better-scoring action.
- **Panel and palette are E2E**, and this is where Plan 1's Task 5 pays for
  itself: `PRCLI_CLAUDE_HOME` is already a required harness option, so a spec
  can point the launched app at a fixture `~/.claude` holding three known
  skills and assert against a known list rather than against whatever happens
  to be installed that week.

### Two house rules that bite directly here

**"Clicking a skill does not submit" is a negative claim, and `expect.poll` and
`toHaveCount` return on their first match** — neither can assert that something
did *not* happen. This has already produced a false pass in this repo: a
refusal test that passed against a build which showed the error *and* split
anyway. The test must settle, then assert the pane's contents plainly.

**Never assert over the rendered list without first asserting it is
non-empty.** A broken fetch renders zero rows and every `toContain` over them
passes vacuously.

## Sequencing

1. **Plan 1b** — own branch, own review. It corrects merged code.
2. **Plan 2** — one plan: the matcher, the panel, the palette shell and
   binding, the palette's sources and ranking, then E2E.

## Out of scope

Stated so none of it is assumed:

- Deduplication of entry names — dissolved by Plan 1b.
- Recency or frecency in ranking. If it turns out to be wanted, it is a small
  change made against real use rather than a rule invented beforehand.
- Duplicate and Detach-to-tab (parent spec, deliberately deferred).
- Everything in Plan 3 (context menu, tab names, config v6, drag reorder,
  onboarding screen) and Plan 4 (the tab-bar collapse).

## Open, and not this spec's to answer

`master` gained `docs/superpowers/specs/2026-08-03-prcli-welcome-page-design.md`
at `5b8467c` while Plan 1 was being executed. A welcome page and Plan 3's
tmux-missing onboarding screen are adjacent surfaces. **They should be
reconciled before Plan 3 is written**, not before this one — Plan 2 touches
neither.
