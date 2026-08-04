import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createNoteSaver } from '../../src/renderer/lib/noteSaver'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createNoteSaver', () => {
  it('writes once after the delay, with the last text', () => {
    const write = vi.fn()
    const saver = createNoteSaver(write, 500)
    saver.edit('p1', 's')
    saver.edit('p1', 'st')
    vi.advanceTimersByTime(499)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith('p1', 'st')
  })

  it('restarts the delay on every edit', () => {
    const write = vi.fn()
    const saver = createNoteSaver(write, 500)
    saver.edit('p1', 'a')
    vi.advanceTimersByTime(400)
    saver.edit('p1', 'ab')
    vi.advanceTimersByTime(400)
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(100)
    expect(write).toHaveBeenCalledWith('p1', 'ab')
  })

  it('flush writes immediately and cancels the timer', () => {
    const write = vi.fn()
    const saver = createNoteSaver(write, 500)
    saver.edit('p1', 'a')
    saver.flush()
    expect(write).toHaveBeenCalledWith('p1', 'a')
    vi.advanceTimersByTime(1000)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('flush with nothing pending writes nothing', () => {
    const write = vi.fn()
    createNoteSaver(write, 500).flush()
    expect(write).not.toHaveBeenCalled()
  })

  it('a second flush after the first writes nothing more', () => {
    const write = vi.fn()
    const saver = createNoteSaver(write, 500)
    saver.edit('p1', 'a')
    saver.flush()
    saver.flush()
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('an edit under a new project id flushes the old project first', () => {
    // The race the spec calls out: text typed under project A must never be
    // written under project B's id because a switch landed mid-debounce.
    const write = vi.fn()
    const saver = createNoteSaver(write, 500)
    saver.edit('p1', 'note for p1')
    saver.edit('p2', 'note for p2')
    expect(write).toHaveBeenCalledWith('p1', 'note for p1')
    vi.advanceTimersByTime(500)
    expect(write).toHaveBeenCalledWith('p2', 'note for p2')
    expect(write).toHaveBeenCalledTimes(2)
  })
})
