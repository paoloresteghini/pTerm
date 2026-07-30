# PRCLI Milestone 2b — Projects, Sidebar and Presets

**Date:** 2026-07-30
**Status:** Approved, pre-planning
**Parent spec:** `docs/superpowers/specs/2026-07-30-prcli-design.md` — the design of record. This document refines it for one milestone and does not supersede it.
**Builds on:** Milestone 2a (`docs/superpowers/plans/2026-07-30-prcli-m2a-multiple-tabs.md`), merged to `master` at `f055cfe`.

## Goal

Five customers in a sidebar, each owning its own tabs and its own commands — with nothing running that the UI cannot reach.

## Where this starts

M2a delivered multiple tmux-backed tabs in one flat bar, restored from live tmux, with a single hardcoded project (`scratch` → `/Users/paolo/Code`). There is no notion of a project, no sidebar, no presets. Renderer chrome is inline `CSSProperties` objects; the parent spec's Tailwind + shadcn/ui stack is not installed.

## Scope

In:

- Tailwind v4 + shadcn/ui foundation, and porting the three existing components onto it
- A project model in config v3, with a v2 → v3 migration
- Sidebar: project tree, per-project tab list, counts, and Unsorted
- Per-project tab bar
- Add a project: scanned candidates plus a folder picker; remove, rename, reorder
- Per-project presets, from user config merged with the repo's `.prcli.json`
- Right panel listing the active project's presets, collapsible with ⇧⌘\
- Keyboard: ⌘1–9 project, ⌥⌘1–9 tab, ⌘T new shell, ⇧⌘\ right panel

Out, with reasons:

- **Status dots and the state model.** Most tabs are Claude tabs, and without M3's hook bridge a dot on those can only ever say `unknown`. A row of hollow dots trains you to ignore the affordance M3 needs you to trust.
- **The skills panel and ⌘K.** Both sit in the parent spec's right-panel section, but neither was in 2b's scope and the skills panel needs its own sourcing design (`~/.claude/skills`, enabled plugins, `~/.claude/commands`, the project's `.claude/commands`).
- **Drag-to-reorder the sidebar.** Order matters now that ⌘1–9 follows it, so 2b ships reorder as context-menu Move Up / Move Down — fully functional and testable. Drag is M4 polish.
- **Splits.** Milestone 2c.

## Decisions

### The tab bar shows one project at a time

Selecting a project in the sidebar swaps the tab bar to that project's tabs, per the parent spec's layout diagram. At ~12 sessions a flat bar gives each tab ~100px; scoping it to a project keeps it at two or three. Every terminal stays mounted regardless of which project is showing, so switching costs nothing — the same reason M2a keeps hidden tabs mounted.

### ⌘1–9 switches project; ⌥⌘1–9 switches tab

The parent spec assigns ⌘1–9 to projects; M2a shipped it on tabs. Projects win: at five customers the project jump is the coarser and more frequent one, and a project holds only two or three tabs. This changes a binding already in muscle memory, deliberately.

**Implementation note, and a bug to head off.** M2a's handler reads `Number.parseInt(event.key, 10)`. On macOS ⌥ rewrites `event.key` — ⌥1 arrives as `¡` — so ⌥⌘1–9 would silently never fire. Both bindings must read `event.code` (`Digit1`…`Digit9`).

### A tab belongs to a project by slug match, not by a stored id

tmux session names are `prcli-<slug>-<id>`. The session name is therefore already authoritative for which project a tab belongs to, and a stored `projectId` would be a second source of truth able to disagree with it — the same shape as M2a's C1, where config-derived existence stranded live sessions.

Two consequences fall out rather than being built:

- **Unsorted is a definition, not a list.** It is "tabs whose slug matches no project", computed at restore.
- **Removing a project needs no special handling.** Its sessions stop matching and appear under Unsorted, still running. Nothing is stranded and nothing is killed, so no confirmation is required.

### Slugs are immutable

`slug` is derived once from the name at creation and never changes; renaming edits `name` only. Re-slugging would leave every live session for that project unmatched, silently dropping it into Unsorted.

Allocation discriminates on collision: a second project named "api" gets `api_2`. `unsorted` is reserved and discriminates the same way.

The separator is an underscore, not a dash. `names.ts` defines slugs as `/^[a-z0-9_]+$/` and decodes a session name by splitting on exactly three dash-separated parts, so a dash in a slug would make `encodeSessionName` throw and `decodeSessionName` fail.

### An Unsorted row the user cannot delete

Adopted sessions whose slug matches no project — crash leftovers, sessions created before a project existed, anything started outside the app — collect in an Unsorted row at the bottom of the sidebar.

This preserves the invariant both of M2a's Criticals were about: nothing alive is ever unreachable from the UI. The alternative of auto-creating a project from the slug was rejected — a typo'd slug would become a permanent sidebar row.

The row offers no delete action, and it is absent entirely when nothing matches it — "undeletable" means the user cannot dismiss it while it holds sessions, not that an empty row is always drawn. `activeProjectId` may legitimately hold the reserved value `unsorted`, and persists across a relaunch like any other. Unsorted's *active tab* is not persisted and defaults to its first tab: it is a place to rehome a stray, not one to live in.

**Rehoming.** Unsorted tabs offer "Move to project…", which is a tmux rename: the session goes from `prcli-<oldslug>-<id>` to `prcli-<newslug>-<id>` via a new `TmuxAdapter.renameSession`. The tab id is the second half of the name and does not change, so the tab keeps its identity, its scrollback and its running processes — only its slug moves, and with it which project it matches. Without this, a stray could be seen but never filed.

### `+` and ⌘T open a shell immediately

Always a shell in the active project's `cwd`, with nothing to choose. Presets and `claude` are single clicks in the right panel. A launch menu on ⌘T would make every new tab a two-step, including the shell wanted most of the time.

With no project selected, `+` is disabled and the main area shows an empty state. This changes first-run behaviour: M2a opened a scratch tab automatically, 2b asks you to add a project first.

### Migration creates no projects

Every tab in an existing v2 config carries slug `scratch`, and the v2 record does hold a real `cwd`, so a "Scratch" project could be synthesised from it. It should not be: that is auto-creating a project from a slug, which this milestone rejects elsewhere. v2 tabs land in Unsorted — precisely what Unsorted exists for — and real projects are added deliberately.

## Data model

Config v3:

```ts
interface PrcliConfig {
  version: 3
  /** Array order is sidebar order, and the order ⌘1–9 follows. */
  projects: ProjectRecord[]
  activeProjectId: string | null
  tabs: TabRecord[]          // unchanged from v2
}

interface ProjectRecord {
  id: string
  name: string               // display; freely renameable
  slug: string               // immutable once allocated
  cwd: string
  /** User-defined only. Repo presets from .prcli.json merge in at read time. */
  presets: Preset[]
  /** Per-project, so returning to a project lands where you left it. */
  activeTabId: string | null
}

interface Preset {
  id: string
  label: string
  command: string
}
```

`TabRecord` is unchanged: `{ id, projectSlug, cwd, command?, tmuxSession }`.

A repo may ship `.prcli.json` declaring `{ "presets": [{ "label", "command" }] }`. It is read-only and merged by `label`, user config winning on conflict. Merged presets are tagged with their origin so the panel can show which came from the repo. Only user presets are persisted.

Repo presets carry no `id` in the file, so one is derived from the label at read time. It only needs to be stable within a render and unique among that project's presets — nothing persists it.

## Architecture

### Main process

| Module | Responsibility |
|---|---|
| `src/main/projects/discovery.ts` | Scan for candidate projects |
| `src/main/projects/manifest.ts` | Read and validate `.prcli.json` |
| `src/main/projects/projects.ts` | CRUD over `ConfigStore`; slug allocation; reserved-name guard |
| `src/main/tmux/adapter.ts` (modify) | `renameSession`, for rehoming an Unsorted tab |
| `src/main/state/store.ts` (modify) | Config v3 and the v2 → v3 migration |
| `src/main/ipc/restore.ts` (modify) | Resolve projects, active project, per-project active tab |
| `src/main/ipc/register.ts` (modify) | The new channels below |

**Discovery** scans one level below a root for directories containing `.git`, `package.json` or `composer.json`, excludes paths already added, and returns `{ name, cwd, markers }`. The root is `PRCLI_PROJECTS_ROOT`, defaulting to `~/Code` — tests must never scan the real `~/Code`, for the same reason they never touch the real `~/.prcli`.

**Manifest** is read at restore as well as at add, so a repo's presets track the repo. It inherits `ConfigStore.read()`'s contract of never throwing: a malformed manifest in one customer's repo is ignored rather than blocking startup.

**`restoreWorkspace`** returns `{ projects, tabs, activeProjectId }`, each `ProjectDescriptor` carrying its own `activeTabId` and merged presets. It synthesises Unsorted (reserved id `unsorted`) only when tabs actually match no project.

**New IPC:** `addProject(cwd, name)`, `updateProject(id, patch)`, `removeProject(id)`, `reorderProjects(ids)`, `setActiveProject(id)`, `scanCandidates()`, `pickFolder()`, `moveTabToProject(tabId, projectId)`.

`setActive(tabId)` keeps its M2a signature. The main process resolves the owning project from the tab's session-name slug and writes that project's `activeTabId`, so the renderer never restates something the session name already says.

### Renderer

Tailwind v4 + shadcn/ui, zinc base, lime accent (`#a3e635`, already the accent in `TabBar.tsx`). `App.tsx`, `TabBar.tsx` and `Terminal.tsx` port off inline styles.

xterm cannot read Tailwind tokens, so `Terminal.tsx`'s theme object stays hand-written JS and must be kept in sync with the token values by hand. This gets a comment at the definition.

State moves from `tabsReducer` to a single `workspaceReducer` in `src/renderer/workspace.ts` over `{ projects, tabs, activeProjectId }`. Two reducers would have to share the per-project active-tab rule, which is the interesting logic. M2a's `neighbourOf` and its transition semantics survive unchanged, and its 15 reducer tests are **ported and extended, not replaced**.

| Component | Responsibility |
|---|---|
| `Sidebar.tsx` | Project tree, per-project tab list, counts, Unsorted |
| `AddProjectDialog.tsx` | Scanned candidates plus a "Choose folder…" escape hatch |
| `RightPanel.tsx` | Active project's presets; ⇧⌘\ collapse |
| `TabBar.tsx` (modify) | Filters to the active project |
| `Terminal.tsx` | Unchanged beyond the style port |

## Carried in from M2a's review

2b is what makes both of these reachable, so both are in scope:

- **I6** — `restoreWorkspace` bypasses `register.ts`'s `serialise()` queue, so a concurrent config write can be lost. It is about to do considerably more writing.
- **Stale `cwd`** — a renamed project directory makes node-pty produce a permanently blank terminal without throwing. Harmless while `cwd` was a hardcoded constant; a real failure mode once projects own their directories.

Remaining M2a carry-forwards (N2, N3, and the other Minors) stay on the 2b backlog in the vault and are not scope here unless the plan touches their code.

## Failure handling

| Failure | Behaviour |
|---|---|
| Project `cwd` renamed or deleted | Checked before open. Project renders broken in the sidebar with Locate… / Remove; `+` disabled for it. Running tabs are untouched — tmux holds its own cwd |
| `.prcli.json` malformed | Ignored silently; user presets unaffected |
| `~/Code` missing | Empty candidate list; the picker still offers Choose folder… |
| Same folder added twice | Refused; the existing project is selected instead |
| Slug collision | Discriminated (`api`, `api_2`); immutable thereafter |
| Project named "Unsorted" | `unsorted` is reserved; discriminates to `unsorted_2` |
| Project removed with live tabs | Sessions keep running and reappear under Unsorted |
| Folder picker cancelled | No-op |
| No projects configured | Empty state; `+` disabled; Unsorted still reachable if it has tabs |

## Testing

**Unit** — the workspace reducer (M2a's 15 tests ported, plus the project dimension); slug allocation, collision and reserved handling; `.prcli.json` parse and merge precedence; the v2 → v3 migration.

**Integration, real tmux on `-L prcli-test`** — restore grouping tabs by slug; Unsorted synthesis; per-project active-tab resolution; a project removed while its sessions live; rehoming a tab via `renameSession`, asserting the session survives with its id intact and now matches the target project; discovery against a temp `PRCLI_PROJECTS_ROOT`.

**E2E** — add a project through the picker; tabs open in two projects with the bar showing only one project's; ⌘1–9 switches project and ⌥⌘1–9 switches tab; a preset launches the right command; quit and relaunch restores the active project *and* each project's active tab; a session whose project was deleted appears under Unsorted, still alive.

**Not covered by any automated test:** whether the Tailwind port looks right. The 13 E2E tests key off `data-testid`, so they pass just as happily on a page that renders wrong. This needs a hands-on pass, alongside the TUI checklist still outstanding from M1.

## Constraints inherited from M1 and M2a

- macOS only. No Windows or Linux branches.
- All tmux invocations go through `TmuxAdapter`. No `execFile('tmux', …)` elsewhere in app code.
- Session names are `prcli-<slug>-<id>`, built only via `encodeSessionName`.
- Integration tests use `-L prcli-test`; E2E uses `PRCLI_TMUX_SOCKET`. Neither may ever touch the developer's own tmux server.
- Tests never read or write the real `~/.prcli` (`PRCLI_CONFIG_DIR`) or the real `~/Code` (`PRCLI_PROJECTS_ROOT`).
- `node-pty` is main-process only; renderer code imports no Node built-ins and reaches privilege only through `window.prcli`.
- `strict: true`. No `any`, no non-null assertions, no `@ts-` suppressions.
- **Live tmux decides what exists; config supplies only order and selection.**
- **Never infer a session's death from a client's death.**

## Milestone 2b done when

- The sidebar lists every added project, each expanding to its own tabs
- The tab bar shows only the active project's tabs
- ⌘1–9 switches project, ⌥⌘1–9 switches tab, ⌘T opens a shell in the active project
- A project is added from scanned candidates or a chosen folder, and can be renamed, reordered and removed
- The right panel lists the active project's presets, merged from config and `.prcli.json`, and clicking one opens a tab running it
- A session whose slug matches no project appears under Unsorted, alive and reachable
- Quit and relaunch restores the active project and each project's active tab
- Suite, typecheck and E2E green; no `prcli-*` session left on the default tmux socket
