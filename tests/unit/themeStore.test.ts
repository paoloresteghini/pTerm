import { describe, it, expect } from 'vitest'
import { migrate } from '../../src/main/state/store'

/**
 * The stored theme, read defensively.
 *
 * config.json is a text file. A hand-edited id that is not one of the five
 * must land on the default rather than reaching `applyTheme` and leaving the
 * window painted in nothing, which is the same tolerance every other field in
 * this file already has.
 */

describe('reading the theme out of a config file', () => {
  it('takes a recognised id', () => {
    expect(migrate({ version: 9, theme: 'stepped' }).theme).toBe('stepped')
  })

  it('defaults a v8 file, which had no theme field', () => {
    expect(migrate({ version: 8 }).theme).toBe('classic')
  })

  it('defaults a v1 file too', () => {
    expect(migrate({ version: 1 }).theme).toBe('classic')
  })

  it('defaults an unrecognised id rather than passing it through', () => {
    expect(migrate({ version: 9, theme: 'purple' }).theme).toBe('classic')
    expect(migrate({ version: 9, theme: 7 }).theme).toBe('classic')
    expect(migrate({ version: 9, theme: null }).theme).toBe('classic')
  })

  it('writes version 9', () => {
    expect(migrate({ version: 8 }).version).toBe(9)
    expect(migrate({ version: 9, theme: 'slate' }).version).toBe(9)
  })
})
