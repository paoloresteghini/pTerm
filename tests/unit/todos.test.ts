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
