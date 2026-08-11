/**
 * Converts user-typed input into a loadable URL or returns null if not a URL.
 *
 * The core papercut: loopback services are always HTTP (a dev server running
 * locally), but public domains default to HTTPS. Get it backwards and every
 * bare hostname you type fails on TLS. The LOOPBACK branch prevents that
 * confusion by routing loopback addresses to http before scheme detection.
 *
 * The LOOPBACK test runs first to distinguish loopback names like `localhost`
 * and `localhost:3000` before the SCHEME test sees them. This ordering is
 * insurance against a future loosening of the SCHEME regex: if someone
 * simplifies it to a general "letters followed by colon" pattern, the
 * loopback-first order saves the function from treating `localhost:3000` as if
 * `localhost` were a scheme.
 *
 * The SCHEME pattern is an explicit allowlist of known schemes like
 * `https?|file|about` instead of a general regex like `[a-z][a-z0-9+.-]*:`.
 * The general form would incorrectly match `example.com:8080` as a scheme and
 * leave it unchanged, when it should be prefixed with `https://`. An allowlist
 * avoids this false positive more naturally than a negative lookahead would.
 */

const SCHEME = /^(https?|file|about|data|chrome|devtools|view-source):/i

// Matches loopback addresses and localhost. Private LAN ranges like 192.168.x.x
// are deliberately out of scope: this function was specified and tested against
// loopback only, and extending it to private ranges should be a deliberate
// decision made with concrete test cases, not an assumption.
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i

export function normaliseUrl(input: string): string | null {
  const text = input.trim()
  if (text === '') return null
  if (LOOPBACK.test(text)) return `http://${text}`
  if (SCHEME.test(text)) return text
  return `https://${text}`
}
