/**
 * Ranking file paths for the palette.
 *
 * A path is not a name, and `scoreEntry` alone gets it wrong in the way that
 * matters most: typing `app` should offer `App.tsx` before
 * `src/app/nested/other.ts`, because the thing you name is almost always the
 * file rather than a directory on the way to it.
 */
import { describe, it, expect } from 'vitest'
import { rankFiles } from '../../src/renderer/lib/match'

const paths = (query: string, files: string[]): string[] => rankFiles(query, files).map((f) => f.path)

describe('rankFiles', () => {
  it('puts a basename match ahead of a directory match', () => {
    const ranked = paths('app', ['src/app/nested/other.ts', 'App.tsx'])
    expect(ranked[0]).toBe('App.tsx')
  })

  it('still returns the directory match, ranked lower', () => {
    expect(paths('app', ['src/app/nested/other.ts', 'App.tsx'])).toContain(
      'src/app/nested/other.ts',
    )
  })

  it('matches against the whole path, so a directory can be typed', () => {
    const ranked = paths('nested', ['src/app/nested/other.ts', 'App.tsx'])
    expect(ranked).toEqual(['src/app/nested/other.ts'])
  })

  it('drops paths that do not match at all', () => {
    expect(paths('zzz', ['App.tsx', 'src/main.ts'])).toEqual([])
  })

  // The palette renders unfiltered on an empty query, the way the skills panel
  // does, so the empty case must not be a special kind of empty.
  it('returns everything for an empty query', () => {
    expect(paths('', ['b.ts', 'a.ts'])).toHaveLength(2)
  })

  it('orders an empty query by path, so the list is stable', () => {
    expect(paths('', ['b.ts', 'a.ts'])).toEqual(['a.ts', 'b.ts'])
  })

  /*
   * Two files of the same name in different directories are ordinary in a
   * monorepo (`index.ts` everywhere). Both must survive ranking, and the order
   * between them must be total rather than dependent on input order, or the
   * list reshuffles between keystrokes that did not change the query.
   */
  it('keeps same-named files apart and orders them deterministically', () => {
    const files = ['b/index.ts', 'a/index.ts']
    expect(paths('index', files)).toEqual(paths('index', [...files].reverse()))
    expect(paths('index', files)).toHaveLength(2)
  })

  it('carries the path through as the entry name', () => {
    const [first] = rankFiles('app', ['src/App.tsx'])
    expect(first).toEqual({ path: 'src/App.tsx', name: 'App.tsx' })
  })

  it('is case insensitive', () => {
    expect(paths('APP', ['src/App.tsx'])).toEqual(['src/App.tsx'])
  })
})
