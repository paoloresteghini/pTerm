# Issues panel

Date: 2026-08-09
Status: approved, planned, in implementation

An eighth side column listing the active project's GitHub issues, with search, filtering,
sorting, and a modal for reading, creating, editing, commenting and closing. It reaches
GitHub by shelling out to the `gh` CLI, the way every other remote-ish thing in this app
shells out to `git`.

Lightweight is the point: no projects boards, no milestones editor, no pull requests, no
issue templates.

## Decisions

| Question | Decision |
|---|---|
| Transport | Shell out to `gh`, not the REST API |
| Where it lives | A collapsible side **column**, collapsed by default on a fresh profile |
| What a row click opens | A **modal**, in the manner of `SettingsPane` |
| New pane or tab types | **None.** No `TabType`, no `PaneRecord` type, no restore surface |
| Which repository | `origin` only, parsed by us, passed to `gh` as an explicit `--repo` |
| No repository / no `gh` / no auth | The column opens and explains itself; it is never disabled |
| Delete an issue | **Cut.** Close is the operation people mean |
| Issue body rendering | Read-only CodeMirror over the markdown **source**, not rendered HTML |
| Freshness | No interval poll. Expand, project switch, throttled window focus, own mutations, manual refresh |
| Search | Client-side over the loaded set, with an honest truncation marker |
| Also in scope | The Git column is renamed **Git Changes** and gains the same self-explaining empty state |

## Why `gh` and not the API

`gh` inherits the login the user already has, works against GitHub Enterprise without extra
work, stores no token in this app's config, and needs no rate-limit bookkeeping of our own.
The alternative, REST plus a stored token, means owning token capture, secure storage,
401 handling, pagination and rate-limit headers before reaching parity.

The cost is a hard dependency on `gh` being installed, which is one of the empty states
below, and roughly 200ms of process spawn per action, which is acceptable at this frequency.

Verified against `gh version 2.96.0 (2026-07-02)` on 2026-08-09.

## Why a column and not a pane

Every other finder in this app (`FileTree`, `GitPanel`) lives in a column. The issues list
is a finder. Putting it in a column means it costs no new `TabType`, no new `PaneRecord`
type, no entry in `SESSIONLESS`, no `tabLabel.ts` case, and no `attachSavedFields` field, and
it cannot collide with the 27+ e2e locators that count open tabs by `[data-testid^="tab-"]`.

The detail is a modal rather than a pane for the same reason: a modal is app-global, holds no
workspace state, and therefore needs no restore story at all. One issue is open at a time,
which is what "click the one you want to work on" means.

## Layout

```
┌──────┬─────────────────────┬────────┐
│FILES │  terminal           │ ISSUES │
│      │                     │ ────── │
│      │                     │ paolo/ │
│      │                     │ PRCLI  │
│      │                     │ 12 open│
│      │                     │ [searc]│
│      │                     │ O C A ⇅│
│      │                     │        │
│      │                     │ ○ #42  │
│      │                     │ Fix th…│
│      │                     │ 2h · 3 │
│      │                     │        │
│      │                     │ ● #38  │
│      │                     │ Rename…│
│      │                     │ 1d · 0 │
└──────┴─────────────────────┴────────┘
```

The column uses the shared chrome in `src/renderer/ui/Panel.tsx` (`PanelStrip`,
`PanelHeading`, `ColumnResizer`) and persists its width at `pterm:issuesWidth` through
`useColumnWidth`, default 256, exactly as `NotesPanel` does. It takes a place in
`COLUMN_ORDER_DEFAULT` next to `git`, and is draggable in the row like every other column.

**Collapsed by default on a fresh profile.** This is the rule already written into
`PresetsPanel.tsx`: a second always-on column must not take terminal width unasked. It also
spares `splits.spec.ts`, whose pixel constants encode the whole flex row.

### Column contents, top to bottom

1. `PanelHeading` labelled `Issues`, carrying the drag handle, a `+` that opens the create
   modal, and a refresh control.
2. `owner/name`, dimmed, with the count beside it: `12 open`, or `200+` when the fetch came
   back at its limit.
3. A full-width search input.
4. One compact row: an `Open` / `Closed` / `All` segmented control, and a sort icon-button
   opening a menu of `Recently updated` / `Newest` / `Most commented`.
5. The list.

Two rows of chrome, not three. 256px does not have the budget for a third.

### Rows

Two lines each. Line one: a state glyph, `#42` dimmed, and the title truncated to one line.
Line two: relative time, comment count, and label dots.

The whole row is the click target and it opens the modal. Everything else lives in icon
buttons revealed on hover at the row's right edge, so a resting list is a list of titles and
not a wall of controls:

| Row state | Buttons, left to right |
|---|---|
| Open | close-as-completed (`✓`), open-on-GitHub (`↗`) |
| Closed | open-on-GitHub (`↗`) |

**No testid in this feature may begin with `tab-`.** 27+ e2e locators count open tabs by
`[data-testid^="tab-"]` and would count these instead.

## The modal

A Radix `Dialog` following `SettingsPane.tsx` (`DialogContent`, centred, `max-h-[85vh]
overflow-y-auto`), but wider. Settings is narrow; issue bodies want roughly 720px.

Top to bottom:

- Header: `#42`, the title, a state chip, the author, the created-at relative time, and `↗`.
  The chip distinguishes three states, not two: `Open`, `Closed as completed`, and
  `Closed as not planned`.
- Labels and assignees as chips.
- The body.
- The comments, each with author, relative time and body.
- A comment box.
- A footer: `Edit`, and either a split close control (`Close as completed`, with a caret for
  `Close as not planned`) or `Reopen`.

Create and edit reuse this same modal in a different mode. One component, one dirty-state
path, rather than three near-identical dialogs.

### The body renders as markdown source, not as rendered HTML

Read-only CodeMirror with `@codemirror/lang-markdown`, which the app already ships.

This is a security decision, not a shortcut. An issue body is untrusted remote text that
anyone on the internet can author, GitHub markdown permits raw HTML inside it, and this is an
Electron renderer. Rendering it in-app means owning a sanitizer and being right about it in
perpetuity; being wrong once is script execution inside the application. `↗ Open on GitHub`
is one click away when the rendered view is what is wanted.

Comment bodies get the same treatment. Editing uses the same component, writable.

If in-app rendering is ever wanted, it is its own scoped decision with its own sanitizer
review, not a detail of this panel.

## Data layer

A new directory `src/main/gh/`, mirroring `src/main/git/`.

### `run.ts`

One `gh(cwd, args)` wrapper cloned from `git()` in `src/main/git/sync.ts`: `execFile`, a
timeout, and `{ code, stdout, stderr }` reported rather than thrown, because every non-zero
exit here is a state the panel has something to say about.

Environment additions, all three verified present in `gh help environment`:

| Variable | Why |
|---|---|
| `GH_PROMPT_DISABLED=1` | A `gh` that prompts, spawned from Electron with no terminal attached, is a hang nobody can see or answer |
| `GH_NO_UPDATE_NOTIFIER=1` | Keeps stdout pure JSON |
| `NO_COLOR=1` | No ANSI escapes in captured output |

The timeout is 20s, not the 60s `git()` uses. These are network calls, and a spinner that
hangs for a minute is worse than an error.

`run.ts` reads the binary path from `PTERM_GH_BIN`, defaulting to `'gh'`. That is the same
`PTERM_*` convention `tests/e2e/harness.ts` already uses for eleven other things, and it is
how e2e substitutes a fixture (see Testing).

### `repo.ts`

Pure, and therefore unit-testable under this repo's `environment: 'node'` vitest, the same
way `parseStatus` in `src/main/git/status.ts` is.

Takes the output of `git remote get-url origin` and returns `{ host, owner, name }` or null.
Handles `git@github.com:o/n.git`, `https://github.com/o/n.git`, `ssh://git@github.com/o/n`,
with or without a trailing `.git`. Enterprise hosts under `*.github.com` and `*.ghe.com`
become the `HOST/OWNER/REPO` form `gh --repo` accepts.

**A host is GitHub only on a dot boundary**: exactly `github.com`, or a suffix of
`.github.com` or `.ghe.com`, compared lowercased. A prefix test such as
`host.startsWith('github.')` looks equivalent and is not. `github.com.attacker.net` and
`github.evil.net` are wholly separate registrable domains that merely share those leading
characters, and accepting them feeds an attacker-chosen host straight into
`gh --repo HOST/OWNER/REPO`. This document originally described the prefix test, an
implementation shipped it, and review caught it. The dot-boundary rule is the correction.

That rule narrows what this document first promised. A self-hosted Enterprise host on an
arbitrary domain, such as `github.corp.com`, is now rejected as not-GitHub. Nothing in a pure
function can tell such a host from an attacker's domain by name alone, so the choice is
between rejecting some genuine Enterprise setups with a clear message and accepting
lookalikes silently. Rejecting is the safe direction, and the empty state names the remote,
so the reason is visible rather than mysterious.

The path must be **exactly two segments** after stripping `.git` and empty segments. Taking
the last two segments of a longer path silently resolves
`https://github.com/owner/repo/blob/main/file.ts` to a repository called `main/file.ts`.

**`origin` only.** A fork whose `origin` is the user's own copy will show that copy's issue
list, which is usually empty, and the heading naming `owner/name` is how that becomes
visible rather than mysterious.

**Every `gh` call passes `--repo` explicitly.** Left to resolve the base repository itself,
`gh` applies its own rules and, in a fork with several remotes, prompts, which, spawned
non-interactively, is an error or a hang rather than a prompt. Deriving the reference
ourselves and passing it makes every invocation deterministic.

### `issues.ts`

| Action | Command |
|---|---|
| List | `gh issue list --repo R --state <open\|closed\|all> --limit 200 --json number,title,state,stateReason,labels,assignees,comments,updatedAt,author` |
| Detail | `gh issue view N --repo R --json number,title,body,state,stateReason,labels,assignees,comments,url,createdAt,updatedAt,author` |
| Create | `gh issue create --repo R --title T --body-file -` |
| Edit | `gh issue edit N --repo R --title T --body-file - [--add-label name] [--remove-label name]` |
| Close | `gh issue close N --repo R --reason <completed\|not planned>` |
| Reopen | `gh issue reopen N --repo R` |
| Comment | `gh issue comment N --repo R --body-file -` |

All `--json` field names above were verified against `gh issue list --json` on 2026-08-09.

Bodies go in over **stdin** via `--body-file -`, not as `--body <string>`. `execFile` uses no
shell, so quoting is already safe; the reason is that argv has a length ceiling and an issue
body is unbounded markdown.

`stateReason` is why the close control is a split rather than a button. `completed` and
`not planned` are GitHub's own distinction, they render differently on GitHub, and
"mark as done" means the first one specifically.

### Failure is typed, not stringly

```ts
type IssuesResult<T> =
  | { ok: true; repo: RepoRef; value: T; truncated: boolean }
  | {
      ok: false
      reason: 'no-project' | 'no-repo' | 'no-remote' | 'not-github'
            | 'no-gh' | 'no-auth' | 'no-issues' | 'failed'
      message: string
    }
```

Detected in this order:

| Condition | `reason` |
|---|---|
| The project id names nothing in the workspace | `no-project` |
| `repoRoot()` returns null | `no-repo` |
| `git remote get-url origin` exits non-zero | `no-remote` |
| `repo.ts` cannot parse it as GitHub | `not-github` |
| Spawning `gh` fails with `ENOENT` | `no-gh` |
| Non-zero exit, stderr mentions authentication | `no-auth` |
| Non-zero exit, stderr says the repository could not be resolved or issues are disabled | `no-issues` |
| Anything else | `failed`, carrying trimmed stderr |

The last row matters: an unforeseen `gh` error stays visible instead of being swallowed into
a generic empty state.

### Empty states

The column always opens and always explains itself. A greyed-out column that will not open
teaches nobody anything. Each of the eight reasons above gets a message naming the actual
fix, and `no-gh` and `no-auth` show the command to run (`brew install gh`, `gh auth login`)
as copyable text.

### Freshness

No interval poll. The Git column's 5s tick is right for a local `git status` and wrong for a
network call against a rate limit.

Refetch on: column expand, project switch, window focus throttled to once per 60s, after any
of this panel's own mutations, and the explicit refresh control.

A last-good list is cached per project in renderer state, so switching projects shows
stale-then-fresh rather than blank-then-fresh.

### Search

Client-side over the loaded set, matching number, title and label name as the user types.
Instant, works against the cache, and spawns nothing per keystroke.

The ceiling is honest rather than hidden. `--limit 200`, and `truncated` is true when the
reply came back holding exactly the limit, which is the only signal available: `gh issue
list` reports the page it fetched and never a repository total, so a `200 of 431` reading
cannot be produced without a second, different call. The heading therefore reads `200+`,
which claims only what is known: that the filter is not looking at everything.

Server-side `--search` is the obvious follow-up if that ceiling is ever reached in practice,
and it is also where a true total would come from.

### IPC

Following the existing naming and the `projectId`-keyed shape of `gitStatus`:

`issuesList`, `issuesGet`, `issuesCreate`, `issuesEdit`, `issuesSetState`, `issuesComment`.

## Keyboard

`⌘Enter` submits create, edit and comment. It is the key `GitPanel` already claims for
commit, so the gesture stays the same across both panels that talk to something outside the
editor.

`Esc` closes the modal, routed through a discard confirm when the body is dirty, reusing the
`mutationGuard` / `ConfirmClosePane` precedent rather than inventing a second one.

`Alt+CmdOrCtrl+I` toggles the column, from a `View` menu checkbox item labelled `Issues`.
`I` is free; the six existing column letters are taken.

Nothing else takes a global binding.

## Mutations are pessimistic

Spinner on the button, then refetch. No optimistic update.

These are network round-trips against a rate limit. A list that briefly lies about an issue's
state is worse than 400ms of honesty.

Failures surface as an inline error strip inside the modal carrying `gh`'s actual stderr, not
a toast that disappears before it can be read.

## What is cut, and why

**Deleting an issue.** `gh issue delete` requires admin on the repository, is irreversible,
and GitHub itself buries it because closing is what people actually mean. Every other verb
originally asked for (list, sort, open detail, change status, search, create, edit) is in.

## Also in scope: the Git column becomes "Git Changes"

The rename touches the `PanelHeading` label, the `PanelStrip` label, and the `View` menu item
`toggle-git` in `src/main/index.ts`. The accelerator and the `ColumnId` (`git`) do not change;
this is a label change, not an identity change.

This document originally added a second item here: give the Git column the same
self-explaining empty state as the Issues column, "which it does not currently have". **That
claim was false when it was written.** `GitPanel.tsx` has rendered `gitpanel-norepo` reading
"Not a git repository." since `ec9e6d9` on 2026-08-06, in the very commit that introduced the
column, and `gitpanel.spec.ts` has asserted it since then too.

So the rename is the whole of the Git work. Adding a second empty state would have produced
two competing elements and a testid breaking the `gitpanel-` convention every other testid in
that file follows.

The lesson is worth more than the correction: a task whose premise is "X is missing" deserves
a check that X is actually missing before it is planned, let alone implemented. Read the code,
not the plan's memory of the code.

## Testing

### Unit, `environment: 'node'`

This is where the real logic is, and the only place it is testable at all given this repo's
vitest runs without a DOM:

- `repo.ts` URL parsing: SSH, HTTPS, `ssh://`, with and without `.git`, Enterprise host.
- The `--json` output to model mapping.
- The stderr-to-`reason` classifier, which decides which of the seven states the user sees.

### E2E

`run.ts` reads `PTERM_GH_BIN`, so the spec points it at a fixture script that echoes canned
JSON and records its argv. That makes the assertions the ones worth making:

- `--repo` is passed on every invocation.
- Close sends `--reason` with an argv element of exactly `completed` or `not planned` from
  the matching control. `execFile` uses no shell, so the space carries no quoting: the value
  is one argv element and must not be wrapped in quote characters.
- A non-zero exit with authentication text in stderr produces the auth screen and not the
  generic one.
- A list that comes back at the limit shows `200+`.

### Blast radius, as predicted and as measured

Predicted: an eighth column shifts the flex row, so `splits.spec.ts`'s pixel constants, which
encode the whole row, would need re-measuring; and `columns.spec.ts` and `menuColumns.spec.ts`
enumerate the column set and would each grow an entry.

**Measured on 2026-08-09, when the column landed: none of that happened.** A full unfiltered
Playwright run stayed at 211 passing. `splits.spec.ts`, `columns.spec.ts` and
`menuColumns.spec.ts` were not touched at all. The only fallout was three order-array literals
in `columnOrder.spec.ts` that enumerate the row explicitly.

The reason is the collapsed-and-hidden default above. A column that occupies no width until
someone opens it cannot move anything the pixel constants measure, and specs that never open
it never see it. That rule was adopted so a new column would not take terminal width unasked;
neutralising the e2e blast radius was an unplanned second benefit, and it is the argument for
keeping the rule if a future column is ever tempted to default to open.

Still outstanding: the Git rename changes user-visible strings that existing specs may assert
on.
