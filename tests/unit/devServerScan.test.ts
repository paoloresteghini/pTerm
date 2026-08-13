import { describe, expect, it } from 'vitest'
import { SCAN_TAIL_BYTES, scanForLocalUrl } from '../../src/main/devserver/scan'

/**
 * One `onData` chunk, copied byte for byte out of a capture rather than
 * written by hand.
 *
 * How it was captured: a real `vite` (5.4.21) started by `npm run dev` in a
 * throwaway project, inside a tmux session, read through a `node-pty` client
 * spawned the way `src/main/pty/session.ts` spawns one (`tmux -L <socket>
 * new-session`, `TERM=xterm-256color`, `COLORTERM=truecolor`). Every chunk
 * the client emitted was recorded; this is the one that carried the
 * announcement, unedited apart from the escape bytes being spelled `\x1b`
 * here so they survive being read.
 *
 * What makes it different from a hand-written banner, and why it is here:
 * Vite bolds the port INSIDE the URL, and tmux re-emits that end-of-bold as
 * terminfo's `sgr0`, which for `xterm-256color` is `\E(B\E[m` and not a bare
 * `\E[m`. So `\x1b(B` sits between the port digits and the trailing slash.
 * A hand-written fixture that puts only CSI codes around the URL, which is
 * what this file used to hold, cannot produce that byte, and a strip that
 * handles CSI alone leaves it glued into the URL where it makes the whole
 * match unparseable. Every pTerm pane is a tmux client, so this is the only
 * shape a user's pane ever produces.
 */
const CAPTURED_VITE_CHUNK =
  '  \x1b[32m➜\x1b[39m  \x1b[1mLocal\x1b(B\x1b[m:   \x1b[36mhttp://localhost:\x1b[1m5401\x1b(B\x1b[m\x1b[36m/\r\n\x1b(B\x1b[m\x1b[2m  \x1b[32m➜\x1b[39m  \x1b[1mNetwork\x1b(B\x1b[m\x1b[2m: use \x1b(B\x1b[m\x1b[1m--host\x1b(B\x1b[m\x1b[2m to expose\r\n\x1b(B\x1b[m'

/** Where `CAPTURED_VITE_CHUNK` holds `\x1b(B`, between the port and the slash. */
const SPLIT_INSIDE_SGR0 = CAPTURED_VITE_CHUNK.indexOf('5401') + '5401\x1b'.length

describe('scanForLocalUrl', () => {
  it('finds the URL in a chunk captured from a real Vite server through tmux', () => {
    expect(scanForLocalUrl('', CAPTURED_VITE_CHUNK).url).toBe('http://localhost:5401/')
  })

  it('finds it when a chunk boundary splits the escape inside the URL', () => {
    // The same captured bytes, cut between the ESC and the `(B` that follows
    // it: the half a chunk boundary is most likely to break, since that
    // escape is the one sitting inside the URL text.
    const first = scanForLocalUrl('', CAPTURED_VITE_CHUNK.slice(0, SPLIT_INSIDE_SGR0))
    // That half ends on a bare ESC, which no escape rule can complete. What
    // is filed for the moment before the next chunk arrives is the origin
    // with nothing after it, NOT the origin with a raw ESC stuck on the end:
    // `new URL` accepts the latter (it drops a trailing control character),
    // so `isLoopbackUrl` would have passed it through to a browser pane.
    expect(first.url).toBe('http://localhost:5401')
    const second = scanForLocalUrl(first.tail, CAPTURED_VITE_CHUNK.slice(SPLIT_INSIDE_SGR0))
    expect(second.url).toBe('http://localhost:5401/')
  })

  it('finds a URL whose port is wrapped in ANSI escapes, as Vite prints it', () => {
    // Vite colours the port, so the escape codes sit INSIDE the URL text.
    // This is the pre-tmux shape, straight off Vite's own stdout; the capture
    // above is what the same line looks like once tmux has re-emitted it.
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

  /**
   * A loopback origin with no port at all. `new URL('http://localhost').port`
   * is the empty string, so a caller that filed this and navigated to it
   * would land on port 80, which no dev server this feature watches for is
   * on. Ordinary prose in a pane reaches here, not just a chunk boundary.
   */
  it('ignores a loopback URL that announces no port', () => {
    expect(scanForLocalUrl('', 'see the README at http://localhost/docs\r\n').url).toBeNull()
  })

  it('ignores a bare loopback origin left by a shell echo', () => {
    expect(scanForLocalUrl('', '$ printf http://127.0.0.1:\r\n').url).toBeNull()
  })

  /**
   * The carried tail is up to 512 characters of stream that the previous call
   * already scanned. A URL still sitting in it was reported then, and
   * reporting it again on every later chunk from that pane is what would let
   * a pane that has gone quiet outrank one that announced after it.
   */
  it('does not report a URL that survives only in the carried tail', () => {
    const first = scanForLocalUrl('', 'Local: http://localhost:5173/\r\n')
    expect(first.url).toBe('http://localhost:5173/')
    expect(scanForLocalUrl(first.tail, 'x').url).toBeNull()
    expect(scanForLocalUrl(first.tail, '\x1b[2K\x1b[G$ ').url).toBeNull()
  })

  it('reports a URL again when the chunk announces it a second time', () => {
    const first = scanForLocalUrl('', 'Local: http://localhost:5173/\r\n')
    const second = scanForLocalUrl(first.tail, 'Local: http://localhost:5173/\r\n')
    expect(second.url).toBe('http://localhost:5173/')
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
