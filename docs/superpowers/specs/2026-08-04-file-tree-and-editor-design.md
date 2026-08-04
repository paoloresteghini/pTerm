# File tree, and panes that are not terminals

Date: 2026-08-04
Status: approved (design conversation, this session)
Scope: **A is to be built now. B is specified now and built next. C is a sketch.**

## What

Two things, deliberately separated:

- **A. A file tree** in the left sidebar, under the projects list, showing the
  active project's working tree. Self-contained, changes no invariant.
- **B. Panes that have no tmux session**, with a CodeMirror editor as the first
  kind. Clicking a file in the tree opens it as a new tab.

They are separated because A is a panel and B is a change to what a pane *is*.
Building them as one thing would put the app's central invariant on the same
commit as a directory listing.

## The invariant B relaxes

Today, without exception, **a pane is a tmux session**:

- `TabType = 'claude' | 'preset' | 'shell'`, all terminal kinds
- `PaneRecord.tmuxSession: string` is required, and `isPane` (`store.ts:108`)
  rejects a row without one
- restore matches saved rows against live tmux by that name
  (`restore.ts:144`), and a row whose session is gone is dropped
- `App.tsx` renders `<Terminal>` for every pane box, unconditionally

An editor pane has no session. So B is not "add an editor", it is "let a pane
exist without tmux", and the editor is the first thing that uses it.

**Design it as sessionless panes, not as editor panes.** Git (C) then becomes a
second *kind* rather than a second architecture. This is the answer to "not sure
where git could live": it lives wherever B says a sessionless pane lives.

## A. The file tree

### Layout

`src/renderer/FileTree.tsx`, rendered inside `Sidebar.tsx` below the existing
projects-and-tabs list, above the `+ Add project` / `Settings…` footer. The
sidebar becomes two scroll regions in one column: projects (existing) and files
(new), each `min-h-0 overflow-y-auto scroll-thin`.

Scoped to the active project's `cwd`. Switching projects switches the tree. No
tree when no project is active.

A header row reading `FILES` in the established
`text-[10px] uppercase tracking-wider text-faint` style, with a refresh button
on the right.

### Reading

- IPC `fsList(projectId, relPath)` resolving to `{ name: string; dir: boolean }[]`,
  directories first, then files, each group `localeCompare`d.
- **Lazy.** A directory is read when it is expanded and not before. Walking a
  five-client repo at launch would block the sidebar for the one case the tree
  is least useful in.
- **The path guard lives in main.** The call takes a project id and a path
  RELATIVE to that project. Main resolves it against the project's `cwd`,
  `path.resolve`s the result, and refuses anything that does not still start
  with the cwd plus a separator. The renderer must not be able to ask for
  `/etc`, and `..` must not get there by being clever. This is a real boundary,
  not a tidiness rule: the renderer runs web content.
- Hidden by default: `.git` and `node_modules`, by name, at any depth. Other
  dotfiles are shown; `.env` being visible is the point of a file tree.
- A directory that cannot be read resolves to `[]` rather than throwing. A
  permission error is a leaf that does not open, not a broken sidebar.

### Refresh is a button, not a watcher

No `fs.watch`. A recursive watcher over several client repos costs descriptors
and wakeups continuously, for a tree that is idle most of the time, and the
failure mode on macOS (silently missing events past a limit) is worse than a
stale tree the user can see is stale. The refresh button re-reads every
currently expanded directory.

Stated as a decision, not an oversight: if the tree turns out to feel stale in
use, a watcher scoped to the expanded set is the next step, and that is a
smaller change than removing one.

### State

Expanded directories in `localStorage`, keyed by project id, holding relative
paths. Follows the NOTES panel's precedent: view state is `localStorage`,
project *data* is a file under `configRoot()`, and neither is `config.json`.

### Test ids

Prefix `tree-`, which collides with no counted prefix in the e2e suite. The
counted ones today are `tab-`, `skill-`, `pane-`, `project-`, `close-`,
`palette-session-`, `palette-action-`. `tree-row-<relpath>`, `tree-refresh`,
`tree-empty`.

## B. Sessionless panes

### Model

- `TabType` gains `'editor'`.
- `PaneRecord.tmuxSession` becomes optional. `isPane` must stop requiring it,
  and must instead require it *for terminal kinds*, so a malformed terminal row
  is still rejected.
- `PaneRecord.filePath?: string`, absolute, for editor panes.
- Store goes to **v8**. A v7 row has no `filePath` and every v7 pane is a
  terminal, so nothing converts; v5, v6, v7 and v8 continue to share one branch.

### Restore

The branch that matters. Today `restoreWorkspace` asks tmux what exists and
drops saved rows with no live session. A sessionless pane has nothing to ask
about and must survive on its own path: it is restored from config alone, with
its `filePath`, and never consulted against tmux.

`attachSavedFields` gains `filePath` at the same time. The pane-colour work
(`b397216`) showed exactly how this fails: correct on screen, correct on disk,
gone after relaunch, nothing thrown. **B's first commit must include a
close-and-relaunch e2e**, not its last.

### What must learn to skip a sessionless pane

Enumerated because each is a silent failure rather than a crash:

- `StatusDot` and `state.status`: an editor has no state, so it draws no dot
- `needsYou` and the dock badge: neither may count an editor pane
- `DeadPane`: an editor cannot die, so the overlay must never mount on one
- closing one: kills no session and writes no tombstone
- `tabLabel`: an editor tab is named for its file's basename rather than
  `slug · id`. That makes it the fourth caller of the one label rule, and it
  must go through that rule rather than around it.
- ⌘D on an editor pane: allowed, and splits it like any other pane
- restart: meaningless on an editor, so the menu must not offer it

### The editor

CodeMirror 6: `@codemirror/state`, `/view`, `/language`, `/commands`, `/search`,
plus language packs. Roughly 400KB installed, taking the app from 9 runtime
dependencies to about 15. It is the largest dependency this app has taken and
is what makes the pane feel like an editor rather than a textarea.

Theme: the pane's background is already per-pane (`PANE_COLORS`), so
CodeMirror's theme must read that colour rather than hardcoding one, the same
way xterm's does. A coloured editor pane and a coloured terminal pane must not
disagree.

### Saving

- **Explicit ⌘S. Never autosave.** NOTES autosaves because it is a scratchpad
  nothing else reads. A source file in a repo Claude is also editing is the
  opposite case.
- A dirty pane shows a dot in its tab. Closing a dirty pane asks.
- **mtime is checked before writing.** The pane records the file's mtime when
  it loads. On save, if the mtime on disk differs, the write is refused and the
  user is told the file changed underneath them. With Claude sessions editing
  the same tree, this is the normal case, not the exotic one.
- Reload is manual, for the same reason the tree's refresh is.

### Persistence

An editor tab persists as a pane row with `type: 'editor'` and its `filePath`,
and reopens on relaunch. A file that no longer exists opens as an empty pane
saying so rather than being dropped silently, so a moved file is visible rather
than mysterious.

## C. Git (sketch only, not specified)

If B lands as *sessionless panes*, git is a second kind: `type: 'git'`, a pane
showing status, staged and unstaged changes, and a diff, scoped to the active
project. No new architecture, no store change beyond the type.

The alternative, a third sidebar section, is cheaper but cannot show a diff at
a readable width. Deciding between them is a separate conversation, after B.

## Testing

- **A**: unit tests for the path guard, including `..` traversal and a symlink
  pointing outside the project, and for the dirs-first sort. E2E: expand a
  seeded fixture tree, assert order, assert `node_modules` absent, click
  refresh after adding a file on disk and see it appear.
- **B**: unit tests for the store's v8 read and for `isPane` accepting a
  sessionless editor row while still rejecting a terminal row with no session.
  E2E: open a file, edit, ⌘S, close the app, relaunch, assert the tab and its
  contents came back. Mutation-check the restore branch specifically.

## Risks

1. **The restore path.** Named twice above because it is the one that fails
   silently. Every B commit that touches a pane row needs a relaunch assertion.
2. **A parallel session is working in this region.** The NOTES column landed on
   master during this conversation. A's sidebar changes and its App.tsx layout
   changes are adjacent. Rebase before starting and re-read `Sidebar.tsx` and
   `App.tsx` rather than trusting this document's line references.
3. **CodeMirror's size** is a one-way door in practice. Worth confirming the
   installed footprint before the dependency is committed rather than after.
