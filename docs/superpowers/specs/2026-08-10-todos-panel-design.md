# Todos column: design

Date: 2026-08-10

A global todo list as its own column, with a modal for reading and editing one
item. Deliberately shaped after the Issues column and `IssueModal`, minus
everything those carry because they talk to `gh`.

## Why it is not the Issues column

Issues are per-project and live on GitHub, so `IssuesPanel` spends most of its
complexity on two problems this column does not have: a reply that may describe
a project the user has already left, and a fetch that takes as long as `gh`
takes. Todos are global, local, and instant. There is no `Result` stamp pairing
a payload with the project and filter it was fetched under, no request-token
ref, no focus refetch, and no "no project selected" empty state. The list is
whatever is on disk.

It is also not the Notes column. A note is one prose blob per project, saved by
a debouncing `noteSaver`; a debounce window is exactly where a second window's
concurrent write gets lost, and a list of records also needs a delete that has
no coalescing story. Todos are mutated one record at a time, by main.

## Data and storage

`~/.pterm/todos.json`, its own file. No `PTermConfig` version bump and no
migration case.

```jsonc
{
  "version": 1,
  "todos": [
    {
      "id": "td_9f3c1a20",
      "title": "Chase invoice for client X",
      "body": "## context\n…markdown…",
      "priority": "high",
      "done": false,
      "createdAt": "2026-08-10T14:02:00.000Z",
      "updatedAt": "2026-08-10T14:02:00.000Z"
    }
  ]
}
```

```ts
export type TodoPriority = 'high' | 'medium' | 'low'

export interface TodoRecord {
  /** `td_` + 8 hex, allocated in main. Never user text. */
  id: string
  /** Trimmed and non-empty: a create or update that empties it is refused. */
  title: string
  /** Markdown. `''` when absent, never null. */
  body: string
  priority: TodoPriority
  done: boolean
  createdAt: string
  updatedAt: string
}

export interface TodoDraft {
  title: string
  body: string
  priority: TodoPriority
}

/** Every field optional: the modal sends only what the user changed. */
export type TodoPatch = Partial<TodoDraft>
```

`TodoRecord`, `TodoPriority`, `TodoDraft` and `TodoPatch` are declared in
`src/shared/ipc.ts` alongside `Preset` and `ColumnId`, because both processes
need them and a second structurally identical declaration in `src/main` would
only invite drift.

### `src/main/todos/store.ts`

Modelled on `src/main/prompts/store.ts`, which is the closest existing thing: a
global JSON file beside `config.json`, an atomic write, a `serialise` queue so
two read-modify-writes in one process cannot lose each other, and mutations that
resolve with the whole new list rather than the changed entry. `notes/store.ts`
supplies only the temp-file-and-rename shape; the queue and the return-the-list
convention come from prompts.

Its read and write halves:

- `readTodos(): Promise<TodoRecord[]>` never rejects. A missing file, unreadable
  file, unparseable JSON, or a top-level shape that is not
  `{ version, todos: [] }` all read as `[]`. A malformed *record* inside an
  otherwise good file is dropped rather than failing the whole read: the same
  degrade-don't-throw rule `orderFromStored` and `ConfigStore.read` already
  follow, for the same reason: a hand-edited file should cost the user an
  entry, not the column.
- `writeTodos(todos: TodoRecord[]): Promise<void>` writes
  `todos.json.<pid>.tmp` in the same directory and renames it over the target,
  removing the temp file if the write throws. Copied from `writeNote`.

Normalisation on read: unknown `priority` becomes `medium`, a missing `body`
becomes `''`, non-string `title` drops the record, a missing timestamp is filled
with the other one (or the epoch if both are absent). `version` is read but not
yet branched on; it exists so a future shape change has somewhere to look.

## IPC surface

Added to `PTermApi` in `src/shared/ipc.ts`, and to the preload bridge (which is
frozen at construction, so the channel has to be declared there, and it cannot be
patched on later):

```ts
todosList(): Promise<TodoRecord[]>
todosCreate(draft: TodoDraft): Promise<TodoRecord[]>
todosUpdate(id: string, patch: TodoPatch): Promise<TodoRecord[]>
todosSetDone(id: string, done: boolean): Promise<TodoRecord[]>
todosDelete(id: string): Promise<TodoRecord[]>
onTodosChanged(cb: (todos: TodoRecord[]) => void): () => void
```

Field-level mutations rather than a whole-list write. A `todosWrite(list)` would
be two handlers instead of five, but a stale renderer array then overwrites a
peer window's concurrent edit, and the broadcast that follows makes the loss
invisible to both windows. Nobody sends a list.

Every mutation resolves with the **new full list**, so the calling window
renders from its own reply and never waits on the event round trip.

Handlers live in `src/main/ipc/register.ts` beside the notes handlers. Each one
is read → apply → write → broadcast:

- `updatedAt` and `id` are stamped in main, never by the renderer, so two
  windows cannot disagree about clock or ordering.
- An unknown `id` on update, `setDone` or delete is a **no-op that still
  resolves with the current list**. A peer window that deleted the same todo a
  moment earlier must not produce an error in the second window.
- A create whose trimmed title is empty is refused: the list comes back
  unchanged. The broadcast still fires, carrying the list every window already
  has. An earlier draft of this section said it did not, and the review of the
  IPC task caught the disagreement with the code. Suppressing it would mean
  either a second copy of the empty-title rule in the handler, or a store that
  reports whether it wrote; a uniform handler shape is worth more than avoiding
  one idempotent push, especially for a keystroke the UI cannot produce, since
  the modal disables Save on an empty title.
- Broadcast walks `BrowserWindow.getAllWindows()` and sends `todosChanged` with
  the new list to every window, the originator included. The payload is
  identical to the reply it already applied, so the extra render is idempotent.

`onTodosChanged` is exposed as an `ipcRenderer.on` subscription returning its
own unsubscribe closure, matching the existing push channels.

## Pure logic: `src/renderer/lib/todoList.ts`

Framework-free, because this repo's vitest runs `environment: 'node'` and
anything touching React or the DOM cannot be unit-tested at all.

```ts
export type TodoSort = 'priority' | 'newest' | 'updated'
export type TodoStateFilter = 'open' | 'done' | 'all'
export type TodoPriorityFilter = 'all' | TodoPriority

export const PRIORITY_RANK: Record<TodoPriority, number> // high 0, medium 1, low 2

export function filterTodos(
  rows: TodoRecord[],
  opts: { query: string; state: TodoStateFilter; priority: TodoPriorityFilter },
): TodoRecord[]

export function sortTodos(rows: TodoRecord[], sort: TodoSort): TodoRecord[]

export function nextTodoSort(current: TodoSort): TodoSort
```

- `query` is a case-insensitive substring test over **title and body**,
  implemented here. It does not use `lib/match.ts`: that module ranks
  `{ name }`-shaped entries for ⌘K and the skills filter, and its scoring has
  no notion of a second searchable field.
- `sortTodos` is stable. `'priority'` orders by `PRIORITY_RANK` and breaks ties
  on `updatedAt` descending, so the top of the list is the most recently touched
  high-priority item.
- `nextTodoSort` cycles `priority → newest → updated → priority`, the same
  single-button pattern `nextSort` uses in `IssuesPanel`.

## Priority colours, and the new `warn` token

Colours are theme tokens, never literals, so the column follows the active
palette like every other pane and the existing theme drift tests keep covering
it:

| priority | token | reads as |
| --- | --- | --- |
| high | `--color-danger` | red |
| medium | `--color-warn` | amber |
| low | `--color-faint` | grey |

`warn` **does not exist yet** and is added by this work. There is no amber token
in `ThemeTokens` today: `accent` is the selection colour and reusing it would
make a medium-priority dot compete with what is selected, and `label` is the
section-heading grey held to 4.5:1 by `labelContrast.test.ts`. Adding the token
touches:

- `ThemeTokens` in `src/shared/themes.ts`, plus a value in all five themes
  (`classic`, `stepped`, `lifted`, `slate`, `lineled`).
- The build-time `@theme` block in `src/renderer/index.css`, because Tailwind v4
  emits a utility only for a token it can see at build time. Runtime
  `applyTheme` overrides the value; the literal there is `classic`'s.
- `tests/unit/themeCss.test.ts`, which holds the `@theme` block equal to
  `THEMES.classic`, and whichever of `themes.test.ts` / `themeApply.test.ts`
  enumerates token keys.

One `PRIORITY_DOT: Record<TodoPriority, string>` map of Tailwind classes carries
the three. It lives in `lib/todoList.ts`, not in the panel that draws it: the
panel imports the modal and the modal draws the same mark, so exporting it from
the panel would make those two files import each other.

## The column: `src/renderer/TodosPanel.tsx`

```
┌ Todos                              + ┐  heading (drag handle) + new
│ 3 open                             ↻ │  count of the live list
│ [ Search todos.................... ] │  data-shortcuts="off"
│ Open  Done  All            Priority  │  state filter + sort toggle
│ All ● Hi ● Med ● Lo                  │  priority filter
├──────────────────────────────────────┤
│ ● Chase invoice for client X      ✕ │  dot = priority, hover ✕ = mark done
│ ● Rewrite onboarding email           │
│ ○ Book flights                       │  done: dimmed + line-through
└──────────────────────────────────────┘
```

- `PanelStrip` when collapsed, `PanelHeading` + `ColumnResizer` when expanded,
  `side`-aware border like every other column in the row.
- Width through `useColumnWidth('pterm:todosWidth')`, taking the 208 default.
  Not Notes' 256: this is a list of short titles, the shape Issues, Git, Skills,
  Presets and Files all take.
- The `+` in the heading is a sibling of `PanelHeading`, not a child: a button
  inside a button is invalid HTML and the inner click would bubble out and
  collapse the column.
- Every text input carries `data-shortcuts="off"`. Without it, ⌘W typed while
  searching closes a pane and destroys its tmux session.
- The hover control marks the todo **done** (`✓`, and `↺` on a done row to
  reopen it), never deleted. Delete is destructive and irreversible, so it lives
  in the modal behind a confirm; a destructive action revealed by hover is a
  mis-click away at all times. A `✕` glyph is deliberately not used: it means
  close-as-completed in the Issues column one seam away, and it reads as delete.
- Two empty states only: `No todos.` and `Nothing matches.` (the latter when the
  query or a filter is what emptied the list).
- Data flow is one `todosList()` on mount plus
  `useEffect(() => window.pterm.onTodosChanged(setTodos), [])`. Pushes replace
  polling, so there is no focus listener and no request token.
- The refresh `↻` re-reads from disk. It is not needed for in-app edits, which
  arrive by broadcast; it is there for a hand-edited `todos.json`.
- Testids: `todos-panel`, `todos-toggle` (shared by strip and heading, the
  established pattern), `todos-new`, `todos-search`, `todos-refresh`,
  `todos-state-open|done|all`, `todos-priority-all|high|medium|low`,
  `todos-sort`, `todos-count`, `todos-list`, `todos-empty-list`,
  `todo-row-<id>`, `todo-done-<id>`. No testid begins with `tab-`: 27+ e2e
  locators count tabs by the `[data-testid^="tab-"]` prefix.

### Wiring the slot in

- `ColumnId` in `src/shared/ipc.ts` gains `'todos'`.
- `COLUMN_IDS` (`lib/columnVisibility.ts`) and `COLUMN_ORDER_DEFAULT`
  (`lib/columnOrder.ts`) gain `'todos'` **last**, right of Notes, at the end of
  the row.
- A column has **three** states in this app, and the new one needs all three
  wired: HIDDEN (the View menu's doing, renders nothing at all), COLLAPSED (the
  heading's doing, renders the 24px strip), and open. So `App.tsx` gains
  `todosCollapsed` under `pterm:todosCollapsed`, an entry in `HIDDEN_KEYS`
  (`pterm:todosHidden`) and in the `hiddenColumns` initialiser, entries in the
  `setColumn` and `COLUMN_KEY` maps, a `toggleTodos` callback beside
  `toggleIssues`, a `collapsedColumns` entry, and a `case 'todos'` in
  `renderSlot`. Both flags default to `true`, so a fresh profile shows nothing
  until ⌥⌘T or the menu item, the same as every other column.
- `src/main/index.ts` View menu gains a `Todos` item with `Alt+CmdOrCtrl+T`
  sending the `toggleTodos` menu command; `MenuCommand` gains `'toggleTodos'`
  and `App.tsx` the matching `case`. The keystroke is *also* handled by the
  renderer's own keydown handler, in the `event.altKey && !event.shiftKey`
  letter map beside `KeyI`/`KeyG`/`KeyN`, because these accelerators are
  registered with `registerAccelerator: false` so the keystroke reaches the
  renderer rather than being claimed by the menu. ⌥⌘T is free: the `KeyT`
  branch above it is guarded on `!event.altKey`, and the Tabs column never took
  an accelerator.
- Widths and collapse flags live in **localStorage**, not in `config.json`
  (`useColumnWidth` and `storedCollapsed` both read it), so there is nothing to
  add to `attachSavedFields` or `restore.ts`, which carry pane fields. The
  relaunch test is what proves the keys are read back.
- `CommandPalette` gains `Toggle Todos` and `New todo`. Note this introduces
  the palette's **first command actions**: today it offers sessions, skills to
  insert, and files, and has no notion of an action that runs something. The
  addition is small because `filterEntries` already matches any `{ name }`
  shape, but it is a new concept in that component rather than another entry in
  an existing list, and it gets its own testid prefix (`palette-command-`)
  rather than reusing `palette-action-`, which belongs to skills.

## The modal: `src/renderer/TodoModal.tsx`

Three modes, following `IssueModal`'s structure without the `gh` concerns
(no comments, no labels, no assignees, no repo):

- **Read**: title, priority dot and word, `MarkdownView` of the body,
  created/updated ago-strings, and `Edit` / `Delete` / done-toggle.
- **Edit**: title input, priority as three buttons, body textarea, `Save` /
  `Cancel`. Save is disabled while the trimmed title is empty.
- **Create**: the same fields, empty, priority defaulting to `medium`.
- **Delete**: an inline confirm inside the modal.

Two rules carried from the bug fixed in `IssueModal` this morning (`55bcb73`):

1. **Closing the modal resets every piece of its session state**: `editing`,
   the dirty flag, the draft fields, and the delete-confirm flag. The defect
   that fix addressed was a stale draft rendering under empty state, and an
   orphaned confirm dialog surviving a close. Its regression test is the model
   for this component's.
2. **Mutation errors render as text inside the modal**, not as a toast. A toast
   is gone before it is read.

The dirty guard on Escape and backdrop click is plain local state. It does not
use `lib/mutationGuard.ts`, which exists to keep a `busy` flag from outliving
the *project* a mutation was sent to, a per-project hazard a global list does
not have.

`open`/`creating` are held by `TodosPanel` and handed down, the same split
`IssuesPanel` uses: a row can set the open id directly and the modal hands it
back to `null` on close.

## Tests

**Unit, `tests/unit/todoList.test.ts`:** filter by query (title hit, body hit,
case-insensitivity, whitespace-only query matches everything), by state, by
priority, and the three combined; each of the three sorts; the priority
tie-break on `updatedAt`; sort stability; `nextTodoSort` cycling back round.

**Unit, `tests/unit/todosStore.test.ts`:** missing file → `[]`; unparseable
JSON → `[]`; wrong top-level shape → `[]`; a malformed record dropped while its
good siblings survive; unknown priority normalised to `medium`; round-trip
through `writeTodos`/`readTodos`; no `.tmp` file left behind on success or on a
failed write.

**Unit, mutation behaviour:** create trims the title and refuses an empty one;
update stamps `updatedAt`; an unknown id is a no-op that leaves `updatedAt`
untouched and returns the current list; `setDone` flips only `done` and
`updatedAt`; delete removes exactly one record.

**Unit, broadcast:** the window-fan-out is extracted as
`broadcastTodos(windows, todos)` over a structural `{ isDestroyed, webContents }`
target, so a node-environment test can assert that two live windows both receive
the payload and a destroyed one is skipped rather than throwing. That is as far
as automation reaches: `ipcMain` and a real second `BrowserWindow` cannot be
constructed in vitest, and the e2e suite drives one window. **Nothing proves two
real windows sync**; that check belongs to the hand pass, and is named here so it
is not mistaken for covered.

**E2E, `tests/e2e/todos.spec.ts`:** open the column → create a todo → the row
appears with the high-priority dot colour → search filters it → the priority
filter excludes it → the sort toggle reorders → the row opens the modal → edit
and save is reflected in the row → the hover ✕ dims the row → `Done` shows it
and `Open` does not → delete behind the confirm removes it → after relaunch the
surviving list is still there and the column's width and collapse state
restored.

`⌥⌘T` **is** testable here, unlike a real Electron accelerator: the menu
registers it with `registerAccelerator: false` and the renderer's own keydown
handler is what acts on it, so a synthetic `Alt+Meta+t` reaches the same code
path a user's keystroke does. `expandColumn` in `tests/e2e/harness.ts` already
relies on exactly that for hidden columns, and gains `todos: 't'` in its
`COLUMN_KEY` map plus `'todos'` in its `name` union.

The spec goes through `expandColumn` rather than clicking `todos-toggle`
directly. That helper waits for the titlebar to paint, returns early if the
panel is already open, and picks the shortcut or the strip depending on which of
the three states the column is in. A blind click on `todos-toggle` (shared by
strip and heading) collapses an already-open column instead of opening it.

## Fallout to verify, not assume

`tests/e2e/splits.spec.ts` hardcodes pixel arithmetic for the whole row, and a
new column has broken it before. It should **not** break this time: both of the
new column's flags default to `true`, and a HIDDEN column renders nothing at all
(not even a strip), so a fresh profile, which is what every test in that file
launches with, has exactly the pixels it has today. That file's own comment
records the same reasoning for the six columns before it. The change still runs
`splits.spec.ts` and treats a red there as a real finding rather than expected
churn.

## Out of scope

Due dates, tags, subtasks, recurring items, manual drag ordering, per-project
todos, and any link between a todo and a project, pane or session. The list is a
flat global brain-dump; each of those is a separate decision with its own filter
and sort consequences.
