import { describe, it, expect } from 'vitest'
import { parseRequestLine, formatResponseLine, MAX_LINE_BYTES } from '../../src/main/mcp/protocol'
import type { McpRequest } from '../../src/main/mcp/protocol'

const PANE_ID = 'pane-abc123'

describe('parseRequestLine', () => {
  it('reads a well-formed request', () => {
    expect(
      parseRequestLine(`{"id":1,"paneId":"${PANE_ID}","tool":"browser_navigate","args":{"url":"http://localhost:3000"}}`)
    ).toEqual({
      id: 1,
      paneId: PANE_ID,
      tool: 'browser_navigate',
      args: { url: 'http://localhost:3000' },
    })
  })

  it('defaults args to {} when absent', () => {
    expect(parseRequestLine(`{"id":1,"paneId":"${PANE_ID}","tool":"browser_navigate"}`)).toEqual({
      id: 1,
      paneId: PANE_ID,
      tool: 'browser_navigate',
      args: {},
    })
  })

  it('tolerates trailing whitespace and a carriage return', () => {
    expect(parseRequestLine(`{"id":1,"paneId":"${PANE_ID}","tool":"browser_navigate"}\r`)?.tool).toBe(
      'browser_navigate'
    )
  })

  it('ignores extra fields on an otherwise valid request', () => {
    expect(
      parseRequestLine(`{"id":1,"paneId":"${PANE_ID}","tool":"browser_navigate","extra":true}`)
    ).toEqual({
      id: 1,
      paneId: PANE_ID,
      tool: 'browser_navigate',
      args: {},
    })
  })

  // Everything below must return null rather than throw. This is the
  // bridge's only untrusted input: it is fed by whatever runs the socket
  // client, so the parser refuses what it does not recognise instead of
  // accepting what it cannot disprove.
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not json', 'hello'],
    ['truncated json', `{"id":1,"paneId":"${PANE_ID}"`],
    ['an array', '[1,2,3]'],
    ['a bare string', '"nope"'],
    ['a bare number', '42'],
    ['null', 'null'],
    ['a missing id', `{"paneId":"${PANE_ID}","tool":"browser_navigate"}`],
    ['an id that is not a number', `{"id":"1","paneId":"${PANE_ID}","tool":"browser_navigate"}`],
    ['a NaN id', `{"id":null,"paneId":"${PANE_ID}","tool":"browser_navigate"}`],
    ['a missing paneId', '{"id":1,"tool":"browser_navigate"}'],
    ['a paneId that is not a string', `{"id":1,"paneId":7,"tool":"browser_navigate"}`],
    ['a missing tool', `{"id":1,"paneId":"${PANE_ID}"}`],
    ['a tool that is not a string', `{"id":1,"paneId":"${PANE_ID}","tool":7}`],
    ['args that is an array', `{"id":1,"paneId":"${PANE_ID}","tool":"browser_navigate","args":[1]}`],
    ['args that is a string', `{"id":1,"paneId":"${PANE_ID}","tool":"browser_navigate","args":"nope"}`],
    ['args that is null', `{"id":1,"paneId":"${PANE_ID}","tool":"browser_navigate","args":null}`],
  ])('refuses %s', (_label, line) => {
    expect(parseRequestLine(line)).toBeNull()
  })

  it('refuses a line longer than the cap without parsing it', () => {
    const padded = `{"id":1,"paneId":"${PANE_ID}","tool":"browser_navigate","args":{"junk":"${'x'.repeat(
      MAX_LINE_BYTES
    )}"}}`
    expect(parseRequestLine(padded)).toBeNull()
  })
})

describe('formatResponseLine', () => {
  it('writes exactly one line', () => {
    const line = formatResponseLine({ id: 1, ok: true, result: { done: true } })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd().includes('\n')).toBe(false)
  })

  it('round-trips a success response', () => {
    const response = { id: 1, ok: true as const, result: { title: 'localhost' } }
    expect(JSON.parse(formatResponseLine(response))).toEqual(response)
  })

  it('round-trips a failure response', () => {
    const response = { id: 2, ok: false as const, error: 'pane not found' }
    expect(JSON.parse(formatResponseLine(response))).toEqual(response)
  })

  // The case worth writing first: an error message is free text that could
  // come from anywhere downstream (a thrown error, a rejected navigation).
  // If it reached the wire with a raw newline in it, it would forge a
  // second line the bridge would try to parse as its own response.
  it('escapes a newline in the error string instead of forging a second line', () => {
    const response = { id: 3, ok: false as const, error: 'line one\nline two' }
    const line = formatResponseLine(response)

    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd().includes('\n')).toBe(false)
    expect(JSON.parse(line)).toEqual(response)
  })
})

describe('McpRequest shape', () => {
  it('parseRequestLine produces a value assignable to McpRequest', () => {
    const request: McpRequest | null = parseRequestLine(
      `{"id":1,"paneId":"${PANE_ID}","tool":"browser_navigate"}`
    )
    expect(request).not.toBeNull()
  })
})
