import { describe, expect, it } from 'vitest'
import { SCAN_TAIL_BYTES, scanForLocalUrl } from '../../src/main/devserver/scan'

describe('scanForLocalUrl', () => {
  it('finds a URL whose port is wrapped in ANSI escapes, as Vite prints it', () => {
    // Vite colours the port, so the escape codes sit INSIDE the URL text.
    const line = '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\r\n'
    expect(scanForLocalUrl('', line).url).toBe('http://localhost:5173/')
  })

  it('finds a URL split across two chunks', () => {
    const first = scanForLocalUrl('', 'Local: http://localhos')
    expect(first.url).toBeNull()
    expect(scanForLocalUrl(first.tail, 't:3000/\r\n').url).toBe('http://localhost:3000/')
  })

  it('ignores a URL that is not loopback', () => {
    expect(scanForLocalUrl('', 'Network: https://example.com:5173/\r\n').url).toBeNull()
  })

  it('returns the last loopback URL when a chunk holds several', () => {
    const chunk = 'Local: http://localhost:3000/\r\nLocal: http://127.0.0.1:8080/\r\n'
    expect(scanForLocalUrl('', chunk).url).toBe('http://127.0.0.1:8080/')
  })

  it('keeps a bounded tail so a long silent stream cannot grow memory', () => {
    const { tail } = scanForLocalUrl('', 'x'.repeat(SCAN_TAIL_BYTES * 4))
    expect(tail.length).toBeLessThanOrEqual(SCAN_TAIL_BYTES)
  })
})
