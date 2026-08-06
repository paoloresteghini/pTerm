import { describe, it, expect } from 'vitest'
import { isOpenable } from '../../src/main/update/openable'

describe('isOpenable', () => {
  it('allows the release page', () => {
    expect(isOpenable('https://github.com/paoloresteghini/PRCLI/releases/tag/v0.2.0')).toBe(true)
  })

  it('allows plain http', () => {
    expect(isOpenable('http://example.invalid/notes')).toBe(true)
  })

  // The reason this function exists: the URL arrives from a network feed, and
  // shell.openExternal hands a file: URL to Finder without asking.
  it('refuses file:', () => {
    expect(isOpenable('file:///Applications/Calculator.app')).toBe(false)
  })

  it('refuses a custom scheme another app may have claimed', () => {
    expect(isOpenable('vscode://file/etc/passwd')).toBe(false)
  })

  it('refuses javascript:', () => {
    expect(isOpenable('javascript:alert(1)')).toBe(false)
  })

  it('refuses a string that is not a URL at all', () => {
    expect(isOpenable('not a url')).toBe(false)
    expect(isOpenable('')).toBe(false)
  })
})
