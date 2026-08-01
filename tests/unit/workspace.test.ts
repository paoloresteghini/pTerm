import { describe, it, expect } from 'vitest'
import {
  INITIAL_WORKSPACE_STATE,
  workspaceReducer,
  neighbourOf,
  projectIdForTab,
  tabsOfProject,
  activeProject,
  activeTabId,
  stateOfTab,
  stateOfProject,
  needsYou,
  panesOfTab,
  tabOfPane,
  type WorkspaceState,
} from '../../src/renderer/workspace'
import {
  UNSORTED_ID,
  type ProjectDescriptor,
  type TabDescriptor,
  type TabRow,
} from '../../src/shared/ipc'

function tab(id: string, projectSlug = 'lumio'): TabDescriptor {
  return {
    id,
    projectSlug,
    cwd: '/tmp',
    tmuxSession: `prcli-${projectSlug}-${id}`,
    type: 'shell',
  }
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

/** A tab row over `kids`, evenly split, with the founder active by default. */
function tabRow(id: string, kids: string[], activePaneId: string | null = kids[0] ?? null): TabRow {
  return {
    id,
    activePaneId,
    layout: { dir: 'row', ratio: kids.map(() => 1 / kids.length), kids },
  }
}

const three: WorkspaceState = {
  projects: [project('p1', 'lumio', 'bbb')],
  panes: [tab('aaa'), tab('bbb'), tab('ccc')],
  tabs: [],
  activeProjectId: 'p1',
  status: {},
  dead: {},
}

describe('neighbourOf', () => {
  it('prefers the tab to the right', () => {
    expect(neighbourOf(three.panes, 'aaa')).toBe('bbb')
  })

  it('falls back to the left for the last tab', () => {
    expect(neighbourOf(three.panes, 'ccc')).toBe('bbb')
  })

  it('returns null when it was the only tab', () => {
    expect(neighbourOf([tab('aaa')], 'aaa')).toBeNull()
  })

  it('returns null for an unknown id', () => {
    expect(neighbourOf(three.panes, 'zzz')).toBeNull()
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
      panes: [tab('aaa', 'lumio'), tab('bbb', 'gco'), tab('ccc', 'lumio')],
      tabs: [],
      activeProjectId: 'p1',
      status: {},
      dead: {},
    }
    expect(tabsOfProject(state, 'p1').map((t) => t.id)).toEqual(['aaa', 'ccc'])
  })

  it('collects every unmatched tab under Unsorted', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio')],
      panes: [tab('aaa', 'lumio'), tab('bbb', 'scratch'), tab('ccc', 'old')],
      tabs: [],
      activeProjectId: 'p1',
      status: {},
      dead: {},
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

describe('panesOfTab', () => {
  it('returns a tab\'s panes in kids order', () => {
    const state: WorkspaceState = {
      ...three,
      tabs: [tabRow('aaa', ['aaa', 'ccc'])],
    }
    expect(panesOfTab(state, 'aaa').map((p) => p.id)).toEqual(['aaa', 'ccc'])
  })

  it('is empty for a tab id naming no row, rather than throwing', () => {
    expect(panesOfTab(three, 'nope')).toEqual([])
  })

  it('skips a kid whose pane is not in state.panes, rather than throwing', () => {
    const state: WorkspaceState = {
      ...three,
      tabs: [tabRow('aaa', ['aaa', 'ghost'])],
    }
    expect(panesOfTab(state, 'aaa').map((p) => p.id)).toEqual(['aaa'])
  })
})

describe('tabOfPane', () => {
  it('finds the row naming a pane in its kids', () => {
    const state: WorkspaceState = {
      ...three,
      tabs: [tabRow('aaa', ['aaa', 'ccc'])],
    }
    expect(tabOfPane(state, 'ccc')?.id).toBe('aaa')
  })

  it('is undefined for a pane in no tab\'s kids, rather than throwing', () => {
    expect(tabOfPane(three, 'aaa')).toBeUndefined()
  })
})

describe('workspaceReducer', () => {
  it('starts empty', () => {
    expect(INITIAL_WORKSPACE_STATE).toEqual({
      projects: [],
      panes: [],
      tabs: [],
      activeProjectId: null,
      status: {},
      dead: {},
    })
  })

  it('replaces everything on restore', () => {
    const next = workspaceReducer(three, {
      type: 'restored',
      projects: [project('p9', 'gco', 'zzz')],
      panes: [tab('zzz', 'gco')],
      tabs: [],
      activeProjectId: 'p9',
    })
    expect(next.panes.map((t) => t.id)).toEqual(['zzz'])
    expect(next.activeProjectId).toBe('p9')
  })

  // A payload naming a pane in no tab's kids is not invented into one — the
  // renderer trusts main. `restored` is where that first matters: a genuine
  // reply can carry a pane with no row (a one-pane tab opened this run has
  // none on disk), and the reducer must not fabricate one for it.
  it('does not invent a tab row for a pane no row claims', () => {
    const next = workspaceReducer(three, {
      type: 'restored',
      projects: [project('p9', 'gco', 'zzz')],
      panes: [tab('zzz', 'gco'), tab('yyy', 'gco')],
      tabs: [tabRow('zzz', ['zzz'])],
      activeProjectId: 'p9',
    })
    expect(next.panes.map((t) => t.id)).toEqual(['zzz', 'yyy'])
    expect(next.tabs.map((t) => t.id)).toEqual(['zzz'])
    expect(tabOfPane(next, 'yyy')).toBeUndefined()
  })

  // I6: `status` used to come from a second, separately raced `status()`
  // call and `restored` always reset it to `{}`. Now `restore()` returns its
  // own status snapshot in the same response, so `restored` carries it
  // through directly instead of discarding it.
  it('carries the status snapshot restore() returned, when it gave one', () => {
    const next = workspaceReducer(three, {
      type: 'restored',
      projects: [project('p9', 'gco', 'zzz')],
      panes: [tab('zzz', 'gco')],
      tabs: [],
      activeProjectId: 'p9',
      status: { zzz: 'waiting' },
    })
    expect(next.status).toEqual({ zzz: 'waiting' })
  })

  it('appends an opened tab and makes it its project\'s active one', () => {
    const next = workspaceReducer(three, { type: 'opened', tab: tab('ddd') })
    expect(next.panes.map((t) => t.id)).toEqual(['aaa', 'bbb', 'ccc', 'ddd'])
    expect(activeTabId(next)).toBe('ddd')
  })

  it('ignores an opened tab that is already present', () => {
    const next = workspaceReducer(three, { type: 'opened', tab: tab('bbb') })
    expect(next.panes.map((t) => t.id)).toEqual(['aaa', 'bbb', 'ccc'])
  })

  it('activates a tab', () => {
    expect(activeTabId(workspaceReducer(three, { type: 'activatedTab', id: 'ccc' }))).toBe('ccc')
  })

  it('ignores activation of an unknown tab', () => {
    expect(activeTabId(workspaceReducer(three, { type: 'activatedTab', id: 'zzz' }))).toBe('bbb')
  })

  it('removes a tab and moves the active one to its neighbour', () => {
    const next = workspaceReducer(three, { type: 'removed', id: 'bbb' })
    expect(next.panes.map((t) => t.id)).toEqual(['aaa', 'ccc'])
    expect(activeTabId(next)).toBe('ccc')
  })

  it('leaves the active tab alone when removing a different one', () => {
    expect(activeTabId(workspaceReducer(three, { type: 'removed', id: 'aaa' }))).toBe('bbb')
  })

  it('goes back to nothing active when a project\'s last tab is removed', () => {
    const one: WorkspaceState = {
      projects: [project('p1', 'lumio', 'aaa')],
      panes: [tab('aaa')],
      tabs: [],
      activeProjectId: 'p1',
      status: {},
      dead: {},
    }
    const next = workspaceReducer(one, { type: 'removed', id: 'aaa' })
    expect(next.panes).toEqual([])
    expect(activeTabId(next)).toBeNull()
  })

  it('ignores removal of an unknown tab', () => {
    expect(workspaceReducer(three, { type: 'removed', id: 'zzz' })).toEqual(three)
  })

  // I7: a kill drops the tab via `removed`, and the reducer already cleared
  // `status` for it — but left `dead` holding a tombstone for a tab no
  // longer in `state.panes` at all, accumulating one stale entry per close
  // for the life of the window.
  it('drops the tombstone too when a dead tab is removed outright', () => {
    const died = workspaceReducer(three, { type: 'died', id: 'aaa', code: 1 })
    const next = workspaceReducer(died, { type: 'removed', id: 'aaa' })
    expect(next.dead).toEqual({})
  })

  // Removing a tab from one project must not disturb another's selection.
  it('only touches the owning project\'s active tab', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio', 'aaa'), project('p2', 'gco', 'bbb')],
      panes: [tab('aaa', 'lumio'), tab('bbb', 'gco')],
      tabs: [],
      activeProjectId: 'p2',
      status: {},
      dead: {},
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
    expect(next.panes).toEqual(three.panes)
  })

  it('drops the selection when the selected project disappears', () => {
    const next = workspaceReducer(three, { type: 'projects', projects: [project('p2', 'gco')] })
    expect(next.activeProjectId).toBe('p2')
  })

  it('re-slugs a moved tab in place, keeping its position', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio')],
      panes: [tab('aaa', 'scratch'), tab('bbb', 'scratch')],
      tabs: [],
      activeProjectId: 'p1',
      status: {},
      dead: {},
    }
    const next = workspaceReducer(state, {
      type: 'movedTab',
      panes: [tab('aaa', 'lumio')],
      projects: state.projects,
    })
    expect(next.panes.map((t) => t.projectSlug)).toEqual(['lumio', 'scratch'])
  })

  // The reply names every pane that moved, because a split tab has one session
  // name — and one record — per pane. Replacing only the first would leave the
  // rest drawn under the project they came from until the next relaunch.
  it('re-slugs every pane the reply names', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio')],
      panes: [tab('aaa', 'scratch'), tab('bbb', 'scratch'), tab('ccc', 'scratch')],
      tabs: [],
      activeProjectId: 'p1',
      status: {},
      dead: {},
    }
    const next = workspaceReducer(state, {
      type: 'movedTab',
      panes: [tab('aaa', 'lumio'), tab('bbb', 'lumio')],
      projects: state.projects,
    })
    expect(next.panes.map((t) => t.projectSlug)).toEqual(['lumio', 'lumio', 'scratch'])
  })

  // Filing the last stray empties Unsorted, so the reply omits it — and the
  // selection pointing at it would leave a blank pane, an empty tab bar and no
  // empty-state to explain it.
  it('follows the tab when the move empties the project it was selected in', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio'), project(UNSORTED_ID, UNSORTED_ID, 'aaa')],
      panes: [tab('aaa', 'scratch')],
      tabs: [],
      activeProjectId: UNSORTED_ID,
      status: {},
      dead: {},
    }
    const next = workspaceReducer(state, {
      type: 'movedTab',
      panes: [tab('aaa', 'lumio')],
      projects: [project('p1', 'lumio')],
    })
    expect(next.activeProjectId).toBe('p1')
    expect(tabsOfProject(next, 'p1').map((t) => t.id)).toEqual(['aaa'])
  })

  it('keeps the selection when the selected project is still in the reply', () => {
    const state: WorkspaceState = {
      projects: [project('p1', 'lumio'), project('p2', 'gco'), project(UNSORTED_ID, UNSORTED_ID)],
      panes: [tab('aaa', 'scratch'), tab('bbb', 'scratch')],
      tabs: [],
      activeProjectId: 'p2',
      status: {},
      dead: {},
    }
    const next = workspaceReducer(state, {
      type: 'movedTab',
      panes: [tab('aaa', 'lumio')],
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

  it('takes a whole status snapshot on restore', () => {
    const next = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: { 'aaa': 'waiting' },
    })
    expect(stateOfTab(next, 'aaa')).toBe('waiting')
  })

  it('updates one tab without disturbing the others', () => {
    const seeded = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: { 'aaa': 'idle', 'bbb': 'thinking' },
    })

    const next = workspaceReducer(seeded, {
      type: 'statusChanged',
      tabId: 'aaa',
      state: 'waiting',
    })

    expect(stateOfTab(next, 'aaa')).toBe('waiting')
    expect(stateOfTab(next, 'bbb')).toBe('thinking')
  })

  // I3: `registry.forget` now emits a transition to `null` — dismissed, or
  // killed on purpose — over the wire as `statusChanged`'s `state`. Storing
  // that as a value would let it slip into `stateOfProject`'s ranking (which
  // filters on `undefined`, not `null`) and sit in `state.status` forever, so
  // a null clears the key instead of setting it.
  it('drops the key on a null statusChanged, rather than storing null', () => {
    const seeded = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: { aaa: 'waiting', bbb: 'thinking' },
    })

    const next = workspaceReducer(seeded, { type: 'statusChanged', tabId: 'aaa', state: null })

    expect(stateOfTab(next, 'aaa')).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(next.status, 'aaa')).toBe(false)
    expect(stateOfTab(next, 'bbb')).toBe('thinking')
  })

  it('has no state for a tab nothing has said anything about', () => {
    expect(stateOfTab(three, 'aaa')).toBeNull()
  })

  it('gives a project row the worst state among its tabs', () => {
    const seeded = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: { 'aaa': 'idle', 'bbb': 'waiting' },
    })

    expect(stateOfProject(seeded, 'p1')).toBe('waiting')
  })

  it('gives a project with nothing to report no dot at all', () => {
    expect(stateOfProject(three, 'p1')).toBeNull()
  })

  it('lists every tab that is blocking a human, worst first', () => {
    const seeded = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: {
        'aaa': 'waiting',
        'bbb': 'crashed',
        'ccc': 'thinking',
      },
    })

    const list = needsYou(seeded)

    // Only the two states that mean a human is required, and the crash first.
    expect(list.map((tab) => tab.id)).toEqual(['bbb', 'aaa'])
  })

  it('keeps a dead tab in the bar instead of dropping it', () => {
    const next = workspaceReducer(three, { type: 'died', id: 'aaa', code: 1 })

    // The behaviour this milestone changes: a crashed `npm run dev` used to
    // vanish and tell you nothing, which made `crashed` unrenderable.
    expect(next.panes.some((tab) => tab.id === 'aaa')).toBe(true)
    expect(next.dead['aaa']).toBe(1)
  })

  it('leaves the selection on a tab that died, so its scrollback stays readable', () => {
    const selected = workspaceReducer(three, { type: 'activatedTab', id: 'aaa' })
    const next = workspaceReducer(selected, { type: 'died', id: 'aaa', code: 1 })

    expect(activeTabId(next)).toBe('aaa')
  })

  it('drops the tab and its tombstone on dismiss', () => {
    const died = workspaceReducer(three, { type: 'died', id: 'aaa', code: 1 })

    const next = workspaceReducer(died, { type: 'dismissed', id: 'aaa' })

    expect(next.panes.some((tab) => tab.id === 'aaa')).toBe(false)
    expect(next.dead['aaa']).toBeUndefined()
  })

  it('moves the selection to a neighbour on dismiss, as a close does', () => {
    const selected = workspaceReducer(three, { type: 'activatedTab', id: 'aaa' })
    const died = workspaceReducer(selected, { type: 'died', id: 'aaa', code: 1 })

    const next = workspaceReducer(died, { type: 'dismissed', id: 'aaa' })

    expect(activeTabId(next)).not.toBe('aaa')
  })

  it('clears the tombstone when a dead tab is restarted', () => {
    const died = workspaceReducer(three, { type: 'died', id: 'aaa', code: 1 })
    const tab = died.panes.find((candidate) => candidate.id === 'aaa')
    if (!tab) throw new Error('fixture lost the tab')

    const next = workspaceReducer(died, { type: 'opened', tab })

    // Restart reuses the id. A tombstone left behind would keep offering
    // Restart on a session that is already running.
    expect(next.dead['aaa']).toBeUndefined()
    expect(next.panes.filter((candidate) => candidate.id === 'aaa')).toHaveLength(1)
  })

  it('drops the status of a tab that is closed outright', () => {
    const seeded = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: { 'aaa': 'waiting' },
    })

    const next = workspaceReducer(seeded, { type: 'removed', id: 'aaa' })

    expect(stateOfTab(next, 'aaa')).toBeNull()
  })

  it('resets status and tombstones on restore', () => {
    const seeded = workspaceReducer(three, { type: 'died', id: 'aaa', code: 1 })
    const next = workspaceReducer(seeded, {
      type: 'restored',
      projects: seeded.projects,
      panes: seeded.panes,
      tabs: seeded.tabs,
      activeProjectId: seeded.activeProjectId,
    })

    expect(next.status).toEqual({})
    expect(next.dead).toEqual({})
  })

  describe('split', () => {
    it('inserts the new pane and replaces the tab row', () => {
      // aaa starts as a one-pane tab with no row of its own — exactly what a
      // tab opened this run looks like before it is ever split.
      const next = workspaceReducer(three, {
        type: 'split',
        shape: {
          panes: [tab('aaa'), tab('new')],
          tabs: [tabRow('aaa', ['aaa', 'new'])],
        },
      })
      expect(next.panes.map((p) => p.id)).toEqual(['aaa', 'bbb', 'ccc', 'new'])
      expect(next.tabs.map((t) => t.id)).toEqual(['aaa'])
      expect(panesOfTab(next, 'aaa').map((p) => p.id)).toEqual(['aaa', 'new'])
    })

    it('replaces an existing row in place rather than appending a second one', () => {
      const state: WorkspaceState = {
        ...three,
        tabs: [tabRow('aaa', ['aaa', 'bbb'])],
      }
      const next = workspaceReducer(state, {
        type: 'split',
        shape: {
          panes: [tab('aaa'), tab('bbb'), tab('new')],
          tabs: [tabRow('aaa', ['aaa', 'bbb', 'new'])],
        },
      })
      expect(next.tabs).toHaveLength(1)
      expect(panesOfTab(next, 'aaa').map((p) => p.id)).toEqual(['aaa', 'bbb', 'new'])
    })
  })

  describe('closedPane', () => {
    it('removes the pane and updates the row when siblings remain', () => {
      const state: WorkspaceState = {
        ...three,
        tabs: [tabRow('aaa', ['aaa', 'bbb'])],
      }
      const next = workspaceReducer(state, {
        type: 'closedPane',
        paneId: 'bbb',
        shape: {
          panes: [tab('aaa')],
          tabs: [tabRow('aaa', ['aaa'])],
        },
      })
      expect(next.panes.map((p) => p.id)).toEqual(['aaa', 'ccc'])
      expect(panesOfTab(next, 'aaa').map((p) => p.id)).toEqual(['aaa'])
    })

    it('drops the row too when the closed pane was the tab\'s last one', () => {
      const state: WorkspaceState = {
        ...three,
        tabs: [tabRow('aaa', ['aaa'])],
      }
      const next = workspaceReducer(state, {
        type: 'closedPane',
        paneId: 'aaa',
        shape: { panes: [], tabs: [] },
      })
      expect(next.panes.map((p) => p.id)).toEqual(['bbb', 'ccc'])
      expect(next.tabs).toEqual([])
      expect(tabOfPane(next, 'aaa')).toBeUndefined()
    })

    it('leaves state untouched for a pane that had no row to begin with', () => {
      // aaa is a one-pane tab with no row on disk — closing it removes the
      // pane but there is no row to drop.
      const next = workspaceReducer(three, {
        type: 'closedPane',
        paneId: 'aaa',
        shape: { panes: [], tabs: [] },
      })
      expect(next.panes.map((p) => p.id)).toEqual(['bbb', 'ccc'])
      expect(next.tabs).toEqual([])
    })
  })

  describe('activatedPane', () => {
    it('sets the tab\'s activePaneId', () => {
      const state: WorkspaceState = {
        ...three,
        tabs: [tabRow('aaa', ['aaa', 'bbb'], 'aaa')],
      }
      const next = workspaceReducer(state, {
        type: 'activatedPane',
        tabId: 'aaa',
        paneId: 'bbb',
      })
      expect(next.tabs.find((t) => t.id === 'aaa')?.activePaneId).toBe('bbb')
    })

    it('ignores activation naming an unknown tab', () => {
      const state: WorkspaceState = {
        ...three,
        tabs: [tabRow('aaa', ['aaa', 'bbb'], 'aaa')],
      }
      const next = workspaceReducer(state, {
        type: 'activatedPane',
        tabId: 'nope',
        paneId: 'bbb',
      })
      expect(next).toEqual(state)
    })
  })
})
