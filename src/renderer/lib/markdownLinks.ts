/**
 * The scheme of a URL, or null when the string is not an absolute URL at all.
 *
 * `URL` rather than any string test on purpose, and this is the whole reason
 * this file exists as a pair of functions rather than two inline conditions.
 * A `startsWith('javascript:')` check misses `JaVaScRiPt:` and misses
 * `java\nscript:`, both of which browsers still execute; the parser folds the
 * case and strips the control characters before reporting the protocol, so
 * asking it is the only form of this check that is not a guess.
 *
 * A relative href (`./other.md`, `//host`, `#anchor`, the empty string) throws
 * here and answers null. That is the intended answer rather than a swallowed
 * error: no base is supplied deliberately, because there is no location for
 * one to resolve against.
 */
function schemeOf(url: string | undefined): string | null {
  if (url === undefined) return null
  try {
    return new URL(url).protocol
  } catch {
    return null
  }
}

/**
 * The URL a link in a rendered markdown pane may be handed to
 * `window.pterm.openExternal`, or null when it may not be followed at all.
 *
 * The renderer holds `window.pterm`, so letting an anchor act on its own href
 * is not a page change: it replaces the running app with whatever the document
 * pointed at, bridge and all. The rendered view therefore cancels every click
 * and consults this instead, and a null means the click does nothing.
 *
 * **An allow-list, so every unanticipated scheme fails closed.** The dangerous
 * set is open-ended (`javascript:`, `file:`, `data:`, whatever a future
 * Chromium ships), and http/https is the entire set that means "a page
 * somewhere else", which is the only thing this pane is offering to do.
 *
 * The original string is returned rather than the parser's normalised form,
 * because normalising rewrites hrefs the author wrote deliberately
 * (`http://example.com` comes back with a trailing slash). Main re-parses it
 * with the same parser at `isOpenable` before `shell.openExternal` sees it.
 *
 * That second check in main is not made redundant by this one, and this one is
 * not made redundant by it: they guard different callers. `isOpenable`'s own
 * comment describes itself as a second check at the handler's boundary for the
 * same reason. Duplicating a five-line scheme test across a process boundary
 * is the established shape here, not drift.
 */
export function externalHref(href: string | undefined): string | null {
  const scheme = schemeOf(href)
  return scheme === 'http:' || scheme === 'https:' ? (href ?? null) : null
}

/**
 * The `src` an `![]()` may be drawn with, or null to draw its alt text.
 *
 * Relative sources are the common case in a repository README and the case
 * this cannot serve. The renderer's origin is the app bundle, so
 * `<img src="docs/x.png">` resolves against that and paints a broken-image
 * glyph. Rendering the alt text instead shows the words the author wrote,
 * which is strictly more than the glyph carries.
 *
 * `data:` is admitted here and refused by `externalHref` above. The asymmetry
 * is the point: a `data:` in an `<img>` paints pixels inside this pane, while
 * the same string sent to `shell.openExternal` hands a document to whatever
 * the user's OS has registered for its type.
 */
export function renderableImageSrc(src: string | undefined): string | null {
  const scheme = schemeOf(src)
  return scheme === 'http:' || scheme === 'https:' || scheme === 'data:' ? (src ?? null) : null
}
