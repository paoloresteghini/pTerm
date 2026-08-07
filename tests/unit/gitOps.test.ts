import { describe, expect, it } from 'vitest'
import { safePaths } from '../../src/main/git/ops'

describe('safePaths', () => {
  it('keeps a plain repo-relative path', () => {
    expect(safePaths('/repo', ['src/a.ts'])).toEqual(['src/a.ts'])
  })

  it('drops a path that climbs out of the repository', () => {
    expect(safePaths('/repo', ['../outside.ts'])).toEqual([])
  })

  it('drops an absolute path', () => {
    expect(safePaths('/repo', ['/etc/passwd'])).toEqual([])
  })

  // `/repo` must not be read as a prefix of `/repository`.
  it('drops a sibling whose name starts with the root', () => {
    expect(safePaths('/repo', ['../repository/a.ts'])).toEqual([])
  })

  it('drops a path that climbs out and back in', () => {
    expect(safePaths('/repo', ['src/../../repo2/a.ts'])).toEqual([])
  })

  it('keeps a path that climbs and returns inside', () => {
    expect(safePaths('/repo', ['src/../a.ts'])).toEqual(['a.ts'])
  })

  it('drops an empty path', () => {
    expect(safePaths('/repo', [''])).toEqual([])
  })
})
