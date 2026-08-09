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

  it('keeps a GitHub Enterprise Cloud host', () => {
    expect(parseRemote('git@enterprise.github.com:team/thing.git')).toEqual({
      host: 'enterprise.github.com',
      owner: 'team',
      name: 'thing',
    })
  })

  it('rejects a spoofed-prefix host', () => {
    expect(parseRemote('git@github.com.attacker.net:owner/name.git')).toBeNull()
  })

  it('rejects a similar-prefix host', () => {
    expect(parseRemote('https://github.evil.net/owner/name.git')).toBeNull()
  })

  it('rejects a URL with extra path segments', () => {
    expect(parseRemote('https://github.com/owner/repo/blob/main/file.ts')).toBeNull()
  })

  it('accepts case-insensitive hosts', () => {
    expect(parseRemote('git@GITHUB.COM:owner/name.git')).toEqual({
      host: 'GITHUB.COM',
      owner: 'owner',
      name: 'name',
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
