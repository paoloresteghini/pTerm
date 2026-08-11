import { describe, it, expect } from 'vitest'
import { regionOf, type ProjectDescriptor, type TabDescriptor, type TabType } from '../../src/shared/ipc'
import {
  INITIAL_WORKSPACE_STATE,
  activeTabId,
  paneGroups,
  tabsOfProject,
  type WorkspaceState,
} from '../../src/renderer/workspace'

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

const project = (over: Partial<ProjectDescriptor> = {}): ProjectDescriptor => ({
  id: 'p1',
  name: 'demo',
  slug: 'demo',
  cwd: '/tmp/demo',
  presets: [],
  activeTabId: null,
  available: true,
  ...over,
})

const paneOf = (id: string, type: TabType): TabDescriptor => ({
  id,
  projectSlug: 'demo',
  cwd: '/tmp/demo',
  type,
  ...(type === 'browser' ? { url: 'http://localhost:5173/' } : {}),
})

const stateWith = (over: Partial<WorkspaceState> = {}): WorkspaceState => ({
  ...INITIAL_WORKSPACE_STATE,
  projects: [project()],
  activeProjectId: 'p1',
  panes: [paneOf('t1', 'shell'), paneOf('b1', 'browser')],
  ...over,
})

describe('region-aware derivations', () => {
  it('splits one pane list into two strips', () => {
    const state = stateWith()
    expect(tabsOfProject(state, 'p1', 'terminal').map((pane) => pane.id)).toEqual(['t1'])
    expect(tabsOfProject(state, 'p1', 'browser').map((pane) => pane.id)).toEqual(['b1'])
  })

  // The default is the pre-change behaviour, which is what lets a call site
  // that has not been updated keep working rather than quietly losing panes.
  it('returns every pane when no region is named', () => {
    expect(tabsOfProject(stateWith(), 'p1').map((pane) => pane.id)).toEqual(['t1', 'b1'])
  })

  it('reads each region its own active id', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1', activeBrowserTabId: 'b1' })],
    })
    expect(activeTabId(state, 'terminal')).toBe('t1')
    expect(activeTabId(state, 'browser')).toBe('b1')
  })

  it('reads a project that predates the field as no browser selection', () => {
    const state = stateWith({ projects: [project({ activeTabId: 't1' })] })
    expect(activeTabId(state, 'browser')).toBeNull()
  })

  it('boxes only its own region and shows that region its own active pane', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1', activeBrowserTabId: 'b1' })],
    })
    const terminal = paneGroups(state, 'terminal')
    const browser = paneGroups(state, 'browser')
    expect(terminal.flatMap((group) => group.panes.map((box) => box.pane.id))).toEqual(['t1'])
    expect(browser.flatMap((group) => group.panes.map((box) => box.pane.id))).toEqual(['b1'])
    // Each region shows something. Before this change the single active id
    // could only make one of them visible.
    expect(terminal.some((group) => group.visible)).toBe(true)
    expect(browser.some((group) => group.visible)).toBe(true)
  })
})
