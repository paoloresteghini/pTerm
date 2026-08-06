import { describe, it, expect } from 'vitest'
import { compareVersions, parseRelease, parseVersion } from '../../src/main/update/check'

describe('parseVersion', () => {
  it('reads a plain three-part version', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
  })

  it('tolerates the v prefix a git tag carries', () => {
    expect(parseVersion('v0.1.0')).toEqual([0, 1, 0])
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseVersion('  v2.0.1 ')).toEqual([2, 0, 1])
  })

  it('reads multi-digit fields as numbers, not characters', () => {
    expect(parseVersion('1.10.0')).toEqual([1, 10, 0])
  })

  // A prerelease is not an update this app offers. GitHub's releases/latest
  // does not return one, so this is the belt to that braces.
  it('refuses a prerelease tag', () => {
    expect(parseVersion('1.0.0-beta.1')).toBeNull()
  })

  it('refuses a two-part version', () => {
    expect(parseVersion('1.2')).toBeNull()
  })

  it('refuses a non-numeric field', () => {
    expect(parseVersion('1.x.0')).toBeNull()
  })

  it('refuses an empty string', () => {
    expect(parseVersion('')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by major first', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
  })

  it('orders by minor when majors match', () => {
    expect(compareVersions('1.2.0', '1.10.0')).toBe(-1)
  })

  it('orders by patch when major and minor match', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
  })

  it('reports equality', () => {
    expect(compareVersions('1.2.3', 'v1.2.3')).toBe(0)
  })

  // The whole point of the null return: an unparseable tag is "no answer",
  // never "newer". A boolean-returning compare would have to pick one, and
  // picking "newer" offers a download that does not exist.
  it('answers null when either side is unparseable', () => {
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBeNull()
    expect(compareVersions('1.0.0', 'garbage')).toBeNull()
  })
})

describe('parseRelease', () => {
  const payload = {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/paoloresteghini/PRCLI/releases/tag/v0.2.0',
    // Fields the app deliberately ignores, present so the test proves it
    // reads only the two it names.
    assets: [{ browser_download_url: 'https://example.invalid/a.zip' }],
    body: 'notes',
  }

  it('takes the version and the release page url', () => {
    expect(parseRelease(payload)).toEqual({
      version: '0.2.0',
      url: 'https://github.com/paoloresteghini/PRCLI/releases/tag/v0.2.0',
    })
  })

  it('normalises the tag, dropping the v', () => {
    expect(parseRelease({ ...payload, tag_name: 'v10.0.1' })?.version).toBe('10.0.1')
  })

  it('refuses a payload with no tag', () => {
    expect(parseRelease({ html_url: 'https://example.invalid' })).toBeNull()
  })

  it('refuses a payload with no url', () => {
    expect(parseRelease({ tag_name: 'v1.0.0' })).toBeNull()
  })

  it('refuses a payload whose tag is not a release version', () => {
    expect(parseRelease({ ...payload, tag_name: 'nightly' })).toBeNull()
  })

  // GitHub answers a rate limit with a 200-shaped JSON object carrying a
  // `message` and no release fields. That must read as "no release", not throw.
  it('refuses a rate-limit body', () => {
    expect(parseRelease({ message: 'API rate limit exceeded' })).toBeNull()
  })

  it('refuses a non-object', () => {
    expect(parseRelease(null)).toBeNull()
    expect(parseRelease('a string')).toBeNull()
    expect(parseRelease(42)).toBeNull()
  })

  // `html_url` crosses IPC and is meant for `shell.openExternal`, which will
  // hand a `file:` or custom-scheme URL to whatever app claims it. The scheme
  // is checked here, at the point the value enters the app, rather than left
  // to whatever eventually calls openExternal.
  it('accepts a normal https release url', () => {
    expect(parseRelease(payload)?.url).toBe(payload.html_url)
  })

  it('refuses a plain http url', () => {
    expect(parseRelease({ ...payload, html_url: 'http://github.com/paoloresteghini/PRCLI' })).toBeNull()
  })

  it('refuses a file url', () => {
    expect(parseRelease({ ...payload, html_url: 'file:///Applications/Calculator.app' })).toBeNull()
  })

  it('refuses a custom-scheme url', () => {
    expect(parseRelease({ ...payload, html_url: 'vscode://file/etc/passwd' })).toBeNull()
  })

  it('refuses a string that is not a url at all', () => {
    expect(parseRelease({ ...payload, html_url: 'not a url' })).toBeNull()
  })
})
