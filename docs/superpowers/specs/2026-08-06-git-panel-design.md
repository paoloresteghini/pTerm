# Git panel

Date: 2026-08-06
Status: approved, not yet planned

A sixth side column showing what has changed in the active project's repository, with a
message box and a Commit button, in the manner of VS Code's Source Control view. Clicking a
changed file opens its diff as a read-only pane.

Lightweight is the whole point: no graph, no branch switching, no history.

## Decisions

| Question | Decision |
|---|---|
| Where it lives | A collapsible right-hand **column**, collapsed by default on a fresh profile |
| What a file click opens | A **unified diff**, read-only, as a pane of new type `diff` |
| Staging model | Two sections; `Staged Changes` appears only when non-empty |
| Commit with nothing staged | Commits **all tracked** changes; untracked files are never swept in |
| Discard friction | A confirm naming the files, for one file and for all |
| Stash friction | None; a stash is recoverable |
| Freshness | Poll every 5s while expanded, on window focus, and after the column's own actions |

## Layout

```
┌──────┬─────────────────────┬──────┐
│FILES │  terminal / diff    │ GIT  │
│      │                     │ ───  │
│      │  ┌───────────────┐  │ pterm│
│      │  │ diff of       │  │ mstr*│
│      │  │ Terminal.tsx  │  │      │
│      │  │               │  │ [msg]│
│      │  │ - old line    │  │Commit│
│      │  │ + new line    │  │      │
│      │  └───────────────┘  │ M ter│
│      │                     │ M har│
└──────┴─────────────────────┴──────┘
```

Top to bottom in the column: the repository name and current branch; the commit message box;
the Commit button; then `Staged Changes` and `Changes`, each with a count badge, each row
showing a status letter, a basename and a dimmed directory.

The column uses the shared chrome in `src/renderer/ui/Panel.tsx` — `PanelStrip`,
`PanelHeading`, `ColumnResizer` — and persists its width at `pterm:gitWidth` through
`useColumnWidth`, exactly as `PresetsPanel` does.

Collapsed by default on a fresh profile, following the rule written into `PresetsPanel.tsx`:
a second always-on column must not take terminal width unasked.

## Behaviour

### The list

Read from `git status --porcelain=v2 -z --branch --untracked-files=all`, run in the project's
`cwd`. Verified against git 2.53.0 on 2026-08-06; entries look like:

```
# branch.head master
1 .M N... 100644 100644 100644 <hash> <hash> src/renderer/Terminal.tsx
? .pterm.json
```

The `XY` field is the pair (index status, worktree status). A file belongs to `Staged Changes`
when `X` is not `.`, and to `Changes` when `Y` is not `.`. **Both can be true at once**, and
that file appears in both sections, which is correct and is what VS Code shows.

`-z` matters: it makes paths NUL-terminated and unquoted, so a filename containing a space,
a quote or a newline parses correctly instead of arriving as a quoted string the parser would
have to unescape. Rename entries (`2 ...`) carry two NUL-separated paths, new then original.

### Actions

| Action | Command |
|---|---|
| Stage a file | `git add -- <path>` |
| Unstage a file | `git restore --staged -- <path>` |
| Discard a tracked file | `git restore -- <path>` |
| Discard an untracked file | delete the file |
| Discard everything | `git restore -- .`, then delete each untracked file |
| Stash everything | `git stash push --include-untracked` |
| Commit, staged non-empty | `git commit -m <message>` |
| Commit, nothing staged | `git commit -a -m <message>` |

Discard is two operations wearing one label. `git restore` returns a tracked file to its
committed state, but an untracked file has no committed state to return to and has to be
deleted outright. The confirm text says which is about to happen; the implementation must not
paper over the difference.

### Rows, and what each part of one does

A row's **label is the diff**: clicking the name opens the diff pane. That is the gesture the
panel is mostly used for, so it gets the whole row rather than an icon.

Everything else lives in icon buttons revealed on hover at the row's right edge, so a resting
list is a list of filenames and not a wall of controls:

| Section | Buttons, left to right |
|---|---|
| `Changes` | discard (`↺`), stage (`+`) |
| `Staged Changes` | unstage (`−`) |

Section headings carry the bulk actions on hover: `Changes` offers stash-all and discard-all,
`Staged Changes` offers unstage-all.

The buttons must not begin their testids with `tab-`; 27+ e2e locators count open tabs by
`[data-testid^="tab-"]` and would count these instead.

### Keyboard

`⌘Enter` in the message box commits, which is what VS Code's placeholder text promises and
what muscle memory will expect. It is the only key this panel claims.

Nothing here takes a global shortcut. `⌘G` and friends are unclaimed but the column is
reachable by clicking its strip, and a panel that is used a few times an hour does not earn a
window-level binding ahead of the pane and tab shortcuts that already exist.

### Freshness

The column refreshes on mount, every 5s while expanded, on `window` focus, and immediately
after any action it takes itself. Collapsed, it does not poll at all.

This is the cadence `StatusBar.tsx` already runs, and it exists for the same reason: branch
and working tree change because of things happening inside terminal panes, which main is never
told about. The worst case is five seconds of staleness after a `git add` typed in a pane.

Every read carries StatusBar's stale-response guard: the id asked for is captured, and every
`.then`/`.catch` re-checks it against the currently shown project before setting state. A
project switch mid-request must not land the old repository's list under the new name.

### Mutations return the new list

Every mutating channel returns the freshly read `GitChanges`, and the renderer replaces its
state with that reply rather than patching its own copy.

This follows `PromptsPanel`'s rule — the reply *is* the file — and it is the reason a failed
stage leaves the row exactly where it was instead of showing a lie until the next poll.

## The diff pane

A new pane type, `diff`, sitting beside `editor` as the second sessionless kind.

- Working-tree diff: `git diff -- <path>`
- Staged diff: `git diff --cached -- <path>`
- Untracked file: no diff exists; render the file's contents as wholly added

Read-only. Editing a file is what the editor pane is for, and a diff pane that could be typed
into would need a save path, a dirty flag and a conflict story for no gain.

The pane reuses the existing `filePath` field on `PaneRecord`, which is already validated in
`normalisePane`, carried in `attachSavedFields` and understood by `tabLabel`. One genuinely
new field is needed: which side of the index the diff is of.

It persists across a relaunch and re-derives its content on mount. A file that has since been
committed shows "no changes" rather than an error: the pane's subject is a path, and the
honest answer for a path with no diff is that there is no diff.

### Opening dedups

`openDiff` focuses an already-open diff pane for the same path and side instead of minting a
second one.

This is deliberately unlike `openEditor`, which mints a fresh pane and tab on every call. That
behaviour puts two identically-named tabs in the bar, which then makes a `tab-` locator match
two elements and fail. Clicking file rows is the primary gesture of this panel, so the same
behaviour here would be hit constantly rather than occasionally.

## Seams

A new pane type touches twelve places. Every one was read on 2026-08-06; the line numbers are
from that reading and should be treated as a starting point, not gospel.

| # | File | What |
|---|---|---|
| 1 | `src/shared/ipc.ts:101` | `TabType` union |
| 2 | `src/shared/ipc.ts:121` | `canHaveSession` — becomes a set test, not `!== 'editor'` |
| 3 | `src/main/state/store.ts:122` | `isPane` validation, or every `diff` row is dropped on read |
| 4 | `src/main/state/store.ts:125` | `TAB_TYPES` |
| 5 | `src/main/state/store.ts:127-145` | `normalisePane`, for the new side field |
| 6 | `src/main/status/machine.ts:105` | `stateForOpen` — exhaustive, `tsc` will force it |
| 7 | `src/main/ipc/sessionlessPanes.ts:59` | **the survival filter** |
| 8 | `src/main/ipc/savedFields.ts:85-87` | `attachSavedFields` |
| 9 | `src/main/ipc/register.ts:1490-1546` | the `openEditor` handler, as the model to clone |
| 10 | `src/renderer/App.tsx:1225` | the render ternary, which becomes a switch |
| 11 | `src/renderer/lib/tabLabel.ts:34` | label fallback |
| 12 | `src/shared/ipc.ts` + `src/preload/index.ts` | channel constants, bridge lines, `PTermApi` |

Seam 7 is the dangerous one. `sessionlessPanes.ts:59` reads
`savedPanes.filter((pane) => pane.type === 'editor')`, and it is the single line deciding what
survives a relaunch without a tmux session. A `diff` pane missing from it is written to disk,
absent from the restore reply, and then written away by the `store.write` that follows —
silently, with nothing logged.

New main-side modules: `src/main/git/status.ts` (the porcelain parser) and `src/main/git/ops.ts`
(the operations). Both go through the existing `git()` helper at `src/main/git/sync.ts:26`,
which already sets `GIT_TERMINAL_PROMPT: '0'`, a 60s timeout, `execFile` with array arguments
and no shell, and which never throws — a non-zero exit is an ordinary result. Parsing lives in
exported pure functions beside the runner, the way `parseCounts` and `describeFailure` do, so
unit tests reach it without spawning.

New renderer components: `GitPanel.tsx` and `DiffView.tsx`.

## Error handling

Git's own words, via the existing `describeFailure`, shown on an error line inside the column
with `title=` carrying the untruncated text. `StatusBar.tsx` already learned that git's reason
is usually longer than the space available and that the truncated half is rarely the useful
half.

Failures do **not** go to `fail()` and the `startup-error` banner. That is for unexpected
transport faults, not for git declining to commit.

A project whose `cwd` is not inside a repository renders "Not a git repository", the same
honest empty that `readBranch` returning null already produces for the status bar.

Two failures worth naming because their messages are otherwise baffling:

- **No `user.email` configured.** git refuses to commit and says so; surface it verbatim.
- **A signing key with a pinentry prompt.** `GIT_TERMINAL_PROMPT=0` does not cover gpg, so
  such a commit hangs until the 60s timeout. The timeout is the backstop; the message will be
  a timeout rather than an explanation.

## The concurrent-checkout guard

About twelve Claude sessions run at once across five checkouts, and commits have already
landed on another session's branch once, when HEAD moved mid-run and nothing errored.

A Commit button makes that easier to hit. So: HEAD is recorded when the list is read, re-read
immediately before committing, and the commit is refused if it moved, with a message saying
the branch changed and to refresh.

One extra file read, using `branch.ts`'s existing machinery, against a failure mode this
project has already paid for once.

## Testing

**Unit.** The porcelain-v2 parser against fixture text: modified, staged, both-at-once,
untracked, renamed, and a path containing a space. The tracked-versus-untracked discard
classification. The diff-side selection. All pure functions, no spawning, beside
`tests/unit/gitSync.test.ts`.

**End to end.** `tests/e2e/gitpanel.spec.ts`, building a real repository on disk the way
`gitsync.spec.ts` does, forcing `user.name`, `user.email`, `commit.gpgsign=false` and
`init.defaultBranch`. Covering: the list showing modified and untracked files; staging moving
a row between sections; commit clearing both the list and the message box; the discard confirm
appearing and its cancel changing nothing; the diff pane's content; a second click on the
same row focusing the existing pane rather than adding a tab; and `⌘Enter` in the message box
committing.

**Known e2e hazards** that have each cost time before:

- 27+ locators count tabs by `[data-testid^="tab-"]`. No row testid in this panel may begin
  with `tab-`.
- `.xterm-rows` is empty under the WebGL renderer. Terminal text is read through
  `terminalTexts` / `activeTerminalText` in the harness.
- The strip and the heading share one testid on purpose, so a blind click on it closes a
  column a previous test opened. Use `expandColumn`.

### An accepted cost

`splits.spec.ts` will go red. Its pixel constants encode the whole flex row, and even a
collapsed 24px strip changes the width left for the terminal. Five tests will need new
numbers. This is mechanical and expected, not a regression, and the numbers must be re-measured
rather than guessed.

## Out of scope

Deliberately, and not for lack of noticing:

- the commit graph, and any history view
- branch switching, creation or deletion
- push and pull — the status bar already syncs
- per-hunk and per-line staging
- amend, and rewriting any commit
- the stash *list*: stashing is one button, popping happens in a terminal
- merge-conflict resolution
- blame
