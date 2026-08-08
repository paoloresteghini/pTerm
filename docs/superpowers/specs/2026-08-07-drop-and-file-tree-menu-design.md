# Dropping files onto a pane, and a context menu on the file tree

Design agreed 2026-08-07. Two features that share one new idea: the app now
turns a file on disk into text a shell can use.

## A. Drop files onto a terminal pane

Dropping one or more files onto a pane types their absolute paths at the
cursor. Nothing is submitted: no trailing Return, so a file can be dropped
into the middle of a half-typed command.

**Paths come from `webUtils.getPathForFile`.** `File.path` was removed in
Electron 32 and this app is on 43, so the renderer cannot read a dropped
file's path on its own. The preload exposes one new function for it. This is
the only part of the feature that cannot be exercised from the e2e suite: a
`File` minted inside a Playwright page resolves to `''`.

**Quoting lives in `src/renderer/lib/shellQuote.ts`**, pure and unit tested,
the same shape as `lib/terminalLinks.ts`. A path is wrapped in single quotes
only when it contains something outside a conservative safe set, and an
embedded single quote is escaped as `'\''`. Several paths join with a single
space. Bare paths were rejected: a path containing a space would silently
split into two arguments, which reads as the app having dropped the wrong
file.

**A drop anywhere else in the window must be swallowed.** Electron navigates
to a file dropped on a page, which replaces the app with the file and looks
like a crash. A window-level `dragover`/`drop` preventDefault is part of this
change, with the pane handler the only place a drop does anything.

## B. A context menu on file tree rows

Right-clicking a row opens a menu positioned from that row's bounding box,
following the `TabBar` pattern already in the codebase. Items: Open, Rename,
Delete, Show in Finder, Copy path, Copy relative path, New file, New folder.

Every operation is addressed by `(projectId, relPath)` and resolved through
the existing `resolveInside` guard in `src/main/files/tree.ts`, exactly as
`fsList` and `fsRead` are. The renderer never names an absolute path, so
nothing it can send addresses outside the project.

| Channel | Behaviour |
| --- | --- |
| `fsRename` | Renames within the same directory. The new name must contain no path separator, so a rename cannot move a file. |
| `fsTrash` | `shell.trashItem`. Recoverable, so no confirmation dialog. |
| `fsReveal` | `shell.showItemInFolder`. |
| `fsCopyPath` | Writes the absolute or the project-relative path with main's `clipboard`. Main holds the absolute path, so the renderer never needs it. |
| `fsCreate` | Creates a file or a directory inside the clicked folder. Refuses a name that already exists rather than truncating it. |

Rename and the two New items use an inline field in the row, reusing the tab
rename pattern rather than adding a dialog. The tree's existing `reload`
refreshes after each mutation.

## C. `openEditor` stops duplicating tabs

Clicking a row for an already-open file mints a second tab of the same name
today. Main now reuses the existing editor pane for that path and focuses its
tab. This was already an open defect: two tabs of one name make the e2e
`tabIdFor` locator match two elements, and `editor.spec.ts` works around it by
clicking tabs rather than tree rows.

## Testing

- **Unit**: the quoting rules; the rename-name rule (no separator, no
  absolute, no traversal); which path `fsCopyPath` returns for each kind.
- **Integration**: the new handlers against a temp directory, beside
  `tests/integration/fileTree.test.ts`.
- **E2E**: right-click shows the menu; rename renames the row; a new file
  appears; trash removes the row; a drop is intercepted and does not navigate.

**Known coverage limit**: no automated test proves a real dropped file's path
reaches the pty, because `webUtils.getPathForFile` cannot resolve a synthetic
`File`. The text-building either side of it is unit tested; the file-to-path
step rests on a manual check.
