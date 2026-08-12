/**
 * Whether a URL points at a page served from loopback: `localhost`,
 * `127.0.0.1`, `::1`, or a `.localhost` subdomain, on `http:` or `https:`.
 * This is the security boundary a browser pane driven by an MCP tool will be
 * confined to (see the plan's later tasks), so it answers on the parsed URL
 * rather than on the raw text.
 *
 * Reads `url.hostname` rather than `url.host` or the input string: `host`
 * carries the port, and the raw string can carry credentials, a query, or a
 * fragment, any of which can hold the word "localhost" without the request
 * ever going there (`https://user:pass@evil.com/?x=localhost`).
 *
 * The `.localhost` subdomain check requires the dot. `endsWith('localhost')`
 * without it would also match `notlocalhost`, and `127.0.0.1.evil.com` ends
 * in neither `localhost` nor `.localhost`, so it is refused correctly by the
 * same rule.
 *
 * `url.hostname` keeps the brackets around an IPv6 literal (`[::1]`, not
 * `::1`), so that is the form compared against.
 *
 * Any input `new URL` cannot parse, and any non-http(s) scheme (`file:`,
 * `about:`, `chrome:`, `javascript:`, `data:`), is refused.
 */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false
  }

  const hostname = url.hostname
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')
}
