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
 * Simple case-insensitive substring search over title and body, with no ranking or
 * scoring. Rows are filtered by this Boolean only; any relevance ordering comes
 * from the sort mode the user picked. Fuzzy ranking would have nothing to order.
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
