/**
 * Which runs of text in a pane are links, and which click follows one.
 *
 * This file carries the weight for the whole feature. `shell.openExternal`
 * cannot be intercepted from an e2e spec — Electron exposes `shell`'s members
 * as non-writable, so a monkeypatch either throws or silently no-ops, and a
 * test built on a patch that did not install passes against a broken app (the
 * same reason `update.spec.ts` declines to assert the browser opened). So the
 * decision of WHAT is a link and WHEN a click follows it lives in a pure
 * module, tested here, and `Terminal.tsx` holds only the wiring.
 */
import { describe, it, expect } from 'vitest'
import { findLinks, followsLink, linkRange } from '../../src/renderer/lib/terminalLinks'

describe('findLinks', () => {
  it('finds a bare https url', () => {
    expect(findLinks('https://example.com')).toEqual([
      { url: 'https://example.com', start: 0, end: 19 },
    ])
  })

  it('finds a url surrounded by text, at the right offsets', () => {
    const line = 'see https://example.com now'
    const [link] = findLinks(line)
    expect(link).toEqual({ url: 'https://example.com', start: 4, end: 23 })
    // The offsets are what the range is built from, so they are asserted
    // against the line itself rather than trusted as numbers.
    expect(line.slice(link.start, link.end)).toBe('https://example.com')
  })

  it('finds http as well as https', () => {
    expect(findLinks('http://example.com').map((l) => l.url)).toEqual(['http://example.com'])
  })

  it('finds several on one line', () => {
    expect(findLinks('a https://one.com b http://two.com').map((l) => l.url)).toEqual([
      'https://one.com',
      'http://two.com',
    ])
  })

  it('keeps the path, query and fragment', () => {
    const url = 'https://example.com/a/b?x=1&y=2#frag'
    expect(findLinks(`go ${url}`).map((l) => l.url)).toEqual([url])
  })

  // Terminal output puts URLs in prose, and a trailing sentence mark is not
  // part of the address. Trailing only: a dot inside the host or path must
  // survive, which the query-string case above also guards.
  it.each([
    ['https://example.com.', 'https://example.com'],
    ['https://example.com,', 'https://example.com'],
    ['https://example.com;', 'https://example.com'],
    ['https://example.com:', 'https://example.com'],
    ['https://example.com!', 'https://example.com'],
    ['https://example.com?', 'https://example.com'],
  ])('drops trailing punctuation from %s', (line, expected) => {
    expect(findLinks(line).map((l) => l.url)).toEqual([expected])
  })

  it('drops a closing bracket it never opened', () => {
    expect(findLinks('(https://example.com)').map((l) => l.url)).toEqual(['https://example.com'])
    expect(findLinks('[https://example.com]').map((l) => l.url)).toEqual(['https://example.com'])
    expect(findLinks('<https://example.com>').map((l) => l.url)).toEqual(['https://example.com'])
  })

  // A balanced pair belongs to the address: Wikipedia and many issue trackers
  // mint URLs that end in one.
  it('keeps a closing bracket that the url opened', () => {
    const url = 'https://example.com/A_(disambiguation)'
    expect(findLinks(url).map((l) => l.url)).toEqual([url])
  })

  it('stops at whitespace', () => {
    expect(findLinks('https://example.com other').map((l) => l.url)).toEqual(['https://example.com'])
  })

  // Hyphens were untested while the character class was misread as excluding
  // them (2026-08-07). They are in most real hostnames, so the gap would have
  // shipped a feature that ignored half the links on screen.
  it.each([
    'https://my-site.com',
    'https://sub-domain.example.com/x-y?a-b=c-d',
    'https://example.com:8080/a-b',
    'https://example.com/a_b~c',
    'https://example.com/%20x',
  ])('keeps every character of %s', (url) => {
    expect(findLinks(url).map((l) => l.url)).toEqual([url])
  })

  /*
   * A pane's text arrives wrapped in escape sequences, so the run has to stop
   * at a control byte or a url would swallow the colour reset that follows it
   * and be opened with that attached.
   */
  it('stops at a control character', () => {
    const esc = String.fromCharCode(0x1b)
    expect(findLinks(`https://example.com${esc}[0m done`).map((l) => l.url)).toEqual([
      'https://example.com',
    ])
    expect(findLinks(`https://example.com${String.fromCharCode(7)}x`).map((l) => l.url)).toEqual([
      'https://example.com',
    ])
  })

  it('finds nothing in a line with no url', () => {
    expect(findLinks('just some output')).toEqual([])
    expect(findLinks('')).toEqual([])
  })

  /*
   * Schemes other than http(s) are not offered at all. `isOpenable` in main
   * refuses them too, and that is the boundary that matters for safety — this
   * is the second layer, and the reason the pane does not underline something
   * that a click would then silently decline to open.
   */
  it.each(['file:///etc/passwd', 'ftp://example.com', 'javascript:alert(1)', 'data:text/html,x'])(
    'ignores %s',
    (line) => {
      expect(findLinks(line)).toEqual([])
    },
  )

  it('ignores a scheme that merely ends in http', () => {
    expect(findLinks('nothttp://example.com')).toEqual([])
  })
})

describe('followsLink', () => {
  it('follows a plain ⌘-click', () => {
    expect(followsLink({ metaKey: true, altKey: false, ctrlKey: false, shiftKey: false })).toBe(true)
  })

  // Without ⌘ the click belongs to the pane: it is how selection works, and a
  // program behind the pty may be reading mouse events itself.
  it('does not follow a click with no modifier', () => {
    expect(followsLink({ metaKey: false, altKey: false, ctrlKey: false, shiftKey: false })).toBe(
      false,
    )
  })

  it.each([
    ['alt', { metaKey: true, altKey: true, ctrlKey: false, shiftKey: false }],
    ['ctrl', { metaKey: true, altKey: false, ctrlKey: true, shiftKey: false }],
    ['shift', { metaKey: true, altKey: false, ctrlKey: false, shiftKey: true }],
  ])('does not follow ⌘ combined with %s', (_name, modifiers) => {
    expect(followsLink(modifiers)).toBe(false)
  })
})

describe('linkRange', () => {
  /*
   * Asserted against a concrete line rather than as bare arithmetic, so the
   * numbers are checked against the characters they are supposed to cover.
   * 'see https://example.com now' puts the url at offsets 4..23, which is
   * columns 5..23 once x is 1-based and inclusive at both ends.
   */
  it('converts half-open 0-based offsets to inclusive 1-based columns', () => {
    const [link] = findLinks('see https://example.com now')
    expect(linkRange(link, 7)).toEqual({ start: { x: 5, y: 7 }, end: { x: 23, y: 7 } })
  })

  it('covers exactly as many columns as the url has characters', () => {
    const [link] = findLinks('x https://ab.co')
    const range = linkRange(link, 1)
    expect(range.end.x - range.start.x + 1).toBe('https://ab.co'.length)
  })

  it('starts at column 1 for a url at the start of the line', () => {
    const [link] = findLinks('https://example.com')
    expect(linkRange(link, 3).start).toEqual({ x: 1, y: 3 })
  })
})
