import { describe, it, expect } from 'vitest'
import { isRealLoadFailure } from '../../src/renderer/BrowserPane'

describe('isRealLoadFailure', () => {
  it('ignores ABORTED, which fires on ordinary redirects', () => {
    expect(isRealLoadFailure(-3)).toBe(false)
  })

  it('reports a name that did not resolve', () => {
    expect(isRealLoadFailure(-105)).toBe(true)
  })

  it('reports a refused connection, which is a dev server that is not running', () => {
    expect(isRealLoadFailure(-102)).toBe(true)
  })
})
