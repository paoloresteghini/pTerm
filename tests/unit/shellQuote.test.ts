/**
 * Turning dropped file paths into text a shell will read as one argument each.
 *
 * This carries the whole weight of what a drop types. The step either side of
 * it is not testable from the suite: `webUtils.getPathForFile` returns '' for
 * a `File` minted inside a Playwright page, so no e2e can prove a real path
 * arrives. What a path becomes once we have it is decided here.
 */
import { describe, it, expect } from 'vitest'
import { quoteForShell, dropText } from '../../src/renderer/lib/shellQuote'

describe('quoteForShell', () => {
  // The common case is a plain path, and quoting it would be noise in the
  // command line the user is reading.
  it.each([
    '/Users/paolo/a.txt',
    '/Users/paolo/Code/PRCLI/src/main/index.ts',
    '/tmp/file-with-dashes_and_underscores.md',
    '/tmp/dots.in.name.tar.gz',
    '/tmp/1234',
  ])('leaves %s alone', (path) => {
    expect(quoteForShell(path)).toBe(path)
  })

  it('single-quotes a path with a space', () => {
    expect(quoteForShell('/Users/paolo/My Notes/a.md')).toBe("'/Users/paolo/My Notes/a.md'")
  })

  /*
   * Each of these is a character the shell acts on. They are asserted one at a
   * time rather than as a single kitchen-sink path so a rule that stops
   * covering one of them fails on that character by name.
   */
  it.each(['$', '`', '"', '\\', '*', '?', '[', ']', '(', ')', '{', '}', ';', '&', '|', '<', '>', '#', '~', '!', '\t'])(
    'single-quotes a path containing %j',
    (char) => {
      const path = `/tmp/a${char}b`
      expect(quoteForShell(path)).toBe(`'${path}'`)
    },
  )

  /*
   * A single quote cannot appear inside single quotes at all, so the string is
   * closed, an escaped quote is emitted, and it is reopened. This is the one
   * rule that produces something a reader would not guess.
   */
  it("closes, escapes and reopens around an embedded single quote", () => {
    expect(quoteForShell("/tmp/it's here.txt")).toBe("'/tmp/it'\\''s here.txt'")
  })

  it('quotes an empty string rather than vanishing', () => {
    expect(quoteForShell('')).toBe("''")
  })

  it('quotes a newline, which would otherwise submit the line', () => {
    expect(quoteForShell('/tmp/a\nb')).toBe("'/tmp/a\nb'")
  })
})

describe('dropText', () => {
  it('joins several paths with one space', () => {
    expect(dropText(['/tmp/a.txt', '/tmp/b.txt'])).toBe('/tmp/a.txt /tmp/b.txt')
  })

  it('quotes only the paths that need it', () => {
    expect(dropText(['/tmp/a.txt', '/tmp/My Notes/b.md'])).toBe("/tmp/a.txt '/tmp/My Notes/b.md'")
  })

  it('handles a single path', () => {
    expect(dropText(['/tmp/a.txt'])).toBe('/tmp/a.txt')
  })

  /*
   * Nothing typed at all for an empty drop. A drop that yielded no paths is
   * what a directory drag or a non-file drag looks like, and typing a stray
   * space into a half-written command would be worse than doing nothing.
   */
  it('types nothing when there are no paths', () => {
    expect(dropText([])).toBe('')
  })

  // `webUtils.getPathForFile` answers '' for anything it cannot resolve, which
  // is every File a test page mints. An empty entry must be dropped rather
  // than quoted into a stray '' argument.
  it('ignores paths that could not be resolved', () => {
    expect(dropText(['', '/tmp/b.txt', ''])).toBe('/tmp/b.txt')
    expect(dropText(['', ''])).toBe('')
  })

  // No trailing Return, and nothing that could act as one: the text is typed
  // into a line the user may be halfway through.
  it('never ends with a newline', () => {
    expect(dropText(['/tmp/a.txt', '/tmp/b.txt'])).not.toMatch(/[\r\n]$/)
  })
})
