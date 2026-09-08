import { describe, it, expect } from 'vitest'
import { externalHref, renderableImageSrc } from '../../src/renderer/lib/markdownLinks'

/**
 * What a link inside a rendered `.md` pane is allowed to do.
 *
 * The renderer holds `window.pterm`, so a navigation out of it is not a page
 * change, it is the app being replaced by whatever the document pointed at.
 * The rendered view therefore never lets an anchor act on its own href: it
 * cancels the click and hands what this function returns to
 * `window.pterm.openExternal`, or does nothing at all when it returns null.
 *
 * Main validates the scheme a second time inside the `openExternal` handler.
 * That is deliberate belt-and-braces and not a reason to be lax here: this is
 * the boundary the user's own repository files reach, and a `.md` in a cloned
 * project is not text the user wrote.
 */
describe('externalHref', () => {
  it('passes http and https through unchanged', () => {
    expect(externalHref('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d')
    expect(externalHref('http://example.com')).toBe('http://example.com')
  })

  it('refuses every other scheme', () => {
    for (const href of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'chrome://settings',
    ]) {
      expect(externalHref(href)).toBe(null)
    }
  })

  /**
   * A scheme is not matched as a prefix string, it is parsed.
   *
   * `JaVaScRiPt:` and a form carrying a newline inside the scheme are the two
   * shapes a `startsWith('javascript:')` check misses, and both are live in
   * browsers. Parsing with `URL` folds the case and rejects the second, which
   * is why the implementation must not do its own string matching.
   */
  it('is not fooled by case or by whitespace inside the scheme', () => {
    expect(externalHref('JaVaScRiPt:alert(1)')).toBe(null)
    expect(externalHref('java\nscript:alert(1)')).toBe(null)
    expect(externalHref('  javascript:alert(1)')).toBe(null)
  })

  /**
   * Relative links resolve against nothing here.
   *
   * A `.md` linking `./other.md` means a file beside it in the project, and
   * this pane has no way to open that: the rendered view is handed a string,
   * not a location. Null rather than a guess, so the click is inert instead of
   * navigating the renderer at a path that does not exist. Protocol-relative
   * `//host` is in the same bucket for the same reason.
   */
  it('refuses relative and protocol-relative hrefs', () => {
    for (const href of ['./other.md', '../up.md', '/abs/path.md', '//example.com', '#anchor', '']) {
      expect(externalHref(href)).toBe(null)
    }
  })

  it('refuses a missing href', () => {
    expect(externalHref(undefined)).toBe(null)
  })
})

/**
 * Which `![]()` sources are worth putting in an `<img>`.
 *
 * A relative image path is the common case in a repository README and the one
 * this cannot serve: the renderer's origin is the app bundle, so `<img
 * src="docs/x.png">` resolves to nothing and paints a broken-image glyph. The
 * rendered view draws the alt text for those instead, which is at least the
 * words the author wrote.
 */
describe('renderableImageSrc', () => {
  it('accepts http, https and data urls', () => {
    expect(renderableImageSrc('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(renderableImageSrc('http://example.com/a.png')).toBe('http://example.com/a.png')
    expect(renderableImageSrc('data:image/png;base64,iVBOR')).toBe('data:image/png;base64,iVBOR')
  })

  /**
   * `data:` is accepted here and refused by `externalHref`, which is the one
   * asymmetry between the two and is intentional. A `data:` handed to an
   * `<img>` paints pixels; the same string handed to `shell.openExternal`
   * hands a document to the user's default handler. Only the second is a way
   * out of the app.
   */
  it('refuses schemes that are not one of those three', () => {
    for (const src of ['javascript:alert(1)', 'file:///a.png', 'chrome://x']) {
      expect(renderableImageSrc(src)).toBe(null)
    }
  })

  it('refuses relative sources and a missing one', () => {
    expect(renderableImageSrc('docs/x.png')).toBe(null)
    expect(renderableImageSrc('./x.png')).toBe(null)
    expect(renderableImageSrc(undefined)).toBe(null)
  })
})
