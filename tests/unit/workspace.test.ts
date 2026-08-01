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
  paneGroups,
  paneInDirection,
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
    // The tab's own group until it re-founds, which nothing in the renderer
    // does or can: it is main that decides a tab's group.
    groupId: id,
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

  it('is empty against a fully empty WorkspaceState', () => {
    expect(panesOfTab(INITIAL_WORKSPACE_STATE, 'aaa')).toEqual([])
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

  it('is undefined against a fully empty WorkspaceState', () => {
    expect(tabOfPane(INITIAL_WORKSPACE_STATE, 'aaa')).toBeUndefined()
  })
})

describe('paneInDirection', () => {
  /** A `col` tab over `kids`, evenly split — `tabRow` only builds `row` ones. */
  function colRow(id: string, kids: string[]): TabRow {
    return {
      id,
      groupId: id,
      activePaneId: kids[0] ?? null,
      layout: { dir: 'col', ratio: kids.map(() => 1 / kids.length), kids },
    }
  }

  const split: WorkspaceState = { ...three, tabs: [tabRow('aaa', ['aaa', 'bbb', 'ccc'])] }

  it('steps one pane along the axis, in kids order', () => {
    // Non-empty first: an assertion about a step through a list says nothing
    // if the list turns out to be empty.
    expect(panesOfTab(split, 'aaa')).toHaveLength(3)
    expect(paneInDirection(split, 'aaa', 'right')?.id).toBe('bbb')
    expect(paneInDirection(split, 'bbb', 'right')?.id).toBe('ccc')
    expect(paneInDirection(split, 'ccc', 'left')?.id).toBe('bbb')
    expect(paneInDirection(split, 'bbb', 'left')?.id).toBe('aaa')
  })

  it('is undefined at either end rather than wrapping round', () => {
    // Both ends, because a wrap at one of them is a wrap. Wrapping would put
    // focus at the far side of the screen from where the key pointed.
    expect(paneInDirection(split, 'aaa', 'left')).toBeUndefined()
    expect(paneInDirection(split, 'ccc', 'right')).toBeUndefined()
  })

  it('ignores a direction across the tab\'s axis', () => {
    // A `row` tab has nothing above or below any of its panes.
    expect(paneInDirection(split, 'aaa', 'down')).toBeUndefined()
    expect(paneInDirection(split, 'bbb', 'up')).toBeUndefined()
  })

  it('steps down and up a col tab, and ignores left and right there', () => {
    const state: WorkspaceState = { ...three, tabs: [colRow('aaa', ['aaa', 'bbb'])] }
    expect(panesOfTab(state, 'aaa')).toHaveLength(2)
    expect(paneInDirection(state, 'aaa', 'down')?.id).toBe('bbb')
    expect(paneInDirection(state, 'bbb', 'up')?.id).toBe('aaa')
    expect(paneInDirection(state, 'bbb', 'down')).toBeUndefined()
    expect(paneInDirection(state, 'aaa', 'right')).toBeUndefined()
  })

  it('is undefined for a pane no row names, rather than throwing', () => {
    // Every tab opened this run, until something splits it.
    expect(paneInDirection(three, 'aaa', 'right')).toBeUndefined()
  })

  it('is undefined for a pane id nothing knows', () => {
    expect(paneInDirection(split, 'zzz', 'right')).toBeUndefined()
  })

  it('steps over a kid whose pane is gone, onto the next one that renders', () => {
    // `panesOfTab` is the order on screen — `paneGroups` boxes exactly those
    // panes — so a kid with no pane is drawn nowhere, and stepping onto it
    // would be a key that moved focus to nothing.
    const state: WorkspaceState = { ...three, tabs: [tabRow('aaa', ['aaa', 'ghost', 'bbb'])] }
    expect(panesOfTab(state, 'aaa').map((p) => p.id)).toEqual(['aaa', 'bbb'])
    expect(paneInDirection(state, 'aaa', 'right')?.id).toBe('bbb')
  })

  it('is undefined against a fully empty WorkspaceState', () => {
    expect(paneInDirection(INITIAL_WORKSPACE_STATE, 'aaa', 'right')).toBeUndefined()
  })
})

describe('paneGroups', () => {
  /** A row with explicit ratios, for the cases `tabRow`'s even split cannot show. */
  function ratioRow(id: string, kids: string[], ratio: number[], dir: 'row' | 'col' = 'row'): TabRow {
    return { id, groupId: id, activePaneId: kids[0] ?? null, layout: { dir, ratio, kids } }
  }

  it('lays a tab\'s panes along its axis, in kids order, sized by ratio', () => {
    const state: WorkspaceState = {
      ...three,
      tabs: [ratioRow('bbb', ['bbb', 'ccc'], [0.6, 0.4])],
    }
    const group = paneGroups(state).find((candidate) => candidate.id === 'bbb')
    expect(group).toBeDefined()
    expect(group?.style).toEqual({ flexDirection: 'row' })
    expect(group?.panes.map((box) => box.pane.id)).toEqual(['bbb', 'ccc'])
    expect(group?.panes.map((box) => box.style)).toEqual([
      { flexBasis: '60%' },
      { flexBasis: '40%' },
    ])
  })

  it('lays a col tab down the column axis', () => {
    const state: WorkspaceState = {
      ...three,
      tabs: [ratioRow('bbb', ['bbb', 'ccc'], [0.25, 0.75], 'col')],
    }
    const group = paneGroups(state).find((candidate) => candidate.id === 'bbb')
    expect(group?.style).toEqual({ flexDirection: 'column' })
    expect(group?.panes.map((box) => box.style.flexBasis)).toEqual(['25%', '75%'])
  })

  it('divides three panes into thirds that between them claim the whole tab', () => {
    const state: WorkspaceState = {
      ...three,
      tabs: [tabRow('aaa', ['aaa', 'bbb', 'ccc'])],
    }
    const group = paneGroups(state).find((candidate) => candidate.id === 'aaa')
    expect(group?.panes).toHaveLength(3)
    const bases = group?.panes.map((box) => Number.parseFloat(box.style.flexBasis)) ?? []
    expect(bases).toEqual([33.3333, 33.3333, 33.3333])
    expect(bases.reduce((sum, basis) => sum + basis, 0)).toBeGreaterThan(99.999)
  })

  it('gives every pane a box, including the panes of tabs that are not on screen', () => {
    const state: WorkspaceState = {
      ...three,
      tabs: [ratioRow('aaa', ['aaa'], [1]), ratioRow('bbb', ['bbb', 'ccc'], [0.5, 0.5])],
    }
    const groups = paneGroups(state)
    expect(groups).not.toHaveLength(0)
    const boxed = groups.flatMap((group) => group.panes.map((box) => box.pane.id))
    expect(boxed.sort()).toEqual(['aaa', 'bbb', 'ccc'])
    // The tab that is not on screen is in there, panes and all — the whole
    // point being that its terminals stay mounted.
    expect(groups.find((group) => group.id === 'aaa')?.visible).toBe(false)
    expect(groups.find((group) => group.id === 'aaa')?.panes).toHaveLength(1)
  })

  it('shows exactly one group: the active tab\'s', () => {
    const state: WorkspaceState = {
      ...three,
      tabs: [ratioRow('aaa', ['aaa'], [1]), ratioRow('bbb', ['bbb', 'ccc'], [0.5, 0.5])],
    }
    const groups = paneGroups(state)
    expect(groups).not.toHaveLength(0)
    expect(groups.filter((group) => group.visible).map((group) => group.id)).toEqual(['bbb'])
  })

  it('shows a tab when the selection names one of its panes rather than the tab', () => {
    // 'ccc' is the second pane of tab 'bbb', so no group is keyed by it.
    const state: WorkspaceState = {
      ...three,
      projects: [project('p1', 'lumio', 'ccc')],
      tabs: [ratioRow('bbb', ['bbb', 'ccc'], [0.5, 0.5])],
    }
    expect(paneGroups(state).filter((group) => group.visible).map((group) => group.id)).toEqual([
      'bbb',
    ])
  })

  it('shows nothing when no tab is selected', () => {
    const state: WorkspaceState = { ...three, projects: [project('p1', 'lumio', null)] }
    const groups = paneGroups(state)
    expect(groups).not.toHaveLength(0)
    expect(groups.some((group) => group.visible)).toBe(false)
  })

  it('gives a pane no row names a whole group of its own, keyed by its own id', () => {
    // `three` has no rows at all: this is every freshly opened tab.
    const groups = paneGroups(three)
    expect(groups.map((group) => group.id)).toEqual(['aaa', 'bbb', 'ccc'])
    expect(groups.map((group) => group.panes.map((box) => box.style.flexBasis))).toEqual([
      ['100%'],
      ['100%'],
      ['100%'],
    ])
  })

  it('keeps a pane\'s group in place when a row arrives for it', () => {
    // A row id is its founder pane's id, so the container the terminal lives
    // in is the same one before and after — nothing remounts.
    const before = paneGroups(three)
    const after = paneGroups({ ...three, tabs: [tabRow('bbb', ['bbb', 'ccc'])] })
    expect(before.map((group) => group.id)).toEqual(['aaa', 'bbb', 'ccc'])
    expect(after.map((group) => group.id)).toEqual(['aaa', 'bbb'])
    expect(after[1]?.panes.map((box) => box.pane.id)).toEqual(['bbb', 'ccc'])
  })

  it('renormalises the panes that are here when a kid\'s pane is missing', () => {
    const state: WorkspaceState = {
      ...three,
      tabs: [ratioRow('bbb', ['bbb', 'ghost', 'ccc'], [0.5, 0.25, 0.25])],
    }
    const group = paneGroups(state).find((candidate) => candidate.id === 'bbb')
    // The share is read at the kid's own index, so 'ccc' keeps 0.25 rather
    // than sliding onto the ghost's; the two are then scaled up to fill.
    expect(group?.panes.map((box) => box.pane.id)).toEqual(['bbb', 'ccc'])
    expect(group?.panes.map((box) => box.style.flexBasis)).toEqual(['66.6667%', '33.3333%'])
  })

  it('splits evenly when a row carries no usable ratios', () => {
    const state: WorkspaceState = { ...three, tabs: [ratioRow('bbb', ['bbb', 'ccc'], [])] }
    const group = paneGroups(state).find((candidate) => candidate.id === 'bbb')
    // Never a 0%-wide box: that fits to tmux's floor of 2x1.
    expect(group?.panes.map((box) => box.style.flexBasis)).toEqual(['50%', '50%'])
  })

  it('boxes a pane two rows both name exactly once', () => {
    // Not a state main hands over — `tabRows` dedupes kids across rows — but
    // a second box would mean a second xterm on one tmux pane.
    const state: WorkspaceState = {
      ...three,
      tabs: [tabRow('aaa', ['aaa', 'bbb']), tabRow('ccc', ['ccc', 'bbb'])],
    }
    const groups = paneGroups(state)
    expect(groups).not.toHaveLength(0)
    const boxed = groups.flatMap((group) => group.panes.map((box) => box.pane.id))
    expect(boxed.filter((id) => id === 'bbb')).toHaveLength(1)
    // The first row to name it keeps it, and the second renormalises around
    // what is left rather than rendering a gap.
    expect(groups.map((group) => group.panes.map((box) => box.pane.id))).toEqual([
      ['aaa', 'bbb'],
      ['ccc'],
    ])
    expect(groups[1]?.panes.map((box) => box.style.flexBasis)).toEqual(['100%'])
  })

  it('boxes a pane one row names twice exactly once', () => {
    // `normaliseLayout` dedupes kids within a row, so this too is upstream's
    // job today — but a second box is a second xterm on one tmux pane, and
    // here it would also hand both boxes the same React key.
    const state: WorkspaceState = {
      ...three,
      tabs: [ratioRow('bbb', ['bbb', 'bbb', 'ccc'], [0.5, 0.25, 0.25])],
    }
    const group = paneGroups(state).find((candidate) => candidate.id === 'bbb')
    expect(group?.panes).toHaveLength(2)
    expect(group?.panes.map((box) => box.pane.id)).toEqual(['bbb', 'ccc'])
    // The first mention keeps its own share; the repeat's is dropped with it,
    // exactly as an absent kid's is, and the survivors renormalise.
    expect(group?.panes.map((box) => box.style.flexBasis)).toEqual(['66.6667%', '33.3333%'])
  })

  it('drops a group left with nothing rather than rendering an empty tab', () => {
    // 'bbb' is claimed by the row built first, which leaves the row keyed by
    // 'bbb' — the one `tabOfPane` hands back for it — with no panes at all.
    const state: WorkspaceState = {
      ...three,
      panes: [tab('aaa'), tab('bbb')],
      tabs: [tabRow('bbb', ['bbb']), tabRow('aaa', ['aaa', 'bbb'])],
    }
    const groups = paneGroups(state)
    expect(groups).not.toHaveLength(0)
    expect(groups.every((group) => group.panes.length > 0)).toBe(true)
    expect(groups.map((group) => group.id)).toEqual(['aaa'])
    expect(groups[0]?.panes.map((box) => box.pane.id)).toEqual(['aaa', 'bbb'])
  })

  it('is empty against a fully empty WorkspaceState', () => {
    expect(paneGroups(INITIAL_WORKSPACE_STATE)).toEqual([])
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
      // Direct on the row's own kids, not just panesOfTab's filtered view of
      // it — panesOfTab quietly drops a kid whose pane is gone from
      // state.panes, so it reads right even if the row itself were never
      // updated. This is the assertion that actually depends on the row
      // having been replaced.
      expect(next.tabs.find((t) => t.id === 'aaa')?.layout.kids).toEqual(['aaa'])
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

    // The selection is what the tab bar highlights, what `setActive` reports
    // to main and what the keyboard acts on next — and since v5 it names a
    // pane. Leaving it on the pane that just closed points every one of those
    // at something that is gone: `visibleGroupId` resolves it through
    // `tabOfPane`, finds no row and no group keyed by it, and the window shows
    // no terminal at all.
    it('hands the selection to the tab\'s surviving pane when the closed one had it', () => {
      const state: WorkspaceState = {
        ...three,
        projects: [project('p1', 'lumio', 'ccc')],
        tabs: [tabRow('bbb', ['bbb', 'ccc'])],
      }
      const next = workspaceReducer(state, {
        type: 'closedPane',
        paneId: 'ccc',
        shape: { panes: [tab('bbb')], tabs: [tabRow('bbb', ['bbb'])] },
      })
      // Main's own answer, not a guess: `closePane` names the survivor that
      // takes over in the row it hands back.
      expect(activeTabId(next)).toBe('bbb')
    })

    it('hands it to a neighbouring tab when the closed pane was the tab\'s last', () => {
      const state: WorkspaceState = {
        ...three,
        tabs: [tabRow('bbb', ['bbb'])],
      }
      const next = workspaceReducer(state, {
        type: 'closedPane',
        paneId: 'bbb',
        shape: { panes: [], tabs: [] },
      })
      expect(next.panes.map((p) => p.id)).toEqual(['aaa', 'ccc'])
      // The row is gone, so there is no surviving pane to name and the rule
      // is the tab bar's own: the tab to the right, or the left when it was
      // last.
      expect(activeTabId(next)).toBe('ccc')
    })

    it('leaves the selection alone when some other pane closes', () => {
      const state: WorkspaceState = { ...three, tabs: [tabRow('aaa', ['aaa'])] }
      const next = workspaceReducer(state, {
        type: 'closedPane',
        paneId: 'aaa',
        shape: { panes: [], tabs: [] },
      })
      expect(activeTabId(next)).toBe('bbb')
    })

    it('leaves every other project\'s selection alone', () => {
      const state: WorkspaceState = {
        projects: [project('p1', 'lumio', 'aaa'), project('p2', 'gco', 'bbb')],
        panes: [tab('aaa', 'lumio'), tab('bbb', 'gco')],
        tabs: [tabRow('aaa', ['aaa'])],
        activeProjectId: 'p2',
        status: {},
        dead: {},
      }
      const next = workspaceReducer(state, {
        type: 'closedPane',
        paneId: 'aaa',
        shape: { panes: [], tabs: [] },
      })
      expect(next.projects[1].activeTabId).toBe('bbb')
    })

    it('leaves the selection alone for a pane it does not have', () => {
      const next = workspaceReducer(three, {
        type: 'closedPane',
        paneId: 'zzz',
        shape: { panes: [], tabs: [] },
      })
      expect(activeTabId(next)).toBe('bbb')
      expect(next.panes.map((p) => p.id)).toEqual(['aaa', 'bbb', 'ccc'])
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
