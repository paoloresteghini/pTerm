import { describe, it, expect } from 'vitest'
import { isMarkdownPath, languageIdForPath } from '../../src/renderer/lib/languageForPath'

describe('languageIdForPath', () => {
  it('names javascript for the js and ts family', () => {
    for (const path of ['a.js', 'a.jsx', 'a.ts', 'a.tsx', 'a.mjs', 'a.cjs']) {
      expect(languageIdForPath(path)).toBe('javascript')
    }
  })

  it('names markdown for md', () => {
    expect(languageIdForPath('README.md')).toBe('markdown')
    expect(languageIdForPath('docs/a.markdown')).toBe('markdown')
  })

  // Everything else is plain text rather than a guess. A wrong grammar is
  // worse than none: it colours a file confidently and incorrectly.
  it('names none for anything else', () => {
    for (const path of ['a.rs', 'a.py', 'Makefile', 'a', 'a.', '.env']) {
      expect(languageIdForPath(path)).toBe(null)
    }
  })

  // The extension is the last dot's suffix, not the first: a file called
  // `component.test.ts` is TypeScript.
  it('reads the last extension, not the first', () => {
    expect(languageIdForPath('component.test.ts')).toBe('javascript')
    expect(languageIdForPath('notes.md.bak')).toBe(null)
  })

  it('is case insensitive', () => {
    expect(languageIdForPath('README.MD')).toBe('markdown')
    expect(languageIdForPath('A.TS')).toBe('javascript')
  })

  /**
   * The `dot <= 0` guard, and the only input in this file that covers it.
   *
   * A name that is NOTHING but a known extension is not a file with that
   * extension. `.ts` is a dotfile called `ts`, exactly as `.env` is one called
   * `env`, and neither has a suffix at all.
   *
   * **Measured 2026-08-05 by deleting the guard.** Every other case in this
   * file answers identically without it, `.env` and `.eslintrc.js` included:
   * `.env` falls through to `null` anyway because `env` is not a known
   * extension, and `.eslintrc.js` never reaches the guard because its last dot
   * is not the leading one. `.ts` is the one input that changes answer, from
   * `null` to `'javascript'`. Without this assertion the guard could be
   * deleted and the suite would stay green, which is what a review found.
   */
  it('reads a lone leading dot as the name, not as an extension', () => {
    expect(languageIdForPath('.ts')).toBe(null)
    expect(languageIdForPath('.md')).toBe(null)
    // The other half of what `dot <= 0` means, and the half the guard is easy
    // to misread as forbidding: a dotfile with a SECOND dot does have an
    // extension. This one passes with or without the guard.
    expect(languageIdForPath('.eslintrc.js')).toBe('javascript')
  })

  // The name is taken after the last slash, so a directory called `src.ts`
  // holding a plain file does not colour it. Not in the brief; it is the
  // reason `lastIndexOf('/')` is there and nothing else measured it.
  it('ignores dots in the directories above the file', () => {
    expect(languageIdForPath('src.ts/Makefile')).toBe(null)
    expect(languageIdForPath('a.md/b.ts')).toBe('javascript')
  })
})

/**
 * `isMarkdownPath` decides whether a pane opens rendered or as source.
 *
 * It is here rather than in a file of its own because it must never disagree
 * with `languageIdForPath` about what markdown is: one answer colours the
 * source, the other decides whether the source is shown at all, and a file
 * that highlights as markdown but refuses to preview (or the reverse) is a
 * defect with no sensible explanation for the user.
 */
describe('isMarkdownPath', () => {
  it('accepts the extensions markdown source is highlighted for', () => {
    expect(isMarkdownPath('README.md')).toBe(true)
    expect(isMarkdownPath('docs/a.markdown')).toBe(true)
    expect(isMarkdownPath('README.MD')).toBe(true)
  })

  it('refuses anything that is not one of them', () => {
    for (const path of ['a.ts', 'a.mdx', 'Makefile', 'notes.md.bak', '.md']) {
      expect(isMarkdownPath(path)).toBe(false)
    }
  })

  /**
   * The anti-divergence assertion, and the reason this block is worth having
   * beyond the two above.
   *
   * Both cases would still pass if `isMarkdownPath` grew an extension list of
   * its own that drifted from `languageIdForPath`'s. This one compares the two
   * answers directly across a mixed fixture, so a second list that admits (or
   * drops) an extension fails here even when both functions look right in
   * isolation.
   */
  it('agrees with the grammar on every path', () => {
    for (const path of [
      'README.md',
      'a.markdown',
      'A.MD',
      'a.mdx',
      'a.ts',
      'a.js',
      '.md',
      'notes.md.bak',
      'Makefile',
      'a.md/b.ts',
    ]) {
      expect(isMarkdownPath(path)).toBe(languageIdForPath(path) === 'markdown')
    }
  })
})
