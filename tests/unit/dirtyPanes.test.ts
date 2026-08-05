import { describe, it, expect } from 'vitest'
import { markDirty, forgetPane } from '../../src/renderer/lib/dirtyPanes'

describe('markDirty', () => {
  it('records a pane as dirty', () => {
    expect(markDirty({}, 'p1', true)).toEqual({ p1: true })
  })

  // Clean is absence, not `false`. One representation of "not dirty", for the
  // reason `PANE_COLOR_DEFAULT` gives about one spelling on disk: the dot and
  // any future reader of this map must not disagree about which of two
  // spellings means clean.
  it('removes a pane rather than storing false', () => {
    expect(markDirty({ p1: true }, 'p1', false)).toEqual({})
  })

  // Referential identity matters: this map is React state, and a new object
  // for an unchanged value re-renders the whole tab bar on every keystroke.
  it('returns the same object when nothing changes', () => {
    const was = { p1: true }
    expect(markDirty(was, 'p1', true)).toBe(was)
    const clean = {}
    expect(markDirty(clean, 'p1', false)).toBe(clean)
  })
})

describe('forgetPane', () => {
  it('drops a closed pane', () => {
    expect(forgetPane({ p1: true, p2: true }, 'p1')).toEqual({ p2: true })
  })

  // A pane that was never dirty is closed constantly. Same identity rule.
  it('returns the same object when the pane was not in it', () => {
    const was = { p1: true }
    expect(forgetPane(was, 'p2')).toBe(was)
  })
})
