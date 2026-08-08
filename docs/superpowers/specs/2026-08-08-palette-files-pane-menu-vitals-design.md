# Files in the palette, a terminal menu, and session vitals

Design agreed 2026-08-08. Three independent features, one spec because they are
being built together.

## 1. Files in ⌘K

A new `projectFiles(projectId)` channel answers the project's files as paths
relative to its root.

**`git ls-files --cached --others --exclude-standard -z` first.** Every project
here is a git repo, and this respects `.gitignore` exactly and without us
reimplementing its semantics. `-z` because a filename may contain a newline.
Untracked-but-not-ignored files are included, so a file created a minute ago is
findable. A project that is not a repo falls back to a bounded recursive walk
using the existing `{.git, node_modules}` filter from `files/tree.ts`, which is
thin but no worse than the tree already is.

Capped at 20,000 paths, and the answer says whether it was truncated, so a
monorepo degrades visibly rather than silently losing files.

Fetched when the palette opens, exactly as skills already are. No watcher: the
list is a snapshot per open, and a stale entry costs one failed open.

`lib/match.ts` gains `rankFiles`, scoring the basename ahead of the directory,
so typing `app` puts `App.tsx` above `src/app/nested/other.ts`. Palette order is
sessions, then files, then skills. Choosing a file calls `openEditor`, which
reuses an existing pane for that path.

## 2. The terminal's right-click menu

`App.tsx` already renders a pane menu (`pmenu-${id}`) holding `ColorSwatches`.
This extends that menu rather than adding a second gesture on the same click:

Copy, Paste, Clear, divider, Split, Close pane, divider, the colour swatches.

Copy is disabled when the pane has no selection. Clear empties xterm's buffer
and NOT tmux's deeper history, and the item's label says so.

Two IPC additions, because the clipboard belongs to main: read text, write text.
`Terminal.tsx` exports `selectionOf(tabId)` and `clearTerminal(tabId)` over the
`mounted` map it already keeps.

## 3. Session vitals

`StatusEvent` is `{tabId, state}` today and `StatusRegistry` holds
`Map<tabId, TabState>`. Neither has a timestamp, so a window reload would have
no idea when a state began.

`StatusRegistry` records `since` (epoch ms) on every transition. `StatusEvent`
and the restore payload carry it. The renderer formats elapsed time against it
on a coarse ticking clock: `4m`, `12m`, `2h`. Under a minute shows nothing,
because a number that changes every second is noise on twelve rows.

Shown on the sidebar's tab row, and on the tab itself for states that are not
idle. Answers "which of these twelve is stuck" at a glance, which is the point.

**`since` is not persisted.** After a relaunch the clock restarts, because the
state was genuinely re-established at that moment. Persisting it would claim
knowledge of a session that changed while the app was closed.

**No cost or tokens.** The hook script sends `{tabId, event, at}` and nothing
else, deliberately: "PostToolUse payloads carry tool output and can be large".
Claude Code's hook payloads do not carry cost either. Real numbers would mean
reading session transcripts, which is a separate piece of work.

## Testing

- **Unit**: `rankFiles` ordering; the `git ls-files -z` parser; the elapsed
  formatter; `since` on registry transitions.
- **Integration**: the file index against a real temp repo and a non-repo.
- **E2E**: the palette lists and opens a file; the menu's items act; a vitals
  label appears.

**Known limit**: ⌘V through the NATIVE Edit menu remains undrivable from the
suite. The menu's own Paste item is testable; the native accelerator is not,
and that is the same gap that made the earlier paste investigation slow.
