# Todos Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global todo list as its own column, with a modal for reading, creating, editing and deleting one item, priority colours, and client-side search / filter / sort.

**Architecture:** Main owns `~/.pterm/todos.json` and is the only writer: five field-level IPC mutations each read, apply, write atomically, resolve with the whole new list, and broadcast it to every window. The renderer holds the list in `TodosPanel`, subscribes to the broadcast, and does all filtering and sorting client-side through a pure, node-testable `lib/todoList.ts`. The column is a fourth sibling of Issues/Git/Notes in the existing draggable row.

**Tech Stack:** Electron 43, React, TypeScript, Tailwind v4, CodeMirror 6 (markdown body), Radix Dialog, vitest (`environment: 'node'`), Playwright (`_electron`).

Spec: `docs/superpowers/specs/2026-08-10-todos-panel-design.md`.

## Global Constraints

- **No em dashes** anywhere: code, comments, copy, commit messages. Use commas, colons, parentheses or separate sentences.
- **Every text input and textarea carries `data-shortcuts="off"`.** Without it, ⌘W typed while the field has focus closes a pane and destroys its tmux session.
- **Comments must be true of the code as it stands in the branch**, not just at the commit that introduces them. Do not write a comment asserting a property you have not measured.
- **A column has three states**: HIDDEN (renders nothing), COLLAPSED (24px strip), open. Both new flags default to `true`.
- **Colours come from theme tokens**, never hex literals in components.
- Unit tests: `npx vitest run <path>`. Full unit suite: `npm test`. E2E: `npx playwright test tests/e2e/<file>`. Typecheck: `npm run typecheck`.
- vitest runs `environment: 'node'`: there is no DOM and no React rendering test in this repo. Anything that must be unit-tested has to live in a pure module.
- Priority amber is `#fbbf24` in all five themes, matching how `danger` and `ok` already carry one value across the registry.

---

### Task 1: Shared types and the todos store

**Files:**
- Modify: `src/shared/ipc.ts` (types only, beside `Preset` / `ColumnId`)
- Create: `src/main/todos/store.ts`
- Test: `tests/unit/todos.test.ts`

**Interfaces:**
- Consumes: `configRoot()` from `src/main/state/store.ts`.
- Produces:
  - `TodoPriority = 'high' | 'medium' | 'low'`, `TodoRecord`, `TodoDraft`, `TodoPatch` in `src/shared/ipc.ts`
  - `todosPath(): string`
  - `readTodos(): Promise<TodoRecord[]>`
  - `createTodo(draft: TodoDraft): Promise<TodoRecord[]>`
  - `updateTodo(id: string, patch: TodoPatch): Promise<TodoRecord[]>`
  - `setTodoDone(id: string, done: boolean): Promise<TodoRecord[]>`
  - `deleteTodo(id: string): Promise<TodoRecord[]>`

- [ ] **Step 1: Add the wire types**

In `src/shared/ipc.ts`, next to the `Preset` interface:

```ts
export type TodoPriority = 'high' | 'medium' | 'low'

/**
 * One item on the global todo list.
 *
 * Global rather than per project: this is the user's own brain-dump, and the
 * Notes column is where per-project text lives. `id` is app-allocated and
 * never user text, the same rule `PromptEntry` follows.
 */
export interface TodoRecord {
  id: string
  /** Trimmed and non-empty. A create or update that would empty it is refused. */
  title: string
  /** Markdown. `''` for no body, never null. */
  body: string
  priority: TodoPriority
  done: boolean
  createdAt: string
  updatedAt: string
}

/** What the modal sends to create one: everything the user can type. */
export interface TodoDraft {
  title: string
  body: string
  priority: TodoPriority
}

/** Every field optional: an edit sends only what changed. */
export type TodoPatch = Partial<TodoDraft>
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/todos.test.ts`. `PTERM_CONFIG_DIR` is read at call time by `configRoot()`, so pointing it at a temp dir per test is all the isolation this needs, the same pairing `tests/unit/notes.test.ts` uses.

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createTodo,
  deleteTodo,
  readTodos,
  setTodoDone,
  todosPath,
  updateTodo,
} from '../../src/main/todos/store'

let dir: string
let previousConfigDir: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pterm-todos-'))
  previousConfigDir = process.env.PTERM_CONFIG_DIR
  process.env.PTERM_CONFIG_DIR = dir
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.PTERM_CONFIG_DIR
  else process.env.PTERM_CONFIG_DIR = previousConfigDir
  await rm(dir, { recursive: true, force: true })
})

describe('readTodos', () => {
  it('resolves to an empty list when no file exists', async () => {
    expect(await readTodos()).toEqual([])
  })

  it('resolves to an empty list for unparseable JSON', async () => {
    await writeFile(todosPath(), '{ not json')
    expect(await readTodos()).toEqual([])
  })

  it('resolves to an empty list when the top level is not the expected shape', async () => {
    await writeFile(todosPath(), JSON.stringify({ version: 1, todos: 'nope' }))
    expect(await readTodos()).toEqual([])
  })

  it('drops a malformed record and keeps its good siblings', async () => {
    await writeFile(
      todosPath(),
      JSON.stringify({
        version: 1,
        todos: [
          { id: 'td_1', title: 'keep me', body: '', priority: 'low', done: false, createdAt: 'a', updatedAt: 'a' },
          { id: 'td_2', body: 'no title' },
        ],
      }),
    )
    const todos = await readTodos()
    expect(todos.map((todo) => todo.id)).toEqual(['td_1'])
  })

  it('normalises an unknown priority to medium and a missing body to empty', async () => {
    await writeFile(
      todosPath(),
      JSON.stringify({
        version: 1,
        todos: [{ id: 'td_1', title: 't', priority: 'urgent', done: false, createdAt: 'a', updatedAt: 'a' }],
      }),
    )
    const [todo] = await readTodos()
    expect(todo.priority).toBe('medium')
    expect(todo.body).toBe('')
  })
})

describe('createTodo', () => {
  it('appends a todo and returns the list as it now stands', async () => {
    const todos = await createTodo({ title: 'chase invoice', body: 'context', priority: 'high' })
    expect(todos).toHaveLength(1)
    expect(todos[0].title).toBe('chase invoice')
    expect(todos[0].priority).toBe('high')
    expect(todos[0].done).toBe(false)
    expect(await readTodos()).toEqual(todos)
  })

  it('trims the title', async () => {
    const [todo] = await createTodo({ title: '  padded  ', body: '', priority: 'low' })
    expect(todo.title).toBe('padded')
  })

  it('refuses a whitespace-only title without writing a file', async () => {
    expect(await createTodo({ title: '   ', body: 'x', priority: 'low' })).toEqual([])
    expect(await readdir(dir)).toEqual([])
  })

  it('leaves only the JSON file behind, never the temp file', async () => {
    await createTodo({ title: 'a', body: '', priority: 'low' })
    expect(await readdir(dir)).toEqual(['todos.json'])
  })
})

describe('updateTodo', () => {
  it('applies only the fields the patch carries and advances updatedAt', async () => {
    const [before] = await createTodo({ title: 'a', body: 'body', priority: 'low' })
    const [after] = await updateTodo(before.id, { title: 'b' })
    expect(after.title).toBe('b')
    expect(after.body).toBe('body')
    expect(after.priority).toBe('low')
    expect(after.createdAt).toBe(before.createdAt)
    expect(Date.parse(after.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt))
  })

  it('refuses a patch that would empty the title', async () => {
    const [before] = await createTodo({ title: 'a', body: '', priority: 'low' })
    const [after] = await updateTodo(before.id, { title: '  ' })
    expect(after.title).toBe('a')
  })

  it('is a no-op for an unknown id and still returns the current list', async () => {
    const created = await createTodo({ title: 'a', body: '', priority: 'low' })
    expect(await updateTodo('td_missing', { title: 'b' })).toEqual(created)
  })
})

describe('setTodoDone', () => {
  it('flips done and leaves the rest of the record alone', async () => {
    const [before] = await createTodo({ title: 'a', body: 'b', priority: 'high' })
    const [after] = await setTodoDone(before.id, true)
    expect(after.done).toBe(true)
    expect(after.title).toBe('a')
    expect(after.body).toBe('b')
    expect(after.priority).toBe('high')
  })

  it('is a no-op for an unknown id', async () => {
    const created = await createTodo({ title: 'a', body: '', priority: 'low' })
    expect(await setTodoDone('td_missing', true)).toEqual(created)
  })
})

describe('deleteTodo', () => {
  it('removes exactly the named record', async () => {
    const [first] = await createTodo({ title: 'first', body: '', priority: 'low' })
    await createTodo({ title: 'second', body: '', priority: 'low' })
    const left = await deleteTodo(first.id)
    expect(left.map((todo) => todo.title)).toEqual(['second'])
  })

  it('is a no-op for an unknown id', async () => {
    const created = await createTodo({ title: 'a', body: '', priority: 'low' })
    expect(await deleteTodo('td_missing')).toEqual(created)
  })
})
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run tests/unit/todos.test.ts`
Expected: FAIL, cannot resolve `../../src/main/todos/store`.

- [ ] **Step 4: Write the store**

Create `src/main/todos/store.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { configRoot } from '../state/store'
import type { TodoDraft, TodoPatch, TodoPriority, TodoRecord } from '../../shared/ipc'

/**
 * The global todo list, a file of its own beside `config.json`.
 *
 * Same reasoning as `prompts/store.ts`: `PTermConfig` is versioned and its
 * migrations sit on the path that decides what survives a relaunch, and this
 * list is read by nothing else. `configRoot()` is read at call time, not at
 * import, so a test pointing `PTERM_CONFIG_DIR` at a temp dir gets its own
 * file.
 */
export function todosPath(): string {
  return join(configRoot(), 'todos.json')
}

interface TodosFile {
  /** Read but not yet branched on: it exists so a shape change has somewhere to look. */
  version: number
  todos: TodoRecord[]
}

const PRIORITIES: readonly TodoPriority[] = ['high', 'medium', 'low']

function isPriority(candidate: unknown): candidate is TodoPriority {
  return typeof candidate === 'string' && (PRIORITIES as readonly string[]).includes(candidate)
}

/**
 * One record that survived parsing, or null.
 *
 * A title is the only field a record cannot be repaired without, so a missing
 * one drops the entry and everything else degrades to a default. One bad hand
 * edit costs the user that entry, not the column: the rule `readPrompts` and
 * `orderFromStored` already follow.
 */
function validate(candidate: unknown): TodoRecord | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const { id, title, body, priority, done, createdAt, updatedAt } = candidate as Partial<TodoRecord>
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof title !== 'string' || title.trim().length === 0) return null
  const created = typeof createdAt === 'string' ? createdAt : null
  const updated = typeof updatedAt === 'string' ? updatedAt : null
  const stamp = created ?? updated ?? new Date(0).toISOString()
  return {
    id,
    title,
    body: typeof body === 'string' ? body : '',
    priority: isPriority(priority) ? priority : 'medium',
    done: done === true,
    createdAt: created ?? stamp,
    updatedAt: updated ?? stamp,
  }
}

/** Every todo, in the order the file holds them. Never rejects. */
export async function readTodos(): Promise<TodoRecord[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(todosPath(), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return []
    const { todos } = parsed as Partial<TodosFile>
    if (!Array.isArray(todos)) return []
    return todos.map(validate).filter((todo): todo is TodoRecord => todo !== null)
  } catch {
    return []
  }
}

/** Atomic, like `prompts/store.ts`: this is text the user cannot get back. */
async function write(todos: TodoRecord[]): Promise<void> {
  const path = todosPath()
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  const body: TodosFile = { version: 1, todos }
  try {
    await writeFile(temp, JSON.stringify(body, null, 2), 'utf8')
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

/**
 * Serialises every mutation in this process against every other, exactly as
 * `prompts/store.ts` does: all five below are read-modify-write, and two
 * windows interleaving them would lose whichever read first. It does NOT
 * defend against a second pTerm process, the same bound `ConfigStore`'s own
 * queue has.
 */
let queue: Promise<unknown> = Promise.resolve()
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

/** `td_` + 8 hex. App-allocated, so it is never user text. */
function allocateId(): string {
  return `td_${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

/**
 * Append a todo and return the list as it now stands on disk.
 *
 * The whole list rather than the new entry, for `addPrompt`'s reason: the
 * renderer holds this list and would otherwise have to guess where the new one
 * went. An empty title is refused rather than stored, and refusing writes
 * nothing at all.
 */
export function createTodo(draft: TodoDraft): Promise<TodoRecord[]> {
  return serialise(async () => {
    const title = draft.title.trim()
    const existing = await readTodos()
    if (title.length === 0) return existing
    const stamp = new Date().toISOString()
    const todo: TodoRecord = {
      id: allocateId(),
      title,
      body: draft.body,
      priority: draft.priority,
      done: false,
      createdAt: stamp,
      updatedAt: stamp,
    }
    const todos = [...existing, todo]
    await write(todos)
    return todos
  })
}

/**
 * Apply `patch` to one todo. An unknown id is a no-op that still answers with
 * the current list: a peer window that deleted the same todo a moment earlier
 * must not turn into an error in this one.
 */
export function updateTodo(id: string, patch: TodoPatch): Promise<TodoRecord[]> {
  return serialise(async () => {
    const before = await readTodos()
    if (!before.some((todo) => todo.id === id)) return before
    // A patch that would empty the title keeps the stored one: the modal
    // disables Save for an empty field, and this is the same rule enforced
    // where it cannot be bypassed.
    const title = patch.title === undefined ? undefined : patch.title.trim()
    const after = before.map((todo) =>
      todo.id === id
        ? {
            ...todo,
            title: title !== undefined && title.length > 0 ? title : todo.title,
            body: patch.body ?? todo.body,
            priority: patch.priority ?? todo.priority,
            updatedAt: new Date().toISOString(),
          }
        : todo,
    )
    await write(after)
    return after
  })
}

/** Mark done or not done. Unknown ids are a no-op, as in `updateTodo`. */
export function setTodoDone(id: string, done: boolean): Promise<TodoRecord[]> {
  return serialise(async () => {
    const before = await readTodos()
    if (!before.some((todo) => todo.id === id)) return before
    const after = before.map((todo) =>
      todo.id === id ? { ...todo, done, updatedAt: new Date().toISOString() } : todo,
    )
    await write(after)
    return after
  })
}

/** Drop one todo. Unknown ids are a no-op and write nothing. */
export function deleteTodo(id: string): Promise<TodoRecord[]> {
  return serialise(async () => {
    const before = await readTodos()
    const after = before.filter((todo) => todo.id !== id)
    if (after.length !== before.length) await write(after)
    return after
  })
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/unit/todos.test.ts`
Expected: PASS, all cases.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc.ts src/main/todos/store.ts tests/unit/todos.test.ts
git commit -m "Add the global todos store"
```

---

### Task 2: The pure list logic

**Files:**
- Create: `src/renderer/lib/todoList.ts`
- Test: `tests/unit/todoList.test.ts`

**Interfaces:**
- Consumes: `TodoPriority`, `TodoRecord` from `src/shared/ipc.ts` (Task 1).
- Produces: `TodoSort`, `TodoStateFilter`, `TodoPriorityFilter`, `PRIORITY_RANK`, `PRIORITY_LABEL`, `PRIORITY_DOT`, `filterTodos(rows, opts)`, `sortTodos(rows, sort)`, `nextTodoSort(current)`, `SORT_LABEL`.

`PRIORITY_DOT` lives here, in the pure module, rather than in `TodosPanel.tsx` where it is first used. The panel imports the modal and the modal needs the same map, so exporting it from the panel would make the two files import each other: a cycle that happens to work today because the map is only read at render time, and breaks the moment either file reads the other's export during module initialisation. A Tailwind class map has no React in it, so it belongs in the module that neither of them can cycle through.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/todoList.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { TodoPriority, TodoRecord } from '../../src/shared/ipc'
import {
  filterTodos,
  nextTodoSort,
  sortTodos,
  type TodoSort,
} from '../../src/renderer/lib/todoList'

/** A record with only the fields these rules read spelled out per case. */
function todo(overrides: Partial<TodoRecord> & { id: string }): TodoRecord {
  return {
    title: 'title',
    body: '',
    priority: 'medium' as TodoPriority,
    done: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

const OPEN = { query: '', state: 'open' as const, priority: 'all' as const }

describe('filterTodos', () => {
  it('matches the query against the title, case-insensitively', () => {
    const rows = [todo({ id: 'a', title: 'Chase Invoice' }), todo({ id: 'b', title: 'Book flights' })]
    expect(filterTodos(rows, { ...OPEN, query: 'invoice' }).map((row) => row.id)).toEqual(['a'])
  })

  it('matches the query against the body too', () => {
    const rows = [todo({ id: 'a', body: 'ring the accountant' }), todo({ id: 'b' })]
    expect(filterTodos(rows, { ...OPEN, query: 'accountant' }).map((row) => row.id)).toEqual(['a'])
  })

  it('treats a whitespace-only query as no query', () => {
    const rows = [todo({ id: 'a' }), todo({ id: 'b' })]
    expect(filterTodos(rows, { ...OPEN, query: '   ' })).toHaveLength(2)
  })

  it('shows open rows only under the open filter', () => {
    const rows = [todo({ id: 'a' }), todo({ id: 'b', done: true })]
    expect(filterTodos(rows, OPEN).map((row) => row.id)).toEqual(['a'])
  })

  it('shows done rows only under the done filter', () => {
    const rows = [todo({ id: 'a' }), todo({ id: 'b', done: true })]
    expect(filterTodos(rows, { ...OPEN, state: 'done' }).map((row) => row.id)).toEqual(['b'])
  })

  it('shows both under the all filter', () => {
    const rows = [todo({ id: 'a' }), todo({ id: 'b', done: true })]
    expect(filterTodos(rows, { ...OPEN, state: 'all' })).toHaveLength(2)
  })

  it('narrows to one priority', () => {
    const rows = [todo({ id: 'a', priority: 'high' }), todo({ id: 'b', priority: 'low' })]
    expect(filterTodos(rows, { ...OPEN, priority: 'high' }).map((row) => row.id)).toEqual(['a'])
  })

  it('applies query, state and priority together', () => {
    const rows = [
      todo({ id: 'a', title: 'invoice', priority: 'high' }),
      todo({ id: 'b', title: 'invoice', priority: 'high', done: true }),
      todo({ id: 'c', title: 'invoice', priority: 'low' }),
      todo({ id: 'd', title: 'flights', priority: 'high' }),
    ]
    expect(filterTodos(rows, { query: 'invoice', state: 'open', priority: 'high' }).map((row) => row.id)).toEqual(['a'])
  })
})

describe('sortTodos', () => {
  it('orders by priority, high first', () => {
    const rows = [
      todo({ id: 'low', priority: 'low' }),
      todo({ id: 'high', priority: 'high' }),
      todo({ id: 'medium', priority: 'medium' }),
    ]
    expect(sortTodos(rows, 'priority').map((row) => row.id)).toEqual(['high', 'medium', 'low'])
  })

  it('breaks a priority tie on the most recently updated', () => {
    const rows = [
      todo({ id: 'older', priority: 'high', updatedAt: '2026-08-01T00:00:00.000Z' }),
      todo({ id: 'newer', priority: 'high', updatedAt: '2026-08-09T00:00:00.000Z' }),
    ]
    expect(sortTodos(rows, 'priority').map((row) => row.id)).toEqual(['newer', 'older'])
  })

  it('orders by created descending under newest', () => {
    const rows = [
      todo({ id: 'first', createdAt: '2026-08-01T00:00:00.000Z' }),
      todo({ id: 'second', createdAt: '2026-08-09T00:00:00.000Z' }),
    ]
    expect(sortTodos(rows, 'newest').map((row) => row.id)).toEqual(['second', 'first'])
  })

  it('orders by updated descending under updated', () => {
    const rows = [
      todo({ id: 'stale', updatedAt: '2026-08-01T00:00:00.000Z' }),
      todo({ id: 'fresh', updatedAt: '2026-08-09T00:00:00.000Z' }),
    ]
    expect(sortTodos(rows, 'updated').map((row) => row.id)).toEqual(['fresh', 'stale'])
  })

  it('is stable for rows the sort cannot separate', () => {
    const rows = [todo({ id: 'a' }), todo({ id: 'b' }), todo({ id: 'c' })]
    expect(sortTodos(rows, 'priority').map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate its input', () => {
    const rows = [todo({ id: 'low', priority: 'low' }), todo({ id: 'high', priority: 'high' })]
    sortTodos(rows, 'priority')
    expect(rows.map((row) => row.id)).toEqual(['low', 'high'])
  })
})

describe('nextTodoSort', () => {
  it('cycles through the three and back round', () => {
    const seen: TodoSort[] = ['priority']
    for (let index = 0; index < 3; index += 1) seen.push(nextTodoSort(seen[seen.length - 1]))
    expect(seen).toEqual(['priority', 'newest', 'updated', 'priority'])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/todoList.test.ts`
Expected: FAIL, cannot resolve `../../src/renderer/lib/todoList`.

- [ ] **Step 3: Write the module**

Create `src/renderer/lib/todoList.ts`:

```ts
import type { TodoPriority, TodoRecord } from '../../shared/ipc'

/**
 * Search, filter and sort for the Todos column.
 *
 * Pure and framework-free for the reason `issueList.ts` and `columnOrder.ts`
 * are: this repo's vitest runs `environment: 'node'`, so logic that lives
 * inside a component cannot be unit-tested at all.
 *
 * Every rule here runs over the whole list in memory. There is no server-side
 * query and no truncated reply to caption, unlike Issues: this file is the
 * user's own list and is hundreds of rows at worst.
 */

export type TodoSort = 'priority' | 'newest' | 'updated'
export type TodoStateFilter = 'open' | 'done' | 'all'
export type TodoPriorityFilter = 'all' | TodoPriority

/** Lower sorts first, so `high` leads. */
export const PRIORITY_RANK: Record<TodoPriority, number> = { high: 0, medium: 1, low: 2 }

/**
 * The priority mark's colour, one Tailwind class per level.
 *
 * Tokens rather than literals, so the dot follows the active palette like
 * everything else in the window: `themeCss.test.ts` and `themes.test.ts` are
 * what keep these three readable in all five themes.
 *
 * Here rather than in `TodosPanel.tsx`, which is where it is drawn: the panel
 * imports the modal and the modal draws the same mark, so exporting it from
 * the panel would make those two files import each other.
 */
export const PRIORITY_DOT: Record<TodoPriority, string> = {
  high: 'bg-danger',
  medium: 'bg-warn',
  low: 'bg-faint',
}

export const PRIORITY_LABEL: Record<TodoPriority, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
}

export const SORT_LABEL: Record<TodoSort, string> = {
  priority: 'Priority',
  newest: 'Newest',
  updated: 'Updated',
}

const SORT_ORDER: readonly TodoSort[] = ['priority', 'newest', 'updated']

/** The single sort button's cycle, the same shape `IssuesPanel`'s `nextSort` has. */
export function nextTodoSort(current: TodoSort): TodoSort {
  return SORT_ORDER[(SORT_ORDER.indexOf(current) + 1) % SORT_ORDER.length]
}

/**
 * Whether one row answers the query.
 *
 * Title and body, case-insensitive substring. Deliberately not `lib/match.ts`:
 * that module RANKS `{ name }`-shaped entries for ⌘K and the skills filter,
 * and has no notion of a second searchable field.
 */
function matches(todo: TodoRecord, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === '') return true
  return todo.title.toLowerCase().includes(needle) || todo.body.toLowerCase().includes(needle)
}

export function filterTodos(
  rows: TodoRecord[],
  opts: { query: string; state: TodoStateFilter; priority: TodoPriorityFilter },
): TodoRecord[] {
  return rows.filter((todo) => {
    if (opts.state === 'open' && todo.done) return false
    if (opts.state === 'done' && !todo.done) return false
    if (opts.priority !== 'all' && todo.priority !== opts.priority) return false
    return matches(todo, opts.query)
  })
}

/** Epoch millis, or 0 for a stamp that will not parse. */
function stamp(iso: string): number {
  const parsed = Date.parse(iso)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * A sorted copy, never the caller's array.
 *
 * `Array.prototype.sort` is stable in every engine this app runs on, which is
 * what leaves rows the comparator cannot separate in the order the file holds
 * them. `priority` breaks its ties on `updatedAt` descending, so the top of
 * the list is the high-priority item touched most recently.
 */
export function sortTodos(rows: TodoRecord[], sort: TodoSort): TodoRecord[] {
  const copy = [...rows]
  switch (sort) {
    case 'priority':
      return copy.sort(
        (a, b) =>
          PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
          stamp(b.updatedAt) - stamp(a.updatedAt),
      )
    case 'newest':
      return copy.sort((a, b) => stamp(b.createdAt) - stamp(a.createdAt))
    case 'updated':
      return copy.sort((a, b) => stamp(b.updatedAt) - stamp(a.updatedAt))
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/unit/todoList.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/todoList.ts tests/unit/todoList.test.ts
git commit -m "Add search, filter and sort for the todo list"
```

---

### Task 3: The `warn` theme token

**Files:**
- Modify: `src/shared/themes.ts` (the `ThemeTokens` interface, and all five entries in `THEMES`)
- Modify: `src/renderer/index.css` (the build-time `@theme` block)
- Test: `tests/unit/themes.test.ts` (extend the semantic-colour case)

**Interfaces:**
- Produces: `--color-warn` as a Tailwind token, so `text-warn` and `bg-warn` are emitted, and `ThemeTokens.warn`.

- [ ] **Step 1: Write the failing test**

In `tests/unit/themes.test.ts`, inside `describe('text in every theme')`, add:

```ts
  /**
   * The medium-priority dot in the Todos column, and the first token added
   * for a graphical mark rather than for text. Held to the text floor anyway:
   * it is drawn at 6px, where anything looser is guesswork on a real screen.
   */
  it('clears AA for the warn colour on every fill', () => {
    for (const { id, tokens } of themes) {
      for (const ground of [tokens.bg, tokens.surface, tokens.raised, tokens.overlay]) {
        expect(contrast(tokens.warn, ground), `${id} warn/${ground}`).toBeGreaterThanOrEqual(AA)
      }
    }
  })
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/themes.test.ts tests/unit/themeCss.test.ts`
Expected: FAIL. `tokens.warn` does not exist, so `themes.test.ts` fails to compile or reports `undefined`; `themeCss.test.ts` still passes at this point because it iterates the registry's keys.

- [ ] **Step 3: Add the token to the registry**

In `src/shared/themes.ts`, in `ThemeTokens`, directly after `danger`:

```ts
  /** The medium-priority mark in the Todos column. One value across the registry, like `danger`. */
  warn: string
```

Then add `warn: '#fbbf24',` beside `danger` in all five `THEMES` entries: `classic`, `stepped`, `lifted`, `slate`, `lineled`.

- [ ] **Step 4: Add it to the build-time CSS**

In `src/renderer/index.css`, in the `@theme` block beside `--color-danger`:

```css
  /* Declared here for the reason the whole block is: Tailwind v4 emits a
     utility only for a token it can see at build time. `applyTheme`
     overrides the value at runtime, and `themeCss.test.ts` holds this
     literal equal to Classic's. */
  --color-warn: #fbbf24;
```

- [ ] **Step 5: Run the theme tests**

Run: `npx vitest run tests/unit/themes.test.ts tests/unit/themeCss.test.ts tests/unit/labelContrast.test.ts`
Expected: PASS. `themeCss.test.ts` proves the CSS literal and the registry agree; the new case proves the colour is readable on every ground in every theme.

- [ ] **Step 6: Commit**

```bash
git add src/shared/themes.ts src/renderer/index.css tests/unit/themes.test.ts
git commit -m "Add a warn token for the medium priority mark"
```

---

### Task 4: IPC handlers, broadcast, and the preload bridge

**Files:**
- Create: `src/main/todos/broadcast.ts`
- Test: `tests/unit/todosBroadcast.test.ts`
- Modify: `src/shared/ipc.ts` (`CHANNELS`, `PTermApi`)
- Modify: `src/main/ipc/register.ts` (handlers, and the `BrowserWindow` import)
- Modify: `src/preload/index.ts` (bridge methods)

**Interfaces:**
- Consumes: the five store functions and `readTodos` from Task 1.
- Produces:
  - `broadcastTodos(windows: TodoBroadcastTarget[], todos: TodoRecord[]): void`
  - `PTermApi.todosList / todosCreate / todosUpdate / todosSetDone / todosDelete / onTodosChanged`
  - `CHANNELS.todosList / todosCreate / todosUpdate / todosSetDone / todosDelete / todosChanged`

- [ ] **Step 1: Write the failing test for the broadcast**

Create `tests/unit/todosBroadcast.test.ts`. The point of extracting this is that it is the only part of the push path a node-environment test can reach: `ipcMain` and a real `BrowserWindow` cannot be constructed here.

```ts
import { describe, it, expect, vi } from 'vitest'
import type { TodoRecord } from '../../src/shared/ipc'
import { broadcastTodos } from '../../src/main/todos/broadcast'

const TODOS: TodoRecord[] = [
  {
    id: 'td_1',
    title: 'chase invoice',
    body: '',
    priority: 'high',
    done: false,
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  },
]

function fakeWindow(destroyed = false) {
  const send = vi.fn()
  return { window: { isDestroyed: () => destroyed, webContents: { send } }, send }
}

describe('broadcastTodos', () => {
  it('sends the list to every live window', () => {
    const first = fakeWindow()
    const second = fakeWindow()
    broadcastTodos([first.window, second.window], TODOS)
    expect(first.send).toHaveBeenCalledWith('pterm:todosChanged', TODOS)
    expect(second.send).toHaveBeenCalledWith('pterm:todosChanged', TODOS)
  })

  it('skips a destroyed window rather than throwing', () => {
    const live = fakeWindow()
    const dead = fakeWindow(true)
    expect(() => broadcastTodos([dead.window, live.window], TODOS)).not.toThrow()
    expect(dead.send).not.toHaveBeenCalled()
    expect(live.send).toHaveBeenCalledOnce()
  })

  it('sends nothing when there are no windows', () => {
    expect(() => broadcastTodos([], TODOS)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/unit/todosBroadcast.test.ts`
Expected: FAIL, cannot resolve `../../src/main/todos/broadcast`.

- [ ] **Step 3: Add the channels and the bridge types**

In `src/shared/ipc.ts`, add to `CHANNELS` after the `issues*` entries:

```ts
  todosList: 'pterm:todosList',
  todosCreate: 'pterm:todosCreate',
  todosUpdate: 'pterm:todosUpdate',
  todosSetDone: 'pterm:todosSetDone',
  todosDelete: 'pterm:todosDelete',
  todosChanged: 'pterm:todosChanged',
```

And to `PTermApi`, beside `notesRead`/`notesWrite`:

```ts
  /** The whole global list. Read once on mount; changes arrive via `onTodosChanged`. */
  todosList(): Promise<TodoRecord[]>
  /**
   * Every mutation resolves with the NEW FULL LIST, so the calling window
   * renders from its own reply rather than waiting on the broadcast. A
   * refused create (empty title) and an unknown id both come back as the
   * list unchanged rather than as an error: a peer window that deleted the
   * same todo first must not surface as a failure here.
   */
  todosCreate(draft: TodoDraft): Promise<TodoRecord[]>
  todosUpdate(id: string, patch: TodoPatch): Promise<TodoRecord[]>
  todosSetDone(id: string, done: boolean): Promise<TodoRecord[]>
  todosDelete(id: string): Promise<TodoRecord[]>
  /** Pushed to every window after any mutation, the originator included. */
  onTodosChanged(listener: (todos: TodoRecord[]) => void): () => void
```

- [ ] **Step 4: Write the broadcast module**

Create `src/main/todos/broadcast.ts`:

```ts
import { CHANNELS, type TodoRecord } from '../../shared/ipc'

/**
 * The part of a `BrowserWindow` this push needs, and nothing more.
 *
 * Structural rather than the Electron class so the rule is unit-testable at
 * all: `tests/unit` runs in a node environment where a real window cannot be
 * constructed, and the thing worth pinning is which windows get the payload
 * and which are skipped.
 */
export interface TodoBroadcastTarget {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: TodoRecord[]): void }
}

/**
 * Hand the new list to every live window, the originator included.
 *
 * The originator has already applied the identical list from its own reply, so
 * the extra render is idempotent; sending to it anyway means there is one rule
 * here rather than a per-caller exception. A destroyed window is skipped for
 * `register.ts`'s reason: `webContents.send` throws on one.
 */
export function broadcastTodos(windows: TodoBroadcastTarget[], todos: TodoRecord[]): void {
  for (const window of windows) {
    if (!window.isDestroyed()) window.webContents.send(CHANNELS.todosChanged, todos)
  }
}
```

- [ ] **Step 5: Run the broadcast test**

Run: `npx vitest run tests/unit/todosBroadcast.test.ts`
Expected: PASS.

- [ ] **Step 6: Register the handlers**

In `src/main/ipc/register.ts`, change the electron import so `BrowserWindow` is a value, not just a type (it is needed at runtime to enumerate windows):

```ts
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
```

Add the store and broadcast imports beside the notes ones, then register the handlers next to `CHANNELS.notesRead` / `CHANNELS.notesWrite`:

```ts
  // Outside `serialise` for the same reason as notes and prompts: todos live in
  // `todos.json` beside config.json and never inside it, and the store has a
  // queue of its own because all five mutations are read-modify-write.
  //
  // Every mutation pushes the new list to EVERY window rather than only the
  // caller's: the list is global, so a second window showing a todo another
  // window just edited would otherwise sit stale until something else made it
  // refetch.
  ipcMain.handle(CHANNELS.todosList, () => readTodos())
  ipcMain.handle(CHANNELS.todosCreate, async (_event, draft: TodoDraft) => {
    const todos = await createTodo(draft)
    broadcastTodos(BrowserWindow.getAllWindows(), todos)
    return todos
  })
  ipcMain.handle(CHANNELS.todosUpdate, async (_event, id: string, patch: TodoPatch) => {
    const todos = await updateTodo(id, patch)
    broadcastTodos(BrowserWindow.getAllWindows(), todos)
    return todos
  })
  ipcMain.handle(CHANNELS.todosSetDone, async (_event, id: string, done: boolean) => {
    const todos = await setTodoDone(id, done)
    broadcastTodos(BrowserWindow.getAllWindows(), todos)
    return todos
  })
  ipcMain.handle(CHANNELS.todosDelete, async (_event, id: string) => {
    const todos = await deleteTodo(id)
    broadcastTodos(BrowserWindow.getAllWindows(), todos)
    return todos
  })
```

- [ ] **Step 7: Wire the preload bridge**

In `src/preload/index.ts`, add `type TodoDraft`, `type TodoPatch`, `type TodoRecord` to the import list, then add beside `notesWrite`:

```ts
  todosList: (): Promise<TodoRecord[]> => ipcRenderer.invoke(CHANNELS.todosList),
  todosCreate: (draft: TodoDraft): Promise<TodoRecord[]> =>
    ipcRenderer.invoke(CHANNELS.todosCreate, draft),
  todosUpdate: (id: string, patch: TodoPatch): Promise<TodoRecord[]> =>
    ipcRenderer.invoke(CHANNELS.todosUpdate, id, patch),
  todosSetDone: (id: string, done: boolean): Promise<TodoRecord[]> =>
    ipcRenderer.invoke(CHANNELS.todosSetDone, id, done),
  todosDelete: (id: string): Promise<TodoRecord[]> =>
    ipcRenderer.invoke(CHANNELS.todosDelete, id),
  onTodosChanged: (listener: (todos: TodoRecord[]) => void) => {
    const handler = (_event: IpcRendererEvent, payload: TodoRecord[]): void => listener(payload)
    ipcRenderer.on(CHANNELS.todosChanged, handler)
    return () => ipcRenderer.removeListener(CHANNELS.todosChanged, handler)
  },
```

The bridge object is frozen once `contextBridge.exposeInMainWorld` has run, so a channel that is not declared here cannot be added from the renderer later, and an `evaluate` that tries silently no-ops.

- [ ] **Step 8: Typecheck and run the unit suite**

Run: `npm run typecheck && npm test`
Expected: typecheck silent, full unit suite green. `tests/unit/ipc.test.ts` also covers the channel map, so a duplicate or missing channel name surfaces here.

- [ ] **Step 9: Commit**

```bash
git add src/shared/ipc.ts src/main/todos/broadcast.ts src/main/ipc/register.ts src/preload/index.ts tests/unit/todosBroadcast.test.ts
git commit -m "Expose the todos store over IPC and push changes to every window"
```

---

### Task 5: The Todos column

**Files:**
- Create: `src/renderer/TodosPanel.tsx`
- Modify: `src/shared/ipc.ts` (`ColumnId`, `MenuCommand`)
- Modify: `src/renderer/lib/columnVisibility.ts` (`COLUMN_IDS`)
- Modify: `src/renderer/lib/columnOrder.ts` (`COLUMN_ORDER_DEFAULT`)
- Modify: `src/renderer/App.tsx` (keys, state, maps, toggle, keydown letter map, `renderSlot`)
- Modify: `src/main/index.ts` (View menu item)
- Modify: `tests/e2e/harness.ts` (`expandColumn`)
- Test: `tests/unit/columnOrder.test.ts`, `tests/unit/columnVisibility.test.ts` (existing files, extended), `tests/e2e/todos.spec.ts` (new, list behaviour only)

**Interfaces:**
- Consumes: `filterTodos`, `sortTodos`, `nextTodoSort`, `SORT_LABEL`, `PRIORITY_LABEL` (Task 2); the bridge methods (Task 4); `--color-warn` (Task 3).
- Produces: `TodosPanel` with props `{ collapsed: boolean; onToggle: () => void; onDragStart: () => void; side: PanelSide; creating: boolean; onCreatingChange: (creating: boolean) => void }`.

Note: `TodosPanel` takes no `project` prop. That absence is the point of the column.

- [ ] **Step 1: Extend the pure column tests**

In `tests/unit/columnVisibility.test.ts` and `tests/unit/columnOrder.test.ts`, the existing cases enumerate the known columns. Add `'todos'` wherever a case lists every id, and add one new case to `columnOrder.test.ts`:

```ts
  it('appends todos for a profile written before the column existed', () => {
    const stored = JSON.stringify(['files', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'issues', 'notes'])
    expect(orderFromStored(stored)).toEqual([...COLUMN_ORDER_DEFAULT])
  })
```

- [ ] **Step 2: Run them to see the failures**

Run: `npx vitest run tests/unit/columnOrder.test.ts tests/unit/columnVisibility.test.ts`
Expected: FAIL. The new case fails because `'todos'` is not in `COLUMN_ORDER_DEFAULT` yet, and any case listing every id disagrees with the shipped list.

- [ ] **Step 3: Add the column id**

- `src/shared/ipc.ts`: `export type ColumnId = 'tabs' | 'files' | 'skills' | 'presets' | 'prompts' | 'notes' | 'git' | 'issues' | 'todos'`, and `MenuCommand` gains `| 'toggleTodos'`.
- `src/renderer/lib/columnVisibility.ts`: append `'todos'` to `COLUMN_IDS`.
- `src/renderer/lib/columnOrder.ts`: append `'todos'` to `COLUMN_ORDER_DEFAULT`, after `'notes'`.

- [ ] **Step 4: Run the pure tests again**

Run: `npx vitest run tests/unit/columnOrder.test.ts tests/unit/columnVisibility.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the panel**

Create `src/renderer/TodosPanel.tsx`. `IssuesPanel` is the model; everything it does about projects, repos, fetch stamps and request tokens is deliberately absent.

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { TodoRecord } from '../shared/ipc'
import {
  filterTodos,
  nextTodoSort,
  sortTodos,
  PRIORITY_DOT,
  SORT_LABEL,
  type TodoPriorityFilter,
  type TodoSort,
  type TodoStateFilter,
} from './lib/todoList'
import { useColumnWidth } from './lib/columnWidth'
import { cn } from './lib/cn'
import { ColumnResizer, PanelHeading, PanelStrip, type PanelSide } from './ui/Panel'
import { TodoModal } from './TodoModal'

function StateButton({
  filter,
  active,
  onClick,
}: {
  filter: TodoStateFilter
  active: boolean
  onClick: () => void
}) {
  const label = filter === 'open' ? 'Open' : filter === 'done' ? 'Done' : 'All'
  return (
    <button
      data-testid={`todos-state-${filter}`}
      onClick={onClick}
      className={cn(
        'cursor-default border-none bg-transparent px-1.5 py-0.5 text-faint hover:text-fg',
        active && 'text-fg',
      )}
    >
      {label}
    </button>
  )
}

function PriorityButton({
  filter,
  active,
  onClick,
}: {
  filter: TodoPriorityFilter
  active: boolean
  onClick: () => void
}) {
  const label = filter === 'all' ? 'All' : filter === 'high' ? 'Hi' : filter === 'medium' ? 'Med' : 'Lo'
  return (
    <button
      data-testid={`todos-priority-${filter}`}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 cursor-default border-none bg-transparent px-1.5 py-0.5 text-faint hover:text-fg',
        active && 'text-fg',
      )}
    >
      {filter !== 'all' ? <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', PRIORITY_DOT[filter])} /> : null}
      {label}
    </button>
  )
}

function Row({
  todo,
  onSelect,
  onToggleDone,
}: {
  todo: TodoRecord
  onSelect: (id: string) => void
  onToggleDone: (id: string, done: boolean) => void
}) {
  return (
    // `group` for the hover reveal, the pattern `IssuesPanel`'s row and
    // `GitPanel`'s row both use.
    <div className="group relative flex w-full items-start">
      <button
        data-testid={`todo-row-${todo.id}`}
        onClick={() => onSelect(todo.id)}
        className="flex w-full cursor-default items-baseline gap-1.5 border-none bg-transparent px-2.5 py-1 text-left text-muted hover:text-fg"
      >
        <span
          data-testid={`todo-dot-${todo.id}`}
          className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', PRIORITY_DOT[todo.priority])}
        />
        <span className={cn('truncate', todo.done && 'text-faint line-through')}>{todo.title}</span>
      </button>
      {/*
        Marks DONE, not deleted. Delete is irreversible and lives in the modal
        behind a confirm: a destructive action revealed by hover is one
        mis-click away at all times.
      */}
      <button
        data-testid={`todo-done-${todo.id}`}
        onClick={() => onToggleDone(todo.id, !todo.done)}
        title={todo.done ? 'Mark as not done' : 'Mark as done'}
        className="absolute right-1 top-1 shrink-0 cursor-default border-none bg-transparent px-1 text-faint opacity-0 group-hover:opacity-100 hover:text-fg"
      >
        {todo.done ? '↺' : '✓'}
      </button>
    </div>
  )
}

/**
 * The Todos column: a global list with search, a state filter, a priority
 * filter, a sort toggle, and a row per todo.
 *
 * No `project` prop, and that absence is the feature. Everything `IssuesPanel`
 * carries to keep a reply paired with the project and filter it was fetched
 * under is unnecessary here: the list is global, local, and arrives in one
 * round trip, so there is no stamped `Result`, no request token, no focus
 * refetch and no "no project selected" state.
 */
export function TodosPanel({
  collapsed,
  onToggle,
  onDragStart,
  side,
  creating,
  onCreatingChange,
}: {
  collapsed: boolean
  onToggle: () => void
  /** Grabs this column to move it. See `PanelHeading`'s doc comment. */
  onDragStart: () => void
  side: PanelSide
  /**
   * Whether the create modal is open. Held by `App.tsx` rather than here so
   * the command palette can open it with the column still collapsed.
   */
  creating: boolean
  onCreatingChange: (creating: boolean) => void
}) {
  // 208, the default every list column takes. Notes' 256 is justified there
  // because a note is prose; this is a list of short titles.
  const { width, set, commit } = useColumnWidth('pterm:todosWidth')
  // null is "not loaded yet", which is what the `…` row renders. An empty
  // array is a loaded empty list, which renders `No todos.`
  const [todos, setTodos] = useState<TodoRecord[] | null>(null)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<TodoStateFilter>('open')
  const [priority, setPriority] = useState<TodoPriorityFilter>('all')
  const [sort, setSort] = useState<TodoSort>('priority')
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback((): void => {
    window.pterm
      .todosList()
      .then(setTodos)
      .catch(() => setTodos([]))
  }, [])

  // One fetch on mount plus the push subscription. Pushes replace polling, so
  // unlike `IssuesPanel` there is no focus listener and nothing to throttle.
  // Not gated on `collapsed`: the list is what the count in the strip would
  // need anyway, and it is one cheap local read rather than a `gh` call.
  useEffect(() => {
    load()
    return window.pterm.onTodosChanged(setTodos)
  }, [load])

  if (collapsed) {
    return (
      <PanelStrip
        testid="todos-toggle"
        label="Todos"
        side={side}
        onClick={onToggle}
        onDragStart={onDragStart}
      />
    )
  }

  const rows = todos ?? []
  const visible = sortTodos(filterTodos(rows, { query, state, priority }), sort)
  const openCount = rows.filter((todo) => !todo.done).length

  return (
    <div
      data-testid="todos-panel"
      className={cn(
        'relative flex shrink-0 flex-col border-border bg-surface font-mono text-[11px] select-none',
        // The seam faces the terminal either way, the rule every panel
        // container in this row follows.
        side === 'left' ? 'border-r' : 'border-l',
      )}
      style={{ width }}
    >
      {/* Heading and `+` as siblings, not nested: a button inside a button is
          invalid HTML and the inner click would bubble out and collapse the
          column. */}
      <div className="flex items-center justify-between pr-2.5">
        <PanelHeading testid="todos-toggle" label="Todos" onClick={onToggle} onDragStart={onDragStart} />
        <button
          data-testid="todos-new"
          aria-label="New todo"
          onClick={() => onCreatingChange(true)}
          className="cursor-default border-none bg-transparent p-0 text-[13px] leading-none text-faint hover:text-fg"
        >
          +
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 px-2.5 pb-1 text-faint">
        <span data-testid="todos-count" className="shrink-0">
          {todos === null ? '' : `${openCount} open`}
        </span>
        {/* Re-reads the file. In-app edits arrive by broadcast, so this is
            here for a `todos.json` edited by hand. */}
        <button
          data-testid="todos-refresh"
          onClick={load}
          title="Refresh"
          className="shrink-0 cursor-default border-none bg-transparent px-1 text-faint hover:text-fg"
        >
          ↻
        </button>
      </div>
      <input
        data-testid="todos-search"
        // Load-bearing, same as every text field in this app: without it ⌘W
        // typed while searching closes a pane and destroys its session.
        data-shortcuts="off"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search todos"
        spellCheck={false}
        className="mx-2.5 mb-1 border border-border bg-transparent px-1.5 py-1 text-[11px] text-fg placeholder:text-faint focus:outline-none"
      />
      <div className="flex items-center justify-between gap-1 px-2 pb-1">
        <div className="flex items-center gap-1">
          <StateButton filter="open" active={state === 'open'} onClick={() => setState('open')} />
          <StateButton filter="done" active={state === 'done'} onClick={() => setState('done')} />
          <StateButton filter="all" active={state === 'all'} onClick={() => setState('all')} />
        </div>
        <button
          data-testid="todos-sort"
          onClick={() => setSort(nextTodoSort(sort))}
          title="Change sort"
          className="cursor-default border-none bg-transparent px-1.5 py-0.5 text-faint hover:text-fg"
        >
          {SORT_LABEL[sort]}
        </button>
      </div>
      <div className="flex items-center gap-0.5 px-2 pb-1.5">
        <PriorityButton filter="all" active={priority === 'all'} onClick={() => setPriority('all')} />
        <PriorityButton filter="high" active={priority === 'high'} onClick={() => setPriority('high')} />
        <PriorityButton filter="medium" active={priority === 'medium'} onClick={() => setPriority('medium')} />
        <PriorityButton filter="low" active={priority === 'low'} onClick={() => setPriority('low')} />
      </div>
      <div data-testid="todos-list" className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {todos === null ? (
          <p data-testid="todos-loading" className="px-2.5 py-1 text-faint">
            …
          </p>
        ) : visible.length === 0 ? (
          <p data-testid="todos-empty-list" className="px-2.5 py-1 text-faint">
            {query.trim() !== '' || priority !== 'all' || state !== 'open' ? 'Nothing matches.' : 'No todos.'}
          </p>
        ) : (
          visible.map((todo) => (
            <Row
              key={todo.id}
              todo={todo}
              onSelect={setOpen}
              onToggleDone={(id, done) => {
                // The reply carries the new list, so nothing here has to
                // refetch; the broadcast repeats it to the other windows.
                window.pterm.todosSetDone(id, done).then(setTodos).catch(() => undefined)
              }}
            />
          ))
        )}
      </div>
      <TodoModal
        todo={todos?.find((row) => row.id === open) ?? null}
        create={creating}
        onClose={() => {
          setOpen(null)
          onCreatingChange(false)
        }}
        onChanged={setTodos}
      />
      <ColumnResizer testid="resize-todos" side={side} width={width} onResize={set} onCommit={commit} />
    </div>
  )
}
```

- [ ] **Step 6: Wire it into App.tsx**

Six edits, all beside the `issues` equivalents:

1. Add the collapse key next to `ISSUES_KEY`: `const TODOS_KEY = 'pterm:todosCollapsed'`.
2. Add `todos: 'pterm:todosHidden'` to `HIDDEN_KEYS`.
3. Add state: `const [todosCollapsed, setTodosCollapsed] = useState(() => storedCollapsed(TODOS_KEY, true))`, and `todos: storedCollapsed(HIDDEN_KEYS.todos, true)` to the `hiddenColumns` initialiser. Add `const [creatingTodo, setCreatingTodo] = useState(false)`.
4. Add `todos: setTodosCollapsed` to `setColumn`, `todos: TODOS_KEY` to `COLUMN_KEY`, and `todos: todosCollapsed` to `collapsedColumns`.
5. Add the toggle beside `toggleIssues`:

```tsx
  const toggleTodos = useCallback(() => {
    // The View menu's item and its shortcut both land here, and both
    // mean presence: show the column, or take it off screen entirely.
    // Collapsing to the strip is the heading's job, not this one's.
    setColumnHidden('todos', !hiddenColumns.todos)
  }, [hiddenColumns.todos, setColumnHidden])
```

6. Add `KeyT: toggleTodos` to the `event.altKey && !event.shiftKey` letter map, `case 'toggleTodos': toggleTodos(); return` to the menu-command switch, and the slot:

```tsx
      case 'todos':
        return hiddenColumns.todos ? null : (
          <TodosPanel
            collapsed={todosCollapsed}
            onToggle={() => toggleColumnCollapsed('todos')}
            onDragStart={() => setDragging('todos')}
            side={resizerSideFor(columnOrder, 'todos')}
            creating={creatingTodo}
            onCreatingChange={setCreatingTodo}
          />
        )
```

`KeyT` in that map does not collide with ⌘T for a new tab: the `event.code === 'KeyT'` branch above it is guarded on `!event.altKey`.

- [ ] **Step 7: Add the View menu item**

In `src/main/index.ts`, after the Issues item:

```ts
        {
          label: 'Todos',
          accelerator: 'Alt+CmdOrCtrl+T',
          type: 'checkbox',
          checked: !columnIsCollapsed(columns, 'todos'),
          registerAccelerator: false,
          click: () => sendMenuCommand('toggleTodos'),
        },
```

Copy the exact property set from the Issues item above it, including its `type`, `checked` expression and testid/id conventions, rather than the sketch here: that item is the one the checkmark plumbing already agrees with.

- [ ] **Step 8: Teach the e2e harness about the column**

In `tests/e2e/harness.ts`, add `todos: 't'` to `COLUMN_KEY` and `'todos'` to `expandColumn`'s `name` union.

- [ ] **Step 9: Write the e2e spec for the list**

Create `tests/e2e/todos.spec.ts`, seeding `todos.json` in the temp config dir so the list has content without needing the modal. Copy the `beforeAll` / `afterAll` scaffolding from `tests/e2e/notes.spec.ts` verbatim (same six temp dirs, same `launchApp` call, same `killServer`), with `SOCKET = 'pterm-e2e-todos'` and one project. Then:

```ts
test('shows the seeded todos, newest priority first', async () => {
  await expandColumn(page, 'todos')
  await expect(page.getByTestId('todos-count')).toHaveText('2 open')
  const titles = await page.getByTestId('todos-list').locator('button[data-testid^="todo-row-"]').allInnerTexts()
  expect(titles[0]).toContain('chase invoice')
})

test('search narrows the list', async () => {
  await expandColumn(page, 'todos')
  await page.getByTestId('todos-search').fill('flights')
  await expect(page.getByTestId('todos-list').locator('button[data-testid^="todo-row-"]')).toHaveCount(1)
  // Cleared before the next test: this file shares one page, so a filter left
  // set would make a later count assertion mean something else entirely.
  await page.getByTestId('todos-search').fill('')
})

test('the priority filter excludes other levels', async () => {
  await expandColumn(page, 'todos')
  await page.getByTestId('todos-priority-low').click()
  await expect(page.getByTestId('todos-list').locator('button[data-testid^="todo-row-"]')).toHaveCount(1)
  await page.getByTestId('todos-priority-all').click()
})

test('the hover action marks a todo done and the Done filter finds it', async () => {
  await expandColumn(page, 'todos')
  const id = await firstRowId(page)
  await page.getByTestId(`todo-done-${id}`).click()
  await expect(page.getByTestId('todos-list').locator(`[data-testid="todo-row-${id}"]`)).toHaveCount(0)
  await page.getByTestId('todos-state-done').click()
  await expect(page.getByTestId(`todo-row-${id}`)).toBeVisible()
  await page.getByTestId('todos-state-open').click()
})

test('the priority dot is drawn in the theme token, not a literal', async () => {
  await expandColumn(page, 'todos')
  const id = await firstRowId(page)
  const colour = await page.getByTestId(`todo-dot-${id}`).evaluate((node) => getComputedStyle(node).backgroundColor)
  const token = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-danger').trim(),
  )
  expect(rgbToHex(colour)).toBe(token)
})
```

`firstRowId` reads the id out of the first row's testid; `rgbToHex` converts a computed `rgb(...)` to `#rrggbb`. Put both at the top of the file. `tests/e2e/colour.ts` already exists for colour helpers, so check it first and reuse rather than duplicating.

Two rules this file must respect, both learned the hard way in this repo: every test calls `expandColumn` rather than clicking `todos-toggle` (strip and heading share the testid, so a blind click on an open column collapses it), and any test that sets a filter clears it again, because the whole file shares one `page`.

- [ ] **Step 10: Run it**

Run: `npx playwright test tests/e2e/todos.spec.ts`
Expected: PASS. If the dot assertion fails, read the computed value before changing the test: a mismatch there means the class is not resolving to the token, which is the thing being tested.

- [ ] **Step 11: Commit**

```bash
git add src/renderer/TodosPanel.tsx src/renderer/App.tsx src/shared/ipc.ts src/renderer/lib/columnVisibility.ts src/renderer/lib/columnOrder.ts src/main/index.ts tests/e2e/harness.ts tests/e2e/todos.spec.ts tests/unit/columnOrder.test.ts tests/unit/columnVisibility.test.ts
git commit -m "Add the Todos column"
```

---

### Task 6: The todo modal

**Files:**
- Create: `src/renderer/TodoModal.tsx`
- Test: `tests/e2e/todoModal.spec.ts`

**Interfaces:**
- Consumes: `PRIORITY_DOT` and `PRIORITY_LABEL` from `lib/todoList.ts`, the bridge mutations from Task 4, `Dialog`/`DialogContent`/`DialogTitle` from `ui/Dialog`, `Button` from `ui/Button`, `MarkdownView` from `ui/MarkdownView`, `ConfirmClosePane` from `ConfirmClosePane.tsx`, `historyAgo` from `lib/historyAgo`.
- Produces: `TodoModal` with props `{ todo: TodoRecord | null; create: boolean; onClose: () => void; onChanged: (todos: TodoRecord[]) => void }`.

Task 5 already imports and renders this component, so Task 5 does not typecheck until this file exists. If the two are executed in separate sessions, run Task 6 immediately after Task 5 and treat the intermediate typecheck failure as expected.

- [ ] **Step 1: Write the component**

Create `src/renderer/TodoModal.tsx`. `IssueModal` is the model, and three things are deliberately dropped from it: there is no fetch (the record is handed in from the list the panel already holds), no comments, and no repo. What is kept exactly is the close-time state reset and the dirty-guard routing.

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { syntaxHighlighting } from '@codemirror/language'
import type { TodoPriority, TodoRecord } from '../shared/ipc'
import { Dialog, DialogContent, DialogTitle } from './ui/Dialog'
import { Button } from './ui/Button'
import { MarkdownView } from './ui/MarkdownView'
import { ConfirmClosePane } from './ConfirmClosePane'
import { PRIORITY_DOT, PRIORITY_LABEL } from './lib/todoList'
import { historyAgo } from './lib/historyAgo'
import { cn } from './lib/cn'
import { GUTTER_TEXT, syntaxColorStyle } from './lib/syntaxColors'

/** Epoch seconds `historyAgo` takes, from the ISO strings the store writes. */
function secondsOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000)
}
```

`BodyEditor` is the same component `IssueModal.tsx` defines, including its `Prec.highest` Enter binding and its `[]` dependency array, and its doc comment explains why it must be built once per mount. Copy it into this file with its comments intact and change only its testid, to `todo-body-editor`. (Extracting it into a shared module is a refactor of `IssueModal` that this feature does not need; if it is extracted, both testids must keep working because `issueModal.spec.ts` reads the existing one.)

The component itself:

```tsx
/**
 * One todo: a read view, a form for editing or creating one, and delete
 * behind a confirm.
 *
 * `todo` is both the dialog's open flag and what it shows, the split
 * `IssueModal` uses for its own `number`: `null` is closed, any record both
 * opens the dialog and is what it renders. `create` is a second, independent
 * way to be open, since a new todo has no record to name yet. The two are
 * never both meaningful (`create` wins), and `TodosPanel` is the one place
 * that decides which is set.
 *
 * Unlike `IssueModal` there is nothing to fetch: the panel already holds the
 * whole list, so the record handed in here is the same object the row was
 * drawn from, and every mutation's reply carries the new list back out
 * through `onChanged`.
 */
export function TodoModal({
  todo,
  create,
  onClose,
  onChanged,
}: {
  todo: TodoRecord | null
  create: boolean
  onClose: () => void
  /** The new list, straight from the mutation's reply. */
  onChanged: (todos: TodoRecord[]) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [priority, setPriority] = useState<TodoPriority>('medium')
  const [busy, setBusy] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // The single choke point every way out of a dirty edit or create goes
  // through, exactly as in `IssueModal`: Escape, an outside click and Cancel
  // all store the action they would have run, and `ConfirmClosePane`'s
  // Discard button is the only thing that runs it.
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null)

  const mode = create ? 'create' : editing ? 'edit' : 'read'
  const open = todo !== null || create

  const dirty =
    mode === 'create'
      ? title.trim() !== '' || body.trim() !== ''
      : mode === 'edit'
        ? title !== (todo?.title ?? '') || body !== (todo?.body ?? '') || priority !== (todo?.priority ?? 'medium')
        : false

  /**
   * Ends the session, then hides the dialog. Both halves matter, and this is
   * the defect `IssueModal` shipped and had to fix (55bcb73).
   *
   * `BodyEditor` builds its view once, from the `value` it is handed at
   * mount. Hiding without clearing left `editing`, `title`, `body` and
   * `priority` holding the last session's values, so the NEXT create mounted
   * the editor from the previous todo's body while `body` state was empty
   * behind it: the visible text was not the text that would be saved.
   * Clearing on the way out is the only ordering that works.
   *
   * `pendingAction` and `confirmDelete` are cleared here too: leaving either
   * set re-shows a dialog over an app with no modal behind it.
   */
  const closeNow = useCallback(() => {
    setEditing(false)
    setTitle('')
    setBody('')
    setPriority('medium')
    setMutationError(null)
    setConfirmDelete(false)
    setPendingAction(null)
    onClose()
  }, [onClose])

  const requestClose = useCallback(() => {
    if (dirty) {
      setPendingAction(() => closeNow)
      return
    }
    closeNow()
  }, [dirty, closeNow])

  // Adopts whatever target this render names. A dirty edit or create defers
  // behind the same confirm every other exit uses rather than being wiped by
  // a target change, which is `IssueModal`'s rule and the reason it has one.
  const resetForTarget = useCallback(() => {
    setEditing(false)
    setMutationError(null)
    setConfirmDelete(false)
    if (create) {
      setTitle('')
      setBody('')
      setPriority('medium')
    }
  }, [create])

  const target = todo?.id ?? null
  useEffect(() => {
    if (dirty) {
      setPendingAction(() => resetForTarget)
      return
    }
    resetForTarget()
    // Keyed on the target, not on `dirty`: a keystroke must not re-run this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, create, resetForTarget])

  const startEdit = useCallback(() => {
    if (todo === null) return
    setTitle(todo.title)
    setBody(todo.body)
    setPriority(todo.priority)
    setMutationError(null)
    setEditing(true)
  }, [todo])
```

The four mutations follow the same pessimistic shape: guard on `busy` and on an empty trimmed title where it applies, `setBusy(true)`, call the bridge, hand the reply to `onChanged`, and close or drop back to read mode on success. A rejected promise sets `mutationError` to `'Writing the todo list failed.'` and leaves the dialog open with what was typed still in it.

```tsx
  const submitCreate = useCallback(() => {
    if (busy || title.trim() === '') return
    setBusy(true)
    setMutationError(null)
    window.pterm
      .todosCreate({ title, body, priority })
      .then((todos) => {
        onChanged(todos)
        closeNow()
      })
      .catch(() => setMutationError('Writing the todo list failed.'))
      .finally(() => setBusy(false))
  }, [busy, title, body, priority, onChanged, closeNow])

  const submitEdit = useCallback(() => {
    if (busy || todo === null || title.trim() === '') return
    setBusy(true)
    setMutationError(null)
    window.pterm
      .todosUpdate(todo.id, { title, body, priority })
      .then((todos) => {
        onChanged(todos)
        setEditing(false)
        setTitle('')
        setBody('')
      })
      .catch(() => setMutationError('Writing the todo list failed.'))
      .finally(() => setBusy(false))
  }, [busy, todo, title, body, priority, onChanged])

  const submitDone = useCallback(
    (done: boolean) => {
      if (busy || todo === null) return
      setBusy(true)
      setMutationError(null)
      window.pterm
        .todosSetDone(todo.id, done)
        .then(onChanged)
        .catch(() => setMutationError('Writing the todo list failed.'))
        .finally(() => setBusy(false))
    },
    [busy, todo, onChanged],
  )

  const submitDelete = useCallback(() => {
    if (busy || todo === null) return
    setBusy(true)
    setMutationError(null)
    window.pterm
      .todosDelete(todo.id)
      .then((todos) => {
        onChanged(todos)
        closeNow()
      })
      .catch(() => setMutationError('Writing the todo list failed.'))
      .finally(() => setBusy(false))
  }, [busy, todo, onChanged, closeNow])
```

The render is one `Dialog` whose `onOpenChange` routes every dismissal through `requestClose`, a `DialogTitle` that is always present (Radix warns without one), and three bodies picked by `mode`:

- `create` and `edit`: `todo-title-input` (with `data-shortcuts="off"` and `autoFocus` in create), a three-button priority picker (`todo-priority-high|medium|low`, each showing its `PRIORITY_DOT` mark and marked `aria-pressed`), `BodyEditor`, then `todo-cancel` and `todo-save` (labelled `Create` in create mode, disabled while `busy || title.trim() === ''`).
- `read`: the title, a `todo-priority` chip using `PRIORITY_DOT` and `PRIORITY_LABEL`, `historyAgo(secondsOf(todo.updatedAt), Date.now())`, `MarkdownView` of the body (or `No description.` in `text-faint` when it is empty), then `todo-edit`, `todo-toggle-done` and `todo-delete`.
- The delete confirm is an inline block inside the dialog with `todo-delete-confirm` and `todo-delete-cancel`, shown when `confirmDelete` is true. It is not `ConfirmClosePane`: that dialog's copy is about unsaved edits.
- `mutationError` renders as `<p data-testid="todo-error" className="mb-2 text-[11px] text-danger">`, inside the dialog. Never a toast: a toast is gone before it is read.
- `ConfirmClosePane` is rendered alongside with `open={pendingAction !== null}`, `subject="todo"`, `onCancel={() => setPendingAction(null)}` and `onDiscard={() => { const run = pendingAction; setPendingAction(null); run?.() }}`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no output. This is the first point at which Task 5's import of `TodoModal` resolves.

- [ ] **Step 3: Write the failing e2e spec**

Create `tests/e2e/todoModal.spec.ts` with its own socket (`pterm-e2e-todomodal`) and its own temp dirs, starting from an EMPTY config dir so the create path is what puts the first todo on screen. Model the scaffolding on `tests/e2e/issueMutations.spec.ts`, which is the closest existing file.

```ts
test('creates a todo from the column, at the priority picked', async () => {
  await expandColumn(page, 'todos')
  await expect(page.getByTestId('todos-empty-list')).toHaveText('No todos.')
  await page.getByTestId('todos-new').click()
  await page.getByTestId('todo-title-input').fill('chase invoice')
  await page.getByTestId('todo-priority-high').click()
  await page.getByTestId('todo-save').click()
  await expect(page.getByTestId('todos-count')).toHaveText('1 open')
  await expect(page.getByTestId('todos-list')).toContainText('chase invoice')
})

test('edits the title and the row follows', async () => {
  const id = await firstRowId(page)
  await page.getByTestId(`todo-row-${id}`).click()
  await page.getByTestId('todo-edit').click()
  await page.getByTestId('todo-title-input').fill('chase invoice twice')
  await page.getByTestId('todo-save').click()
  await expect(page.getByTestId(`todo-row-${id}`)).toContainText('chase invoice twice')
})

test('a new create does not inherit the previous body', async () => {
  // The regression this file exists for, and the defect IssueModal shipped:
  // BodyEditor builds once from the value at mount, so a close that left the
  // state populated showed the previous todo's body over empty state, and
  // Create then filed the empty version. Reading the EDITOR here, not the
  // state, is what makes the assertion mean anything.
  const id = await firstRowId(page)
  await page.getByTestId(`todo-row-${id}`).click()
  await page.getByTestId('todo-edit').click()
  await page.getByTestId('todo-body-editor').locator('.cm-content').fill('some context')
  await page.keyboard.press('Escape')
  await page.getByTestId('confirm-close').getByTestId('confirm-discard').click()
  await page.getByTestId('todos-new').click()
  await expect(page.getByTestId('todo-body-editor').locator('.cm-content')).toHaveText('')
  await expect(page.getByTestId('todo-title-input')).toHaveValue('')
  await page.keyboard.press('Escape')
})

test('delete asks first, then removes the row', async () => {
  const id = await firstRowId(page)
  await page.getByTestId(`todo-row-${id}`).click()
  await page.getByTestId('todo-delete').click()
  await expect(page.getByTestId(`todo-row-${id}`)).toBeVisible()
  await page.getByTestId('todo-delete-confirm').click()
  await expect(page.getByTestId(`todo-row-${id}`)).toHaveCount(0)
})

test('the list survives a relaunch', async () => {
  await page.getByTestId('todos-new').click()
  await page.getByTestId('todo-title-input').fill('survives')
  await page.getByTestId('todo-save').click()
  await expect(page.getByTestId('todos-list')).toContainText('survives')

  // Relaunched against the SAME config dir, which is what makes this a test of
  // todos.json rather than of React state. The temp dirs are the ones
  // `beforeAll` created; nothing here allocates new ones, or the list would be
  // empty for an uninteresting reason.
  await app.close()
  app = await launchApp({
    socket: SOCKET,
    configDir,
    projectsRoot,
    claudeSettings: claudeSettingsPath,
    claudeHome,
    userDataDir,
  })
  page = await app.firstWindow()
  await expandColumn(page, 'todos')
  await expect(page.getByTestId('todos-list')).toContainText('survives')
})
```

Read `ConfirmClosePane.tsx` for its Discard button's real testid before writing that line, and `issueModal.spec.ts` for how this suite already drives a CodeMirror body: if `.cm-content` `fill` is not what that file uses, follow what does work there.

- [ ] **Step 4: Run it**

Run: `npx playwright test tests/e2e/todoModal.spec.ts`
Expected: PASS.

- [ ] **Step 5: Prove the regression test can fail**

Comment out the four `set*` calls in `closeNow` (leave `onClose()`), then run only the inheritance test:

Run: `npx playwright test tests/e2e/todoModal.spec.ts -g "does not inherit"`
Expected: FAIL, the editor shows `some context`. Restore `closeNow` and confirm it passes again. A regression test that cannot fail is worse than none: it is read as proof next time someone touches this.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/TodoModal.tsx tests/e2e/todoModal.spec.ts
git commit -m "Add the todo modal"
```

---

### Task 7: Command palette entries

**Files:**
- Modify: `src/renderer/CommandPalette.tsx`
- Modify: `src/renderer/App.tsx` (pass the commands in)
- Test: `tests/e2e/todos.spec.ts` (one added test)

**Interfaces:**
- Produces: `PaletteCommand { name: string; run: () => void }` exported from `CommandPalette.tsx`, and a new `commands: PaletteCommand[]` prop.

This is the palette's first notion of an action that RUNS something: today it offers sessions to switch to, skills to insert, and files to open. `filterEntries` already matches any `{ name }` shape, so the matching is free; the new concept is the section and the callback.

- [ ] **Step 1: Write the failing e2e test**

Append to `tests/e2e/todos.spec.ts`:

```ts
test('the palette can open the Todos column and start a new todo', async () => {
  // Starts from the column hidden, which is what makes this worth having: the
  // palette is the only way in that does not need the menu or the shortcut.
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('todo')
  await page.getByTestId('palette-command-Toggle Todos').click()
  await expect(page.getByTestId('todos-panel')).toBeVisible()
  await page.keyboard.press('Meta+k')
  await page.getByTestId('palette-input').fill('todo')
  await page.getByTestId('palette-command-New todo').click()
  await expect(page.getByTestId('todo-title-input')).toBeVisible()
  await page.keyboard.press('Escape')
})
```

Check the palette's real input testid in `CommandPalette.tsx` before running this; `palette-input` is the assumed name and must be corrected to whatever the component actually renders.

- [ ] **Step 2: Run it to see it fail**

Run: `npx playwright test tests/e2e/todos.spec.ts -g "palette"`
Expected: FAIL, no `palette-command-Toggle Todos` element.

- [ ] **Step 3: Add commands to the palette**

In `src/renderer/CommandPalette.tsx`:

```tsx
/**
 * One thing the palette can DO, as opposed to something it can switch to.
 *
 * The first of its kind in this component: sessions, skills and files are all
 * things to jump to or insert, and a command runs a callback in `App` instead.
 * `name` is both the label and what the query matches, so it goes through the
 * same `filterEntries` ranking as skills.
 */
export interface PaletteCommand {
  name: string
  run: () => void
}
```

Add `commands: PaletteCommand[]` to the props, match it behind the same non-empty-query gate the other lists use (`const matchedCommands = query.length === 0 ? [] : filterEntries(query, commands)`), and render it as its own section above skills, each entry as:

```tsx
<button
  key={entry.name}
  data-testid={`palette-command-${entry.name}`}
  onClick={() => {
    onOpenChange(false)
    entry.run()
  }}
>
  {entry.name}
</button>
```

Use the same row classes the skills entries use. The testid prefix is `palette-command-`, not `palette-action-`: that one belongs to skills and 
is already asserted against elsewhere.

- [ ] **Step 4: Pass the commands from App**

In `src/renderer/App.tsx`, where `CommandPalette` is rendered:

```tsx
        commands={[
          { name: 'Toggle Todos', run: toggleTodos },
          {
            name: 'New todo',
            // Show the column as well as opening the modal: creating a todo
            // into a column that is not on screen leaves the result invisible.
            run: () => {
              if (hiddenColumns.todos) toggleTodos()
              setCreatingTodo(true)
            },
          },
        ]}
```

- [ ] **Step 5: Run the test**

Run: `npx playwright test tests/e2e/todos.spec.ts`
Expected: PASS, the whole file.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/CommandPalette.tsx src/renderer/App.tsx tests/e2e/todos.spec.ts
git commit -m "Offer Todos from the command palette"
```

---

### Task 8: Whole-branch verification

**Files:** none created. This task exists because several of the gates below can only fail once everything is in place, and because the spec names two specific things to check rather than assume.

- [ ] **Step 1: Typecheck and the full unit suite**

Run: `npm run typecheck && npm test`
Expected: typecheck silent; unit suite green with the new files included. Record the test count.

- [ ] **Step 2: Run the column-geometry specs, which a new column has broken before**

Run: `npx playwright test tests/e2e/splits.spec.ts tests/e2e/columns.spec.ts tests/e2e/menuColumns.spec.ts tests/e2e/columnOrder.spec.ts tests/e2e/verticalTabs.spec.ts`
Expected: PASS, unchanged. The reasoning is that both new flags default to `true` and a HIDDEN column renders nothing at all, so a fresh profile has exactly the pixels it had before. If any of these goes red, that reasoning is wrong for this column and the failure is the finding: fix the arithmetic in the spec file, and correct the design doc's "Fallout to verify" section to say what actually happened.

- [ ] **Step 3: Run the whole e2e suite**

Run: `npx playwright test`
Expected: PASS. `verticalTabs.spec.ts` has a known flake in this suite that passes on re-run and in isolation; re-run a single failure in isolation before treating it as a regression, and say which it was.

- [ ] **Step 4: Open the app and use it**

Run: `npm start`

Check by hand, because the suite cannot see any of this: ⌥⌘T opens and closes the column; the View menu's checkmark tracks it; the three priority dots are distinguishable on a real screen in each of the five themes (switch them in Settings); dragging the column by its heading moves it and the position survives a relaunch; the resizer works and the width survives a relaunch; a todo created in one window appears in a second window opened afterwards. Two real defects in this repo's recent history were found only by opening the app while 1428 tests and ten reviews were green, which is why this step is a step.

- [ ] **Step 5: Commit anything the hand pass turned up, then report**

Report: the unit count, the e2e count, any flake and how it was re-run, and the result of each hand check in step 4. Do not report completion without those numbers.
