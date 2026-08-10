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

  it('keeps input order for rows with equal priority and equal updatedAt', () => {
    const rows = [
      todo({ id: 'a', priority: 'high', updatedAt: '2026-08-05T00:00:00.000Z' }),
      todo({ id: 'b', priority: 'high', updatedAt: '2026-08-05T00:00:00.000Z' }),
      todo({ id: 'c', priority: 'high', updatedAt: '2026-08-05T00:00:00.000Z' }),
    ]
    expect(sortTodos(rows, 'priority').map((row) => row.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate its input', () => {
    const rows = [todo({ id: 'low', priority: 'low' }), todo({ id: 'high', priority: 'high' })]
    sortTodos(rows, 'priority')
    expect(rows.map((row) => row.id)).toEqual(['low', 'high'])
  })

  it('sorts unparseable dates as epoch, last under updated sort', () => {
    const rows = [
      todo({ id: 'valid', updatedAt: '2026-08-05T00:00:00.000Z' }),
      todo({ id: 'invalid', updatedAt: 'not-a-date' }),
    ]
    expect(sortTodos(rows, 'updated').map((row) => row.id)).toEqual(['valid', 'invalid'])
  })
})

describe('nextTodoSort', () => {
  it('cycles through the three and back round', () => {
    const seen: TodoSort[] = ['priority']
    for (let index = 0; index < 3; index += 1) seen.push(nextTodoSort(seen[seen.length - 1]))
    expect(seen).toEqual(['priority', 'newest', 'updated', 'priority'])
  })
})
