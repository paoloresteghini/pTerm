import { isLoopbackUrl } from '../../shared/localOrigin'

/**
 * Strips ANSI CSI escape sequences (the color and cursor codes a dev server
 * wraps its banner text in, e.g. `\x1b[32m` or `\x1b[1m`). Matching against
 * the raw stream would miss URLs whose port digits sit inside such a
 * sequence, as Vite prints them.
 */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

const URL_PATTERN = /https?:\/\/\S+/g

/**
 * How many trailing characters of the raw stream carry over between scans.
 *
 * The Vite banner line this module is tested against
 * (`  ➜  Local:   http://localhost:5173/`, ANSI codes included) is 76
 * characters. A chunk boundary can land anywhere inside that line, and the
 * tail must still hold enough of it for the next chunk to complete the
 * match. 512 gives roughly 6x headroom over that measured line, enough for
 * a longer hostname, a deeper path, or a dev server that wraps more of the
 * line in escape codes than Vite does.
 */
export const SCAN_TAIL_BYTES = 512

/**
 * Scans `tail + chunk` for the last loopback URL a dev server announced,
 * and returns it along with the new tail to carry into the next call.
 *
 * Pure: takes the previous tail and the newly read chunk, returns the URL
 * found (or null) and the trailing text to pass as `tail` next time.
 */
export function scanForLocalUrl(tail: string, chunk: string): { url: string | null; tail: string } {
  const full = tail + chunk
  const stripped = stripAnsi(full)

  const matches = stripped.match(URL_PATTERN) ?? []
  const loopbackUrls = matches.filter(isLoopbackUrl)
  const url = loopbackUrls.length > 0 ? loopbackUrls[loopbackUrls.length - 1] : null

  const newTail = full.length > SCAN_TAIL_BYTES ? full.slice(full.length - SCAN_TAIL_BYTES) : full

  return { url, tail: newTail }
}
