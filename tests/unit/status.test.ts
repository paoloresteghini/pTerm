import { describe, it, expect } from 'vitest'
import { SEVERITY, worst, type TabState } from '../../src/shared/status'

describe('worst', () => {
  it('returns null for no states, so an empty project draws no dot', () => {
    expect(worst([])).toBeNull()
  })

  it('picks the more severe of two', () => {
    expect(worst(['idle', 'waiting'])).toBe('waiting')
    expect(worst(['waiting', 'crashed'])).toBe('crashed')
  })

  it('is order-independent', () => {
    expect(worst(['crashed', 'idle', 'thinking'])).toBe('crashed')
    expect(worst(['thinking', 'idle', 'crashed'])).toBe('crashed')
  })

  // The whole point of the order: a project row exists to tell you whether
  // anything under it needs a human, and `waiting` is the only state that
  // means that. It must beat every state except an outright crash.
  it('ranks waiting above everything but crashed', () => {
    for (const state of SEVERITY) {
      if (state === 'crashed' || state === 'waiting') continue
      expect(worst([state, 'waiting'])).toBe('waiting')
    }
  })

  it('ranks a finished tab below a live idle one, and unknown last of all', () => {
    expect(worst(['ended', 'idle'])).toBe('idle')
    expect(worst(['unknown', 'ended'])).toBe('ended')
  })

  // A state missing from SEVERITY would silently never win, so a dot would
  // quietly show the wrong thing rather than failing loudly.
  it('ranks every state in the union', () => {
    const all: TabState[] = [
      'crashed',
      'waiting',
      'thinking',
      'running',
      'idle',
      'ended',
      'unknown',
    ]
    expect([...SEVERITY].sort()).toEqual([...all].sort())
  })
})
