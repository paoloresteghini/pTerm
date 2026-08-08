/**
 * Reading `git ls-files -z` output, and capping it.
 *
 * The parser is separate from the spawn so it can be fed the exact bytes git
 * emits, including the two that a line-based reader gets wrong: the NUL
 * separator, and a filename containing a newline. Both are real — git offers
 * `-z` precisely because paths may contain anything but NUL.
 */
import { describe, it, expect } from 'vitest'
import { parseLsFiles, capPaths, MAX_FILES } from '../../src/main/files/projectFiles'

describe('parseLsFiles', () => {
  it('splits on NUL', () => {
    expect(parseLsFiles('a.ts\0src/b.ts\0')).toEqual(['a.ts', 'src/b.ts'])
  })

  // git emits a trailing NUL after the last entry, so a naive split leaves an
  // empty string that would render as a blank row in the palette.
  it('drops the empty entry the trailing NUL leaves', () => {
    expect(parseLsFiles('only.ts\0')).toEqual(['only.ts'])
    expect(parseLsFiles('')).toEqual([])
  })

  /*
   * The reason `-z` is used at all. A filename with a newline in it is legal
   * on every filesystem this app runs on, and a line-based reader turns one
   * path into two, both of which then fail to open.
   */
  it('keeps a filename containing a newline as one path', () => {
    expect(parseLsFiles('we\nird.ts\0next.ts\0')).toEqual(['we\nird.ts', 'next.ts'])
  })

  it('keeps paths with spaces and quotes intact', () => {
    expect(parseLsFiles("My Notes/a b.md\0it's.ts\0")).toEqual(['My Notes/a b.md', "it's.ts"])
  })

  // `-z` also turns off git's quoting of unusual paths, so what arrives is the
  // literal name and must not be unescaped a second time.
  it('does not unescape backslashes', () => {
    expect(parseLsFiles('a\\tb.ts\0')).toEqual(['a\\tb.ts'])
  })
})

describe('capPaths', () => {
  it('passes a short list through untruncated', () => {
    expect(capPaths(['a', 'b'])).toEqual({ files: ['a', 'b'], truncated: false })
  })

  /*
   * Reported rather than silent. A monorepo over the cap should look like a
   * palette that is missing files, not like a project that does not contain
   * them.
   */
  it('reports truncation when there are more than the cap', () => {
    const many = Array.from({ length: MAX_FILES + 5 }, (_, i) => `f${i}.ts`)
    const result = capPaths(many)
    expect(result.files).toHaveLength(MAX_FILES)
    expect(result.truncated).toBe(true)
  })

  it('does not report truncation at exactly the cap', () => {
    const exact = Array.from({ length: MAX_FILES }, (_, i) => `f${i}.ts`)
    expect(capPaths(exact).truncated).toBe(false)
  })
})
