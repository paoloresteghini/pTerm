import { describe, it, expect } from 'vitest'
import { takeLines } from '../../src/main/mcp/server'
import { MAX_LINE_BYTES } from '../../src/main/mcp/protocol'

/**
 * The read buffer's ceiling, which no test could see while the framing lived
 * inside `McpServer#accept`.
 *
 * `tests/integration/mcpServer.test.ts` used to carry a test named for this
 * property. It sent 2MB with no newline, then a newline and a valid request,
 * and asserted the valid request was answered. Measured 2026-08-12: it passed
 * byte-identically with the ceiling deleted, because the 2MB simply got
 * buffered, the newline handed `take` a 2MB line, and both `parseRequestLine`
 * and `recoverId` refuse a line that size on `MAX_LINE_BYTES` anyway. The
 * request after it was answered the same way either way, and the only
 * property that differed was peak heap. That test is gone; this is what
 * replaced it.
 *
 * The multiplier is written out here rather than imported, the same reason
 * `e2eSafety.test.ts` re-declares `SOCKET_PREFIX`: importing the constant
 * would make this file agree with the source by construction, including when
 * both were changed together.
 */
const CEILING = MAX_LINE_BYTES * 128

describe('takeLines', () => {
  it('drops a held buffer that has passed the ceiling with no newline in it', () => {
    const runaway = 'y'.repeat(CEILING + 1)

    expect(takeLines('', runaway)).toEqual({ lines: [], held: '' })
  })

  it('drops it across chunks too, which is how a socket actually delivers one', () => {
    // Nothing in one chunk is over the ceiling; the accumulation is. A
    // per-chunk check rather than a check on the held buffer would pass the
    // test above and fail this one.
    const chunk = 'y'.repeat(CEILING / 2)

    const first = takeLines('', chunk)
    expect(first.held).toHaveLength(CEILING / 2)

    const second = takeLines(first.held, `${chunk}yy`)
    expect(second).toEqual({ lines: [], held: '' })
  })

  it('holds a buffer that is under the ceiling, so a split line still arrives', () => {
    // The control, and the reason the clear cannot simply be "drop whatever
    // has no newline yet": a real request split across two chunks is exactly
    // that shape, and must be framed rather than thrown away.
    const first = takeLines('', '{"id":1,"paneId":"p",')
    expect(first).toEqual({ lines: [], held: '{"id":1,"paneId":"p",' })

    const second = takeLines(first.held, '"tool":"a","args":{}}\n')
    expect(second).toEqual({
      lines: ['{"id":1,"paneId":"p","tool":"a","args":{}}'],
      held: '',
    })
  })

  it('frames every complete line in one chunk and holds the partial tail', () => {
    const result = takeLines('', 'one\ntwo\nthr')

    expect(result).toEqual({ lines: ['one', 'two'], held: 'thr' })
  })

  it('measures the ceiling in bytes, not characters', () => {
    // Two bytes per character, so half as many characters reach the same
    // ceiling. A `buffer.length` check would leave this one held.
    const runaway = 'é'.repeat(CEILING / 2 + 1)
    expect(runaway.length).toBeLessThan(CEILING)

    expect(takeLines('', runaway)).toEqual({ lines: [], held: '' })
  })
})
