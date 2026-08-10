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
