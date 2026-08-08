import { describe, it, expect } from 'vitest'
import {
  WEBGL_PANE_BUDGET_DEFAULT,
  leastRecentlyUsed,
  webglPaneBudget,
} from '../../src/renderer/lib/webglBudget'

/**
 * The two pure decisions behind the WebGL budget: which pane loses its context
 * when the budget is full, and how big the budget is.
 *
 * Attaching and disposing the addon itself is not testable here —
 * `vitest.config.mts` runs in `environment: 'node'`, where there is no canvas
 * and no WebGL — so that half is covered by `tests/e2e/webgl.spec.ts`, which
 * drives a real app with the budget turned down to two.
 */

describe('leastRecentlyUsed', () => {
  it('names the holder with the smallest use counter', () => {
    const lastUsed = new Map([
      ['a', 7],
      ['b', 2],
      ['c', 9],
    ])
    expect(leastRecentlyUsed(['a', 'b', 'c'], lastUsed)).toBe('b')
  })

  it('answers null for no holders, so a caller cannot evict nothing', () => {
    expect(leastRecentlyUsed([], new Map())).toBeNull()
  })

  it('treats a holder nobody has touched as the oldest of all', () => {
    // Reachable when a pane is recorded as holding a context before anything
    // has marked it used. A context nobody has ever used is the cheapest one
    // to take, so it must lose to a pane with any counter at all — including
    // the smallest one a counter can hold.
    const lastUsed = new Map([['known', 0]])
    expect(leastRecentlyUsed(['known', 'never-touched'], lastUsed)).toBe('never-touched')
  })

  it('breaks a tie on the order it was given, so the same inputs name the same victim', () => {
    const lastUsed = new Map([
      ['a', 4],
      ['b', 4],
    ])
    expect(leastRecentlyUsed(['a', 'b'], lastUsed)).toBe('a')
    expect(leastRecentlyUsed(['b', 'a'], lastUsed)).toBe('b')
  })

  it('ignores a counter for a pane that is not a holder', () => {
    // The caller passes only the panes actually holding a context; a stale
    // entry for a pane that has already given one up must not be able to win.
    const lastUsed = new Map([
      ['gone', 1],
      ['a', 5],
      ['b', 8],
    ])
    expect(leastRecentlyUsed(['a', 'b'], lastUsed)).toBe('a')
  })
})

describe('webglPaneBudget', () => {
  it('uses the default when the variable is unset', () => {
    expect(webglPaneBudget(undefined)).toBe(WEBGL_PANE_BUDGET_DEFAULT)
  })

  it('sits below the sixteen live contexts Chromium allows', () => {
    // Measured 2026-08-08 in this app's own Electron: 40 contexts created,
    // exactly 16 alive. A budget at or above that hands the eviction decision
    // back to Chromium, which chooses by paint activity rather than by use.
    expect(WEBGL_PANE_BUDGET_DEFAULT).toBeLessThan(16)
  })

  it('takes a number from the variable', () => {
    expect(webglPaneBudget('2')).toBe(2)
    expect(webglPaneBudget('30')).toBe(30)
  })

  it('falls back rather than leaving no pane a renderer', () => {
    expect(webglPaneBudget('0')).toBe(WEBGL_PANE_BUDGET_DEFAULT)
    expect(webglPaneBudget('-3')).toBe(WEBGL_PANE_BUDGET_DEFAULT)
    expect(webglPaneBudget('lots')).toBe(WEBGL_PANE_BUDGET_DEFAULT)
    expect(webglPaneBudget('')).toBe(WEBGL_PANE_BUDGET_DEFAULT)
  })
})
