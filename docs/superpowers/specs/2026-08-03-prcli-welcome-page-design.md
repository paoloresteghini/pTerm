# Welcome page

The pane area is blank whenever nothing is running in it. On a first launch that
blankness is the whole app: a dark rectangle with a sidebar that has no projects
in it yet and a tab bar with no tabs. Today the only thing in that rectangle is
one grey sentence, `No projects yet. Add one to open a terminal.`, and it appears
under a single condition — zero projects — so a user who has projects but has
just closed their last session gets nothing at all.

This replaces that sentence with a welcome page: a wordmark, a one-line
statement of what the app is for, the three shortcuts that create panes, and a
hint line that says what to do next from wherever the user actually is.

## What it is not

Not a route, not an overlay, not a dismissible first-run screen with persisted
state. It is what the pane area shows when the pane area has nothing to show, on
the same footing as the sentence it replaces. It comes back every time the
condition holds again, because the condition holding again is exactly when the
hint is useful again.

Nothing on it is clickable. The shortcut row's job is to teach three keystrokes;
a row of buttons would teach a user to reach for the mouse, which is the
opposite. The sidebar and the tab bar's `+` already carry every action a click
would duplicate, and both stay on screen underneath.

## Where it renders

`src/renderer/Welcome.tsx`, a new presentational component with no state and no
IPC, rendered from `App.tsx` inside the existing pane container — the
`relative min-h-0 flex-1` div that currently holds the empty-state paragraph and
the pane groups.

Inside that container and not above the whole window. The way out of an empty
pane area is to pick or add a project, and that is the sidebar; a full-window
welcome would cover the one control it is telling the user to use.

`App.tsx` is 853 lines. The markup goes in its own file rather than inline for
that reason alone.

## When it shows

`App.tsx` calls `paneGroups(state)` inline in its render. Hoist that to a const
and derive the condition from it:

```ts
const groups = paneGroups(state)
const showWelcome = !groups.some((group) => group.visible)
```

"No visible pane group" rather than "no projects" or "no tabs", because it is
the literal statement of the thing being replaced: the pane area is empty. It
subsumes the current zero-projects case, adds the case of a selected project
whose tabs are all closed, and stays correct in the corner where a tab exists
but `paneGroups` emits no group for it — its kids were all boxed by an earlier
row, so `panes.length === 0` and the group is skipped (`workspace.ts:667`).

## Content

A centred stack:

- **pTerm** — the wordmark, `text-fg`.
- `Manage Claude Code sessions across clients and departments.` — `text-muted`.
- The shortcut row: three items, `font-mono text-[11px]`, hairline dividers
  between them (not after the last), each a glyph, a keycap in
  `bg-surface border-border`, and a label in `text-faint`:

  | glyph | keys | label |
  |---|---|---|
  | `+` | `Cmd+T` | new session |
  | `▯` | `Cmd+D` | split right |
  | `⊟` | `Cmd+Shift+D` | split down |

- The hint line: a `>_` prefix and one sentence, `text-faint`.

The keys are written as `Cmd+T`, not `⌘T`. They are being read as instructions
rather than recognised on a menu, and the spelled form is what the rest of this
screen's register is.

Those three are the shortcuts that put a pane on screen, which is what a user
staring at no panes needs. ⌘W, ⌘⌥arrow, ⌘⇧\ and ⌘, all exist and are all absent
here: none of them does anything when there is nothing running.

### The name

The wordmark reads `pTerm`. This is welcome-page copy only. `package.json`'s
`name` and `productName`, `index.html`'s `<title>`, and the forge output names
stay `prcli` / `PRCLI`. The window title and menu bar are untouched, and nothing
about where the app stores state on disk moves.

## The hint line

One string, chosen by a new pure selector in `workspace.ts` beside the other
state selectors:

```ts
export function welcomeHint(state: WorkspaceState): string
```

It lives there rather than in the component so it can be tested against a
`WorkspaceState` without a DOM, which is how every other derivation in this app
is tested.

Its cases mirror `canOpen`'s three-part test in `App.tsx`
(`Boolean(project) && project?.id !== UNSORTED_ID && project?.available === true`),
because the hint is the sentence form of that predicate — what is missing, said
out loud:

| state | hint |
|---|---|
| `projects.length === 0` | `select a working directory to start` |
| active project exists, is not Unsorted, `available === true` | `press Cmd+T to start a session` |
| no active project, or the active one is Unsorted | `select a project to start` |
| active project has `available === false` | `<cwd> is missing` |

Order matters: the zero-projects case is checked first, since with no projects
there is also no active project and the third row would otherwise claim it and
say something true but useless.

Unsorted is grouped with "no active project" rather than given its own line.
Unsorted is not a directory and cannot launch anything; the only move from it is
to pick a real project, which is what the shared sentence says.

The missing-cwd case names the path and reuses the wording already on the
sidebar's `!` marker (`Sidebar.tsx:130`, `title={`${project.cwd} is missing`}`).
Two different sentences for one condition would read as two conditions.

## Testing

`welcomeHint` gets unit tests in `tests/unit/workspace.test.ts`, one per row of
the table above, including the ordering case: a state with zero projects and no
`activeProjectId` must produce the working-directory sentence and not the
pick-a-project one.

The e2e assertion at `tests/e2e/projects.spec.ts:163` currently waits on
`getByTestId('empty-state')`. The component's testid is `welcome`, and the hint
line carries `welcome-hint`, so that line changes to match. It is the same
assertion about the same moment — a fresh launch with no projects — so it keeps
its place in that spec rather than becoming a new test.

One e2e addition: after a session is opened, `welcome` is gone; after its last
pane is closed, `welcome` is back. That round trip is the behaviour this design
adds over the sentence it replaces, and no unit test can see it, since it is
`showWelcome` reading `paneGroups`' output through a real render.

## Files

| file | change |
|---|---|
| `src/renderer/Welcome.tsx` | new — the markup, props `hint: string` |
| `src/renderer/workspace.ts` | new export `welcomeHint` |
| `src/renderer/App.tsx` | hoist `paneGroups` to a const, replace the empty-state `<p>` with `<Welcome>` |
| `tests/unit/workspace.test.ts` | four `welcomeHint` cases |
| `tests/e2e/projects.spec.ts` | testid at line 163; new open/close round trip |
