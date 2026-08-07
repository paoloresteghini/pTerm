import { describe, it, expect } from 'vitest'
import { SETTINGS_TABS, nextTabIndex } from '../../src/renderer/settings/tabs'

describe('SETTINGS_TABS', () => {
  // The order is a decision, not an accident: Notifications is first because
  // it is the only tab a user changes more than once, and the settings pane
  // opens on the first tab. Task 3's e2e spec presses ArrowRight from
  // Notifications and expects Hooks, which is this order.
  it('runs Notifications, Hooks, Shell history, Updates', () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      'notifications',
      'hooks',
      'shell-history',
      'updates',
    ])
  })

  // The ids become `data-testid="settings-tab-<id>"` and the `aria-controls`
  // of the panel, so a duplicate would give two elements one name and make
  // Playwright's strict-mode locator fail on whichever spec got there first.
  it('gives every tab a distinct id and a label', () => {
    expect(new Set(SETTINGS_TABS.map((tab) => tab.id)).size).toBe(SETTINGS_TABS.length)
    for (const tab of SETTINGS_TABS) expect(tab.label.length).toBeGreaterThan(0)
  })
})

describe('nextTabIndex', () => {
  it('moves right', () => {
    expect(nextTabIndex(0, 'ArrowRight', 4)).toBe(1)
  })

  it('moves left', () => {
    expect(nextTabIndex(2, 'ArrowLeft', 4)).toBe(1)
  })

  // Wrapping at both ends, because a roving tablist that stops dead at the
  // last tab reads as broken to anyone who navigates by keyboard.
  it('wraps past the last tab to the first', () => {
    expect(nextTabIndex(3, 'ArrowRight', 4)).toBe(0)
  })

  it('wraps before the first tab to the last', () => {
    expect(nextTabIndex(0, 'ArrowLeft', 4)).toBe(3)
  })

  // The caller passes every keydown it receives, so anything that is not an
  // arrow has to be a no-op rather than a move. Index 2 rather than 0: with
  // an index of 0, a buggy implementation that always returned 0 would pass.
  it('returns the same index for any other key', () => {
    expect(nextTabIndex(2, 'Enter', 4)).toBe(2)
    expect(nextTabIndex(2, 'a', 4)).toBe(2)
    expect(nextTabIndex(2, 'ArrowDown', 4)).toBe(2)
  })

  // Guards the modulo: `% 0` is NaN, which would put NaN into a tabIndex.
  it('returns the same index when there are no tabs', () => {
    expect(nextTabIndex(0, 'ArrowRight', 0)).toBe(0)
  })
})
