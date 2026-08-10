# Todos column — design

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

Two functions, modelled on `src/main/notes/store.ts`:

- `readTodos(): Promise<TodoRecord[]>` never rejects. A missing file, unreadable
  file, unparseable JSON, or a top-level shape that is not
  `{ version, todos: [] }` all read as `[]`. A malformed *record* inside an
  otherwise good file is dropped rather than failing the whole read: the same
  degrade-don't-throw rule `orderFromStored` and `ConfigStore.read` already
  follow, for the same reason — a hand-edited file should cost the user an
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
frozen at construction, so the channel has to be declared there — it cannot be
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
  unchanged, and no broadcast fires.
- Broadcast walks `BrowserWindow.getAllWindows()` and sends `todosChanged` with
  the new list to every window, the originator included — the payload is
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

One `PRIORITY_DOT: Record<TodoPriority, string>` map of Tailwind classes lives
beside the dot that consumes it.

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
- The hover ✕ marks the todo **done**, not deleted. Delete is destructive and
  irreversible, so it lives in the modal behind a confirm; a destructive action
  revealed by hover is a mis-click away at all times.
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
  (`lib/columnOrder.ts`) gain `'todos'` **last** — right of Notes, at the end of
  the row.
- `App.tsx` gains `todosCollapsed` state stored under `pterm:todosCollapsed`,
  defaulting to collapsed, and a `case 'todos'` in `renderSlot`.
- `src/main/index.ts` View menu gains a `Todos` item with `Alt+CmdOrCtrl+T`
  sending the `toggleTodos` menu command, and `App.tsx` gains the matching
  `case 'toggleTodos'`. ⌥⌘T is free: ⌘T is New Tab and the Tabs column never
  took an accelerator.
- `CommandPalette` gains `Toggle Todos` and `New todo`.
- The width and collapsed keys are added to `attachSavedFields` /
  `src/main/ipc/restore.ts`. A config-only pane field silently vanishes on
  relaunch unless restore names it.

## The modal: `src/renderer/TodoModal.tsx`

Three modes, following `IssueModal`'s structure without the `gh` concerns
(no comments, no labels, no assignees, no repo):

- **Read** — title, priority dot and word, `MarkdownView` of the body,
  created/updated ago-strings, and `Edit` / `Delete` / done-toggle.
- **Edit** — title input, priority as three buttons, body textarea, `Save` /
  `Cancel`. Save is disabled while the trimmed title is empty.
- **Create** — the same fields, empty, priority defaulting to `medium`.
- **Delete** — an inline confirm inside the modal.

Two rules carried from the bug fixed in `IssueModal` this morning (`55bcb73`):

1. **Closing the modal resets every piece of its session state** — `editing`,
   the dirty flag, the draft fields, and the delete-confirm flag. The defect
   that fix addressed was a stale draft rendering under empty state, and an
   orphaned confirm dialog surviving a close. Its regression test is the model
   for this component's.
2. **Mutation errors render as text inside the modal**, not as a toast. A toast
   is gone before it is read.

The dirty guard on Escape and backdrop click is plain local state. It does not
use `lib/mutationGuard.ts`, which exists to keep a `busy` flag from outliving
the *project* a mutation was sent to — a per-project hazard a global list does
not have.

`open`/`creating` are held by `TodosPanel` and handed down, the same split
`IssuesPanel` uses: a row can set the open id directly and the modal hands it
back to `null` on close.

## Tests

**Unit — `tests/unit/todoList.test.ts`:** filter by query (title hit, body hit,
case-insensitivity, whitespace-only query matches everything), by state, by
priority, and the three combined; each of the three sorts; the priority
tie-break on `updatedAt`; sort stability; `nextTodoSort` cycling back round.

**Unit — `tests/unit/todosStore.test.ts`:** missing file → `[]`; unparseable
JSON → `[]`; wrong top-level shape → `[]`; a malformed record dropped while its
good siblings survive; unknown priority normalised to `medium`; round-trip
through `writeTodos`/`readTodos`; no `.tmp` file left behind on success or on a
failed write.

**Unit — mutation behaviour:** create trims the title and refuses an empty one;
update stamps `updatedAt`; an unknown id is a no-op that leaves `updatedAt`
untouched and returns the current list; `setDone` flips only `done` and
`updatedAt`; delete removes exactly one record.

**Integration — broadcast:** one mutation delivers `todosChanged` to two
subscribers.

**E2E — `tests/e2e/todos.spec.ts`:** expand the column from its strip → create a
todo → the row appears with the high-priority dot colour → search filters it →
the priority filter excludes it → the sort toggle reorders → the row opens the
modal → edit and save is reflected in the row → the hover ✕ dims the row →
`Done` shows it and `Open` does not → delete behind the confirm removes it →
after relaunch the surviving list is still there and the column's width and
collapsed state restored.

The spec drives the **strip and the menu command, never ⌥⌘T**: a synthetic
Playwright keypress arrives below the layer Electron matches accelerators at, so
an accelerator test passes whether or not the accelerator is registered.

The expand helper asserts `todos-panel` is present after paint rather than
blind-clicking `todos-toggle`. Strip and heading share that testid, so a second
blind click collapses the column again.

## Known fallout, fixed in the same change

Adding a slot to the flex row changes the terminal's leftover width, and
`tests/e2e/splits.spec.ts` hardcodes pixel constants that encode the whole row.
The last column to land broke five of its tests that way. A collapsed column
still occupies its strip's width, so this happens even though Todos starts
collapsed. Those constants are recomputed as part of this work, not deferred.

## Out of scope

Due dates, tags, subtasks, recurring items, manual drag ordering, per-project
todos, and any link between a todo and a project, pane or session. The list is a
flat global brain-dump; each of those is a separate decision with its own filter
and sort consequences.
