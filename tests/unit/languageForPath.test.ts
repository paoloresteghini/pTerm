import { describe, it, expect } from 'vitest'
import { languageIdForPath } from '../../src/renderer/lib/languageForPath'

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

  // A dotfile whose LAST dot has a known suffix is still that language: the
  // `dot <= 0` guard is about a name with no extension at all, not about a
  // name that begins with a dot. Not in the brief; added because that guard
  // reads as though it rejects every dotfile, and this is the case that says
  // it does not.
  it('reads an extension on a dotfile', () => {
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
