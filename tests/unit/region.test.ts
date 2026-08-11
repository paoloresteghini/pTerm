import { describe, it, expect } from 'vitest'
import { regionOf, type ProjectDescriptor, type TabDescriptor, type TabType } from '../../src/shared/ipc'
import {
  INITIAL_WORKSPACE_STATE,
  activeTabId,
  paneGroups,
  tabsOfProject,
  workspaceReducer,
  type WorkspaceState,
} from '../../src/renderer/workspace'
import { describeProjects } from '../../src/main/ipc/restore'
import type { ProjectRecord } from '../../src/main/state/store'

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

describe('reducer routing by region', () => {
  it('opening a browser pane does not move the terminal selection', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1' })],
      panes: [paneOf('t1', 'shell')],
    })
    const next = workspaceReducer(state, { type: 'opened', tab: paneOf('b1', 'browser') })
    expect(next.projects[0]?.activeTabId).toBe('t1')
    expect(next.projects[0]?.activeBrowserTabId).toBe('b1')
  })

  it('activating a terminal does not move the browser selection', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1', activeBrowserTabId: 'b1' })],
      panes: [paneOf('t1', 'shell'), paneOf('t2', 'shell'), paneOf('b1', 'browser')],
    })
    const next = workspaceReducer(state, { type: 'activatedTab', id: 't2' })
    expect(next.projects[0]?.activeTabId).toBe('t2')
    expect(next.projects[0]?.activeBrowserTabId).toBe('b1')
  })

  // The selection rule that matters on close: the replacement comes from the
  // same region. Handing the browser region a terminal id would leave the
  // region drawing a pane it does not own, and the terminal region drawing
  // nothing.
  it('closing a browser pane selects the neighbouring browser, not a terminal', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1', activeBrowserTabId: 'b1' })],
      panes: [paneOf('t1', 'shell'), paneOf('b1', 'browser'), paneOf('b2', 'browser')],
    })
    const next = workspaceReducer(state, {
      type: 'closedPane',
      paneId: 'b1',
      shape: { panes: [], tabs: [] },
    })
    expect(next.projects[0]?.activeBrowserTabId).toBe('b2')
    expect(next.projects[0]?.activeTabId).toBe('t1')
  })

  it('closing the last browser pane clears the browser selection only', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1', activeBrowserTabId: 'b1' })],
      panes: [paneOf('t1', 'shell'), paneOf('b1', 'browser')],
    })
    const next = workspaceReducer(state, {
      type: 'closedPane',
      paneId: 'b1',
      shape: { panes: [], tabs: [] },
    })
    expect(next.projects[0]?.activeBrowserTabId).toBeNull()
    expect(next.projects[0]?.activeTabId).toBe('t1')
  })

  // `removeTab` is `dismissed`'s path, not `closedPane`'s, but it walks the
  // same unfiltered sibling list `neighbourOf` reads by position. A browser
  // pane sitting between two terminal panes in `state.panes` would otherwise
  // become the terminal region's next selection when the first is dismissed.
  it('dismissing a dead terminal pane selects the neighbouring terminal, not a browser pane', () => {
    const state = stateWith({
      projects: [project({ activeTabId: 't1', activeBrowserTabId: 'b1' })],
      panes: [paneOf('t1', 'shell'), paneOf('b1', 'browser'), paneOf('t2', 'shell')],
      dead: { t1: 1 },
    })
    const next = workspaceReducer(state, { type: 'dismissed', id: 't1' })
    expect(next.projects[0]?.activeTabId).toBe('t2')
    expect(next.projects[0]?.activeBrowserTabId).toBe('b1')
  })
})

const recordFor = (id: string): ProjectRecord => ({
  id,
  name: 'demo',
  slug: 'demo',
  cwd: '/tmp/demo',
  presets: [],
  activeTabId: null,
  activeBrowserTabId: null,
})

describe('describeProjects', () => {
  it('resolves each region its own saved selection', async () => {
    const described = await describeProjects(
      [{ ...recordFor('p1'), activeTabId: 't1', activeBrowserTabId: 'b1' }],
      [paneOf('t1', 'shell'), paneOf('b1', 'browser')],
    )
    expect(described[0]?.activeTabId).toBe('t1')
    expect(described[0]?.activeBrowserTabId).toBe('b1')
  })

  // The fallback is the reason this test exists. `own[0]` is the project's
  // first pane in raw order, which after this change can be a browser, and a
  // terminal region pointed at a browser draws nothing at all.
  it('never falls back across the region boundary', async () => {
    const described = await describeProjects(
      [{ ...recordFor('p1'), activeTabId: null, activeBrowserTabId: null }],
      [paneOf('b1', 'browser'), paneOf('t1', 'shell')],
    )
    expect(described[0]?.activeTabId).toBe('t1')
    expect(described[0]?.activeBrowserTabId).toBe('b1')
  })

  it('leaves a region with no panes selecting nothing', async () => {
    const described = await describeProjects(
      [{ ...recordFor('p1'), activeTabId: null, activeBrowserTabId: null }],
      [paneOf('t1', 'shell')],
    )
    expect(described[0]?.activeBrowserTabId).toBeNull()
  })
})
