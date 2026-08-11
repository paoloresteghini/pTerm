/**
 * Converts user-typed input into a loadable URL or returns null if not a URL.
 *
 * The core papercut: loopback services are always HTTP (a dev server running
 * locally), but public domains default to HTTPS. Get it backwards and every
 * bare hostname you type fails on TLS. The two orderings below prevent the
 * confusion.
 *
 * The LOOPBACK test runs first because it needs to distinguish loopback names
 * like `localhost` and `localhost:3000` before the SCHEME test sees them. If
 * a scheme test runs first (matching "letters followed by a colon"), it would
 * treat `localhost:3000` as if `localhost` were a scheme and return it
 * unchanged, which is wrong.
 *
 * The SCHEME pattern is an explicit allowlist of known schemes like
 * `https?|file|about` instead of a general regex like `[a-z][a-z0-9+.-]*:`.
 * The general form would incorrectly match `example.com:8080` as a scheme and
 * leave it unchanged, when it should be prefixed with `https://`. The
 * allowlist is the only way to exclude numeric ports from scheme detection.
 */

const SCHEME = /^(https?|file|about|data|chrome|devtools|view-source):/i

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i

export function normaliseUrl(input: string): string | null {
  const text = input.trim()
  if (text === '') return null
  if (LOOPBACK.test(text)) return `http://${text}`
  if (SCHEME.test(text)) return text
  return `https://${text}`
}
