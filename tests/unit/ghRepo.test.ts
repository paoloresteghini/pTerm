import { describe, expect, it } from 'vitest'
import { parseRemote, repoArg } from '../../src/main/gh/repo'

describe('parseRemote', () => {
  it('reads the scp-like SSH form', () => {
    expect(parseRemote('git@github.com:paoloresteghini/PRCLI.git')).toEqual({
      host: 'github.com',
      owner: 'paoloresteghini',
      name: 'PRCLI',
    })
  })

  it('reads the HTTPS form', () => {
    expect(parseRemote('https://github.com/paoloresteghini/PRCLI.git')).toEqual({
      host: 'github.com',
      owner: 'paoloresteghini',
      name: 'PRCLI',
    })
  })

  it('reads the ssh:// form', () => {
    expect(parseRemote('ssh://git@github.com/paoloresteghini/PRCLI')).toEqual({
      host: 'github.com',
      owner: 'paoloresteghini',
      name: 'PRCLI',
    })
  })

  it('tolerates a missing .git suffix and a trailing slash and newline', () => {
    expect(parseRemote('https://github.com/o/n/\n')).toEqual({
      host: 'github.com',
      owner: 'o',
      name: 'n',
    })
  })

  it('keeps an Enterprise host', () => {
    expect(parseRemote('git@github.corp.example:team/thing.git')).toEqual({
      host: 'github.corp.example',
      owner: 'team',
      name: 'thing',
    })
  })

  it('rejects a non-GitHub host', () => {
    expect(parseRemote('git@gitlab.com:o/n.git')).toBeNull()
  })

  it('rejects a local path with no host', () => {
    expect(parseRemote('/Users/paolo/Code/PRCLI')).toBeNull()
  })

  it('rejects a URL with no owner segment', () => {
    expect(parseRemote('https://github.com/onlyone')).toBeNull()
  })

  it('rejects empty input', () => {
    expect(parseRemote('')).toBeNull()
  })
})

describe('repoArg', () => {
  it('omits github.com', () => {
    expect(repoArg({ host: 'github.com', owner: 'o', name: 'n' })).toBe('o/n')
  })

  it('keeps an Enterprise host', () => {
    expect(repoArg({ host: 'gh.corp', owner: 'o', name: 'n' })).toBe('gh.corp/o/n')
  })
})
