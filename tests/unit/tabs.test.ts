import { describe, it, expect } from 'vitest'
import {
  INITIAL_TABS_STATE,
  tabsReducer,
  neighbourOf,
  type TabsState,
} from '../../src/renderer/tabs'
import type { TabDescriptor } from '../../src/shared/ipc'

function tab(id: string): TabDescriptor {
  return {
    id,
    projectSlug: 'lumio',
    cwd: '/Users/paolo/Code/Lumio',
    tmuxSession: `prcli-lumio-${id}`,
  }
}

const three: TabsState = {
  tabs: [tab('aaa'), tab('bbb'), tab('ccc')],
  activeId: 'bbb',
}

describe('neighbourOf', () => {
  it('prefers the tab to the right', () => {
    expect(neighbourOf(three.tabs, 'aaa')).toBe('bbb')
  })

  it('falls back to the left for the last tab', () => {
    expect(neighbourOf(three.tabs, 'ccc')).toBe('bbb')
  })

  it('returns null when it was the only tab', () => {
    expect(neighbourOf([tab('aaa')], 'aaa')).toBeNull()
  })

  it('returns null for an unknown id', () => {
    expect(neighbourOf(three.tabs, 'zzz')).toBeNull()
  })
})

describe('tabsReducer', () => {
  it('starts empty', () => {
    expect(INITIAL_TABS_STATE).toEqual({ tabs: [], activeId: null })
  })

  it('replaces everything on restore', () => {
    const next = tabsReducer(three, { type: 'restored', tabs: [tab('zzz')], activeId: 'zzz' })
    expect(next).toEqual({ tabs: [tab('zzz')], activeId: 'zzz' })
  })

  it('appends an opened tab and activates it', () => {
    const next = tabsReducer(three, { type: 'opened', tab: tab('ddd') })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'bbb', 'ccc', 'ddd'])
    expect(next.activeId).toBe('ddd')
  })

  it('ignores an opened tab that is already present', () => {
    const next = tabsReducer(three, { type: 'opened', tab: tab('bbb') })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('activates a tab', () => {
    expect(tabsReducer(three, { type: 'activated', id: 'ccc' }).activeId).toBe('ccc')
  })

  it('ignores activation of an unknown tab', () => {
    expect(tabsReducer(three, { type: 'activated', id: 'zzz' }).activeId).toBe('bbb')
  })

  it('removes a tab and moves the active one to its neighbour', () => {
    const next = tabsReducer(three, { type: 'removed', id: 'bbb' })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'ccc'])
    expect(next.activeId).toBe('ccc')
  })

  it('leaves the active tab alone when removing a different one', () => {
    const next = tabsReducer(three, { type: 'removed', id: 'aaa' })
    expect(next.activeId).toBe('bbb')
  })

  it('goes back to nothing active when the last tab is removed', () => {
    const one: TabsState = { tabs: [tab('aaa')], activeId: 'aaa' }
    expect(tabsReducer(one, { type: 'removed', id: 'aaa' })).toEqual({ tabs: [], activeId: null })
  })

  it('ignores removal of an unknown tab', () => {
    expect(tabsReducer(three, { type: 'removed', id: 'zzz' })).toEqual(three)
  })

  it('never mutates the state it is given', () => {
    const before = JSON.stringify(three)
    tabsReducer(three, { type: 'removed', id: 'bbb' })
    tabsReducer(three, { type: 'opened', tab: tab('ddd') })
    expect(JSON.stringify(three)).toBe(before)
  })
})
