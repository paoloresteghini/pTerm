import { describe, it, expect } from 'vitest'
import { formatHookLine, parseHookLine, MAX_LINE_BYTES } from '../../src/main/hooks/protocol'

const ID = '0123456789abcdef'

describe('parseHookLine', () => {
  it('reads a well-formed line', () => {
    expect(parseHookLine(`{"tabId":"${ID}","event":"Stop","at":1700000000000}`)).toEqual({
      tabId: ID,
      event: 'Stop',
      at: 1700000000000,
    })
  })

  it('round-trips what formatHookLine writes', () => {
    const message = { tabId: ID, event: 'Notification' as const, at: 42 }
    expect(parseHookLine(formatHookLine(message))).toEqual(message)
  })

  it('tolerates trailing whitespace and a carriage return', () => {
    expect(parseHookLine(`{"tabId":"${ID}","event":"Stop","at":1}\r`)?.event).toBe('Stop')
  })

  // Everything below must return null rather than throw. This is the app's
  // only untrusted input: the socket is reachable by anything on the machine
  // that can open it, so the parser refuses what it does not recognise
  // instead of accepting what it cannot disprove.
  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not json', 'hello'],
    ['truncated json', `{"tabId":"${ID}"`],
    ['an array', '[]'],
    ['a bare string', '"nope"'],
    ['null', 'null'],
    ['a tab id that is not 16 hex', '{"tabId":"zzz","event":"Stop","at":1}'],
    ['a tab id of the wrong length', '{"tabId":"abc","event":"Stop","at":1}'],
    ['an uppercase tab id', '{"tabId":"0123456789ABCDEF","event":"Stop","at":1}'],
    ['an unknown event', `{"tabId":"${ID}","event":"Whatever","at":1}`],
    ['an event that is not a string', `{"tabId":"${ID}","event":7,"at":1}`],
    ['a missing timestamp', `{"tabId":"${ID}","event":"Stop"}`],
    ['a timestamp that is not a number', `{"tabId":"${ID}","event":"Stop","at":"soon"}`],
    ['a NaN timestamp', `{"tabId":"${ID}","event":"Stop","at":null}`],
  ])('refuses %s', (_label, line) => {
    expect(parseHookLine(line)).toBeNull()
  })

  it('refuses a line longer than the cap without parsing it', () => {
    const padded = `{"tabId":"${ID}","event":"Stop","at":1,"junk":"${'x'.repeat(MAX_LINE_BYTES)}"}`
    expect(parseHookLine(padded)).toBeNull()
  })

  it('ignores extra fields on an otherwise valid line', () => {
    expect(parseHookLine(`{"tabId":"${ID}","event":"Stop","at":1,"extra":true}`)).toEqual({
      tabId: ID,
      event: 'Stop',
      at: 1,
    })
  })
})

describe('parseHookLine, exit lines', () => {
  it('reads a dead pane reporting a non-zero status', () => {
    expect(parseHookLine(`{"tabId":"${ID}","event":"Exit","status":3,"at":1700000000000}`)).toEqual({
      tabId: ID,
      event: 'Exit',
      status: 3,
      at: 1700000000000,
    })
  })

  it('reads a clean exit, which is a status of zero and not a missing one', () => {
    expect(parseHookLine(`{"tabId":"${ID}","event":"Exit","status":0,"at":1}`)).toEqual({
      tabId: ID,
      event: 'Exit',
      status: 0,
      at: 1,
    })
  })

  it('round-trips what formatHookLine writes for an exit', () => {
    const message = { tabId: ID, event: 'Exit' as const, status: 137, at: 42 }
    expect(parseHookLine(formatHookLine(message))).toEqual(message)
  })

  // An exit line reaches the same untrusted socket as everything else, and its
  // status is about to be turned into a red dot. A status nobody can explain is
  // dropped rather than guessed at.
  it.each([
    ['an exit with no status at all', `{"tabId":"${ID}","event":"Exit","at":1}`],
    ['a negative status', `{"tabId":"${ID}","event":"Exit","status":-1,"at":1}`],
    ['a fractional status', `{"tabId":"${ID}","event":"Exit","status":1.5,"at":1}`],
    ['a status that is not a number', `{"tabId":"${ID}","event":"Exit","status":"3","at":1}`],
    ['a NaN status', `{"tabId":"${ID}","event":"Exit","status":null,"at":1}`],
    ['an exit with a bad tab id', '{"tabId":"nope","event":"Exit","status":1,"at":1}'],
    ['an exit with no timestamp', `{"tabId":"${ID}","event":"Exit","status":1}`],
  ])('refuses %s', (_label, line) => {
    expect(parseHookLine(line)).toBeNull()
  })

  it('does not let a status turn an ordinary hook event into an exit', () => {
    expect(parseHookLine(`{"tabId":"${ID}","event":"Stop","status":3,"at":1}`)).toEqual({
      tabId: ID,
      event: 'Stop',
      at: 1,
    })
  })
})

describe('formatHookLine', () => {
  it('writes exactly one line', () => {
    const line = formatHookLine({ tabId: ID, event: 'Stop', at: 1 })
    expect(line.endsWith('\n')).toBe(true)
    expect(line.trimEnd().includes('\n')).toBe(false)
  })

  it('does not put a status on an ordinary hook event', () => {
    expect(formatHookLine({ tabId: ID, event: 'Stop', at: 1 })).not.toContain('status')
  })
})
