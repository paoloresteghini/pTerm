// Mutation check (measured 2026-08-11, against the four debounce-behaviour
// tests below; the fifth, pinning the default delay, was added afterward and
// played no part in this check): deleted the debounce from
// `createUrlSync.schedule`, making
// it call `send` immediately instead of through `setTimeout`. Ran
// `npx vitest run tests/unit/urlSync.test.ts` against that mutant. Before
// guessing, the expectation was that two tests would catch it; the actual
// run failed three of the four, which is the result recorded here rather
// than the guess:
//   - "coalesces two schedules within the delay into one send, carrying the
//     last url": FAILED, "expected 'vi.fn()' to be called 1 times, but got
//     2 times" (`send` fired once per `schedule` call instead of once for
//     the pair).
//   - "sends once after the delay following a single schedule": FAILED,
//     "expected 'vi.fn()' to not be called at all, but actually been called
//     1 times" (`send` had already fired at `schedule` time, before the
//     499ms `advanceTimersByTime` this assertion runs after).
//   - "cancel before the delay elapses means send is never called": FAILED,
//     the same "actually been called 1 times" (`send` fires before `cancel`
//     gets a timer to clear).
// Only "two schedules separated by more than the delay produce two sends"
// passed under the mutant: two immediate sends and two debounced sends both
// total two calls with the same arguments, so that test alone does not
// prove a debounce exists; the other three do. Restored the real
// `schedule` afterwards and diffed the restored file byte-for-byte against
// a copy taken before the mutation (the file was untracked at the time, so
// `git diff` would have shown nothing regardless): identical. The suite
// below is green again with the debounce back in place.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createUrlSync } from '../../src/renderer/lib/urlSync'

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createUrlSync', () => {
  it('coalesces two schedules within the delay into one send, carrying the last url', () => {
    const send = vi.fn()
    const sync = createUrlSync(send, 500)
    sync.schedule('p1', 'https://example.com/a')
    sync.schedule('p1', 'https://example.com/b')
    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('p1', 'https://example.com/b')
  })

  it('sends once after the delay following a single schedule', () => {
    const send = vi.fn()
    const sync = createUrlSync(send, 500)
    sync.schedule('p1', 'https://example.com')
    vi.advanceTimersByTime(499)
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('cancel before the delay elapses means send is never called', () => {
    const send = vi.fn()
    const sync = createUrlSync(send, 500)
    sync.schedule('p1', 'https://example.com')
    sync.cancel()
    vi.advanceTimersByTime(1000)
    expect(send).not.toHaveBeenCalled()
  })

  it('two schedules separated by more than the delay produce two sends', () => {
    const send = vi.fn()
    const sync = createUrlSync(send, 500)
    sync.schedule('p1', 'https://example.com/a')
    vi.advanceTimersByTime(500)
    sync.schedule('p1', 'https://example.com/b')
    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(1, 'p1', 'https://example.com/a')
    expect(send).toHaveBeenNthCalledWith(2, 'p1', 'https://example.com/b')
  })

  // Every other case above passes `500` explicitly, which pins nothing about
  // the default: `BrowserPane.tsx` calls `createUrlSync(window.pterm.setPaneUrl)`
  // with no second argument at all, relying on `delayMs = 500`. Widening that
  // default to, say, 5000 would leave the four cases above green while
  // production's debounce drifted tenfold, so this constructs the same way
  // production does and pins the actual wait.
  it('defaults the delay to 500ms when none is passed', () => {
    const send = vi.fn()
    const sync = createUrlSync(send)
    sync.schedule('p1', 'https://example.com')
    vi.advanceTimersByTime(499)
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
