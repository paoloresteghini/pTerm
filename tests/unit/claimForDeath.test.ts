import { describe, it, expect } from 'vitest'
import { claimForDeath } from '../../src/main/ipc/register'

/**
 * `claimForDeath`'s own arithmetic, pinned without a real tmux session near
 * it — the reason it was pulled out of `forgetTab`'s closure, mirroring
 * `carveRatio.test.ts` and `shares.test.ts`.
 *
 * The case this file exists for: no test anywhere before this had TWO tabs
 * with unspent dead-pane claims live at the same time, so the `held.tabId
 * === row.id` filter inside this function was vacuously true everywhere it
 * ran — dropping it entirely would have passed the whole suite. The first
 * test below is the one that closes that gap, and it is A/B'd against
 * exactly that regression.
 */
describe('claimForDeath', () => {
  it('counts only claims recorded against the same tab, not another tab\'s', () => {
    // Two tabs, each with one unspent claim. If the tab-id filter were
    // dropped, tab2's claim would leak into tab1's `taken` and shrink this
    // claim below what it should be.
    const tombstones = new Map([
      ['other-pane', { tabId: 'tab2', share: 0.4 }],
    ])
    const claim = claimForDeath({
      share: 0.3,
      tabId: 'tab1',
      kids: ['a', 'c'],
      tombstones,
    })
    // No claim recorded for tab1, so taken = 0 and the pane's own share
    // passes through untouched.
    expect(claim).toBeCloseTo(0.3)
  })

  it('excludes a claim that has been spent — its pane is back in the row', () => {
    // 'b' died once, was restarted, and a split or a close has already
    // written it back into the row (so it is a kid again). Its old claim
    // must not still discount a fresh death in the same tab.
    const tombstones = new Map([['b', { tabId: 'tab1', share: 0.2 }]])
    const claim = claimForDeath({
      share: 0.3,
      tabId: 'tab1',
      kids: ['a', 'b', 'c'], // 'b' is present: its claim is spent
      tombstones,
    })
    expect(claim).toBeCloseTo(0.3)
  })

  it('passes a share through unchanged for the first death in a tab', () => {
    // With no earlier unspent claim on this tab, `taken` is 0 and `room` is
    // 1: the row's own share already IS the whole-tab fraction, since
    // nothing has yet rescaled it away from one. This is the base case the
    // two-death test below builds on.
    const claim = claimForDeath({
      share: 0.3,
      tabId: 'tab1',
      kids: ['a', 'b', 'c'],
      tombstones: new Map(),
    })
    expect(claim).toBeCloseTo(0.3)
  })

  it('recovers the original share exactly across two deaths in the same tab', () => {
    // A/B/C at 0.5/0.3/0.2. B dies first (unspent, share 0.2 of the whole
    // tab — the single-death case above). The row rescales to A/C at
    // 0.625/0.375. C then dies too, with B's claim still unspent: this must
    // discount B's claim out of C's before converting, recovering C's true
    // 0.3 rather than leaving it at 0.375.
    const tombstones = new Map([['b', { tabId: 'tab1', share: 0.2 }]])
    const claim = claimForDeath({
      share: 0.375,
      tabId: 'tab1',
      kids: ['a', 'c'], // the row as it stood the instant C died
      tombstones,
    })
    expect(claim).toBeCloseTo(0.3)
  })
})
