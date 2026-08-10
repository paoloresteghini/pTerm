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
  /** Written but not yet read: it exists so a shape change has somewhere to look. */
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
    title: title.trim(),
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
 * `prompts/store.ts` does: all five below are read-modify-write, and two of
 * them interleaving would lose whichever read first. Reachable from one
 * window alone: the row's done-toggle in `TodosPanel.tsx` has no busy guard,
 * so two quick clicks on two different rows issue overlapping calls, and this
 * queue is what stops the second one clobbering the first's write. It does
 * NOT defend against a second pTerm process, the same bound `ConfigStore`'s
 * own queue has.
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
 * the current list: the modal can still be open on a todo's id after
 * `todos-refresh` re-reads a `todos.json` that was hand-edited to remove it,
 * and saving from that stale open id must not turn into an error.
 */
export function updateTodo(id: string, patch: TodoPatch): Promise<TodoRecord[]> {
  return serialise(async () => {
    const before = await readTodos()
    if (!before.some((todo) => todo.id === id)) return before
    // A patch that would empty the title keeps the stored one.
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
