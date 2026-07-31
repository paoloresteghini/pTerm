import { describe, it, expect } from 'vitest'
import {
  INITIAL_WORKSPACE_STATE,
  workspaceReducer,
  neighbourOf,
  projectIdForTab,
  tabsOfProject,
  activeProject,
  activeTabId,
  type WorkspaceState,
} from '../../src/renderer/workspace'
import { UNSORTED_ID, type ProjectDescriptor, type TabDescriptor } from '../../src/shared/ipc'

function tab(id: string, projectSlug = 'lumio'): TabDescriptor {
  return { id, projectSlug, cwd: '/tmp', tmuxSession: `prcli-${projectSlug}-${id}` }
}

function project(id: string, slug: string, activeTabId: string | null = null): ProjectDescriptor {
  return {
    id,
    name: slug,
    slug,
    cwd: '/tmp',
    presets: [],
    activeTabId,
    available: true,
  }
}

const three: WorkspaceState = {
  projects: [project('p1', 'lumio', 'bbb')],
  tabs: [tab('aaa'), tab('bbb'), tab('ccc')],
  activeProjectId: 'p1',
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

describe('projectIdForTab', () => {
  it('matches on the slug in the session name', () => {
    expect(projectIdForTab(three.projects, tab('aaa', 'lumio'))).toBe('p1')
  })

  it('falls back to Unsorted when no project owns the slug', () => {
    expect(projectIdForTab(three.projects, tab('aaa', 'scratch'))).toBe(UNSORTED_ID)
  })
})

describe('tabsOfProject', () => {
  it('returns only that project\'s tabs', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio'), project('p2', 'gco')],
      tabs: [tab('aaa', 'lumio'), tab('bbb', 'gco'), tab('ccc', 'lumio')],
      activeProjectId: 'p1',
    }
    expect(tabsOfProject(state, 'p1').map((t) => t.id)).toEqual(['aaa', 'ccc'])
  })

  it('collects every unmatched tab under Unsorted', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio')],
      tabs: [tab('aaa', 'lumio'), tab('bbb', 'scratch'), tab('ccc', 'old')],
      activeProjectId: 'p1',
    }
    expect(tabsOfProject(state, UNSORTED_ID).map((t) => t.id)).toEqual(['bbb', 'ccc'])
  })
})

describe('activeProject and activeTabId', () => {
  it('reads the active tab off the active project', () => {
    expect(activeProject(three)?.id).toBe('p1')
    expect(activeTabId(three)).toBe('bbb')
  })

  it('has no active tab when no project is selected', () => {
    expect(activeTabId({ ...three, activeProjectId: null })).toBeNull()
  })
})

describe('workspaceReducer', () => {
  it('starts empty', () => {
    expect(INITIAL_WORKSPACE_STATE).toEqual({ projects: [], tabs: [], activeProjectId: null })
  })

  it('replaces everything on restore', () => {
    const next = workspaceReducer(three, {
      type: 'restored',
      projects: [project('p9', 'gco', 'zzz')],
      tabs: [tab('zzz', 'gco')],
      activeProjectId: 'p9',
    })
    expect(next.tabs.map((t) => t.id)).toEqual(['zzz'])
    expect(next.activeProjectId).toBe('p9')
  })

  it('appends an opened tab and makes it its project\'s active one', () => {
    const next = workspaceReducer(three, { type: 'opened', tab: tab('ddd') })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'bbb', 'ccc', 'ddd'])
    expect(activeTabId(next)).toBe('ddd')
  })

  it('ignores an opened tab that is already present', () => {
    const next = workspaceReducer(three, { type: 'opened', tab: tab('bbb') })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('activates a tab', () => {
    expect(activeTabId(workspaceReducer(three, { type: 'activatedTab', id: 'ccc' }))).toBe('ccc')
  })

  it('ignores activation of an unknown tab', () => {
    expect(activeTabId(workspaceReducer(three, { type: 'activatedTab', id: 'zzz' }))).toBe('bbb')
  })

  it('removes a tab and moves the active one to its neighbour', () => {
    const next = workspaceReducer(three, { type: 'removed', id: 'bbb' })
    expect(next.tabs.map((t) => t.id)).toEqual(['aaa', 'ccc'])
    expect(activeTabId(next)).toBe('ccc')
  })

  it('leaves the active tab alone when removing a different one', () => {
    expect(activeTabId(workspaceReducer(three, { type: 'removed', id: 'aaa' }))).toBe('bbb')
  })

  it('goes back to nothing active when a project\'s last tab is removed', () => {
    const one: WorkspaceState = {
      projects: [project('p1', 'lumio', 'aaa')],
      tabs: [tab('aaa')],
      activeProjectId: 'p1',
    }
    const next = workspaceReducer(one, { type: 'removed', id: 'aaa' })
    expect(next.tabs).toEqual([])
    expect(activeTabId(next)).toBeNull()
  })

  it('ignores removal of an unknown tab', () => {
    expect(workspaceReducer(three, { type: 'removed', id: 'zzz' })).toEqual(three)
  })

  // Removing a tab from one project must not disturb another's selection.
  it('only touches the owning project\'s active tab', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio', 'aaa'), project('p2', 'gco', 'bbb')],
      tabs: [tab('aaa', 'lumio'), tab('bbb', 'gco')],
      activeProjectId: 'p2',
    }
    const next = workspaceReducer(state, { type: 'removed', id: 'aaa' })
    expect(next.projects[1].activeTabId).toBe('bbb')
  })

  it('switches project', () => {
    const state: WorkspaceState = {
      ...three,
      projects: [...three.projects, project('p2', 'gco')],
    }
    expect(workspaceReducer(state, { type: 'activatedProject', id: 'p2' }).activeProjectId).toBe(
      'p2',
    )
  })

  it('ignores activation of an unknown project', () => {
    expect(workspaceReducer(three, { type: 'activatedProject', id: 'nope' }).activeProjectId).toBe(
      'p1',
    )
  })

  it('replaces the project list without disturbing tabs', () => {
    const next = workspaceReducer(three, { type: 'projects', projects: [project('p1', 'lumio')] })
    expect(next.tabs).toEqual(three.tabs)
  })

  it('drops the selection when the selected project disappears', () => {
    const next = workspaceReducer(three, { type: 'projects', projects: [project('p2', 'gco')] })
    expect(next.activeProjectId).toBe('p2')
  })

  it('re-slugs a moved tab in place, keeping its position', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio')],
      tabs: [tab('aaa', 'scratch'), tab('bbb', 'scratch')],
      activeProjectId: 'p1',
    }
    const next = workspaceReducer(state, {
      type: 'movedTab',
      tab: tab('aaa', 'lumio'),
      projects: state.projects,
    })
    expect(next.tabs.map((t) => t.projectSlug)).toEqual(['lumio', 'scratch'])
  })

  // Filing the last stray empties Unsorted, so the reply omits it — and the
  // selection pointing at it would leave a blank pane, an empty tab bar and no
  // empty-state to explain it.
  it('follows the tab when the move empties the project it was selected in', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio'), project(UNSORTED_ID, UNSORTED_ID, 'aaa')],
      tabs: [tab('aaa', 'scratch')],
      activeProjectId: UNSORTED_ID,
    }
    const next = workspaceReducer(state, {
      type: 'movedTab',
      tab: tab('aaa', 'lumio'),
      projects: [project('p1', 'lumio')],
    })
    expect(next.activeProjectId).toBe('p1')
    expect(tabsOfProject(next, 'p1').map((t) => t.id)).toEqual(['aaa'])
  })

  it('keeps the selection when the selected project is still in the reply', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio'), project('p2', 'gco'), project(UNSORTED_ID, UNSORTED_ID)],
      tabs: [tab('aaa', 'scratch'), tab('bbb', 'scratch')],
      activeProjectId: 'p2',
    }
    const next = workspaceReducer(state, {
      type: 'movedTab',
      tab: tab('aaa', 'lumio'),
      projects: state.projects,
    })
    expect(next.activeProjectId).toBe('p2')
  })

  it('never mutates the state it is given', () => {
    const before = JSON.stringify(three)
    workspaceReducer(three, { type: 'removed', id: 'bbb' })
    workspaceReducer(three, { type: 'opened', tab: tab('ddd') })
    workspaceReducer(three, { type: 'activatedTab', id: 'aaa' })
    expect(JSON.stringify(three)).toBe(before)
  })
})
