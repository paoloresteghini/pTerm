import { describe, it, expect } from 'vitest'
import { regionOf, type TabType } from '../../src/shared/ipc'

const pane = (type: TabType) => ({ type })

describe('regionOf', () => {
  it('puts a browser pane in the browser region', () => {
    expect(regionOf(pane('browser'))).toBe('browser')
  })

  // The three kinds that stay put. Editor and diff are sessionless too, so a
  // predicate written against `canHaveSession` rather than against the kind
  // would move them, which is the one thing this design does not do.
  it('leaves every other kind in the terminal region', () => {
    for (const type of ['claude', 'preset', 'shell', 'editor', 'diff'] as TabType[]) {
      expect(regionOf(pane(type))).toBe('terminal')
    }
  })
})
