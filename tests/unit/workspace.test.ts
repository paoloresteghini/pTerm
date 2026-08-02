import { describe, it, expect } from 'vitest'
import {
  INITIAL_WORKSPACE_STATE,
  workspaceReducer,
  neighbourOf,
  projectIdForTab,
  tabsOfProject,
  activeProject,
  activeTabId,
  stateOfPane,
  stateOfTab,
  stateOfProject,
  needsYou,
  paneGroups,
  paneInDirection,
  panesOfTab,
  tabOfPane,
  minRatioFor,
  resizeKids,
  type WorkspaceState,
} from '../../src/renderer/workspace'
import {
  UNSORTED_ID,
  type ProjectDescriptor,
  type TabDescriptor,
  type TabRow,
} from '../../src/shared/ipc'
import { SEVERITY, type TabState } from '../../src/shared/status'

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

/** A row with explicit ratios, for the cases `tabRow`'s even split cannot show. */
function ratioRow(id: string, kids: string[], ratio: number[], dir: 'row' | 'col' = 'row'): TabRow {
  return { id, groupId: id, activePaneId: kids[0] ?? null, layout: { dir, ratio, kids } }
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

/**
 * A pane whose session has died, as the layout presents it.
 *
 * The rule is the opposite of restore's, and both are right. `restoreWorkspace`
 * prunes a pane tmux no longer has — `tabRowFor` is never given it — because a
 * pane missing at launch has no window, no xterm and no scrollback: there is
 * nothing to show and nowhere to show it. A pane that died *in this session*
 * still has all three, and its scrollback is the only record of why it died, so
 * it keeps its box and its share and is marked instead.
 */
describe('a dead pane', () => {
  /** Panes 'aaa', 'bbb', 'ccc' in one uneven tab, with 'bbb' dead. */
  const split: WorkspaceState = {
    ...three,
    // Uneven on purpose. Every ratio this app writes today is even —
    // `splitPane` re-evens on every split and nothing else edits them until
    // 2c's drag-resize — so an even fixture cannot tell "the survivors kept
    // their shares" apart from "the survivors were re-evened". These can.
    tabs: [ratioRow('aaa', ['aaa', 'bbb', 'ccc'], [0.5, 0.25, 0.25])],
    projects: [project('p1', 'lumio', 'aaa')],
    dead: { bbb: 0 },
  }

  it('keeps its box, in its slot, and leaves its siblings the shares they had', () => {
    const group = paneGroups(split).find((candidate) => candidate.id === 'aaa')
    expect(group?.panes.map((box) => box.pane.id)).toEqual(['aaa', 'bbb', 'ccc'])
    // Not just "three boxes": the dead pane's own share is still its own, and
    // neither neighbour has grown into it.
    expect(group?.panes.map((box) => box.style.flexBasis)).toEqual(['50%', '25%', '25%'])
  })

  it('is the only box the layout marks dead', () => {
    const group = paneGroups(split).find((candidate) => candidate.id === 'aaa')
    expect(group?.panes).toHaveLength(3)
    expect(group?.panes.map((box) => box.dead)).toEqual([false, true, false])
  })

  it('is marked when it is a tab of its own, which is every unsplit tab', () => {
    // `three` has no rows at all, so every pane goes down the branch that
    // boxes a pane no row names — the shape of every tab opened this run that
    // has never been split, and the shape the tab bar's own ↻ answers for.
    const groups = paneGroups({ ...three, dead: { bbb: 0 } })
    expect(groups).not.toHaveLength(0)
    expect(groups.map((group) => group.panes.map((box) => box.dead))).toEqual([
      [false],
      [true],
      [false],
    ])
  })

  it('comes back live, in the same slot with the same share, when it is restarted', () => {
    // What `restartTab` dispatches: main hands back the pane's record and the
    // renderer folds it in through `opened`. Membership and ratios live on the
    // tab row, which a restart does not touch, so the pane returns where it was.
    const after = workspaceReducer(split, { type: 'opened', tab: tab('bbb') })
    const group = paneGroups(after).find((candidate) => candidate.id === 'aaa')
    expect(group?.panes.map((box) => box.pane.id)).toEqual(['aaa', 'bbb', 'ccc'])
    expect(group?.panes.map((box) => box.style.flexBasis)).toEqual(['50%', '25%', '25%'])
    // And the mark goes with it: `opened` drops the tombstone, so the chrome
    // that offered Restart is gone rather than left over a live pane.
    expect(group?.panes.map((box) => box.dead)).toEqual([false, false, false])
  })

  it('gives its share back to its siblings when it is dismissed', () => {
    const after = workspaceReducer(split, { type: 'dismissed', id: 'bbb' })
    const group = paneGroups(after).find((candidate) => candidate.id === 'aaa')
    // The row still names 'bbb' — nothing in the renderer rewrites `kids` on a
    // dismiss, and main has already dropped the pane row on disk. `boxesOfRow`
    // drops the kid whose pane has gone and renormalises what is left, which
    // is where the 0.25 actually goes: 0.5 and 0.25 of 0.75.
    expect(after.tabs[0]?.layout.kids).toEqual(['aaa', 'bbb', 'ccc'])
    expect(group?.panes.map((box) => box.pane.id)).toEqual(['aaa', 'ccc'])
    expect(group?.panes.map((box) => box.style.flexBasis)).toEqual(['66.6667%', '33.3333%'])
  })
})

/**
 * What a tab's dot says, and what a project's says over it.
 *
 * The failure these exist to prevent: a split tab whose second pane has
 * crashed, reported by whichever single pane happens to answer for the tab.
 * On a tool whose whole job is saying which of a dozen sessions needs a human,
 * a green dot over a crash is worse than no dot at all.
 */
describe("a tab's dot", () => {
  /** One project: a split tab (aaa + bbb) and an unsplit one (ccc). */
  const splitTab: WorkspaceState = {
    projects: [project('p1', 'lumio', 'aaa')],
    panes: [tab('aaa'), tab('bbb'), tab('ccc')],
    tabs: [tabRow('aaa', ['aaa', 'bbb'])],
    activeProjectId: 'p1',
    status: {},
    dead: {},
  }

  function withStatus(state: WorkspaceState, status: Record<string, TabState>): WorkspaceState {
    return { ...state, status }
  }

  it('is the worst of its panes, not the founder\'s', () => {
    const state = withStatus(splitTab, { aaa: 'idle', bbb: 'crashed' })
    // The pane list first, always. `worst([])` is null and `[].every()` is
    // true, so a fold over nothing passes almost any assertion by accident —
    // and a tab whose panes had gone missing is exactly how that would happen.
    expect(panesOfTab(state, 'aaa').map((pane) => pane.id)).toEqual(['aaa', 'bbb'])
    expect(stateOfTab(state, 'aaa')).toBe('crashed')
  })

  it('does not care which pane holds the worse state', () => {
    const state = withStatus(splitTab, { aaa: 'crashed', bbb: 'idle' })
    expect(panesOfTab(state, 'aaa')).toHaveLength(2)
    expect(stateOfTab(state, 'aaa')).toBe('crashed')
  })

  // Every pair that could invert, in both arrangements, rather than the two or
  // three a hand-written list would reach for: any fold that disagrees with
  // `SEVERITY` anywhere disagrees on some pair, and the pair it disagrees on is
  // not knowable in advance. `waiting` beside `running` is in here, and so is
  // every other ordering the dock badge already counts on.
  it('ranks every pair of states the way SEVERITY does, whichever pane holds which', () => {
    expect(SEVERITY.length).toBeGreaterThan(1)
    for (const [index, worse] of SEVERITY.entries()) {
      for (const better of SEVERITY.slice(index + 1)) {
        const founderWorse = withStatus(splitTab, { aaa: worse, bbb: better })
        const siblingWorse = withStatus(splitTab, { aaa: better, bbb: worse })
        expect(panesOfTab(founderWorse, 'aaa')).toHaveLength(2)
        expect(stateOfTab(founderWorse, 'aaa')).toBe(worse)
        expect(stateOfTab(siblingWorse, 'aaa')).toBe(worse)
      }
    }
  })

  it('is unknown when every pane is unknown, rather than no dot at all', () => {
    // The distinction `worst` is built around: null means "nothing to report",
    // `unknown` means "this should have a state and does not". A tab of panes
    // that have all said `unknown` has plenty to report.
    const state = withStatus(splitTab, { aaa: 'unknown', bbb: 'unknown' })
    expect(panesOfTab(state, 'aaa')).toHaveLength(2)
    expect(stateOfTab(state, 'aaa')).toBe('unknown')
  })

  it('draws no dot when no pane of it has a state', () => {
    expect(panesOfTab(splitTab, 'aaa')).toHaveLength(2)
    expect(stateOfTab(splitTab, 'aaa')).toBeNull()
  })

  it('reads only its own panes', () => {
    const state = withStatus(splitTab, { aaa: 'idle', bbb: 'idle', ccc: 'crashed' })
    expect(panesOfTab(state, 'aaa').map((pane) => pane.id)).toEqual(['aaa', 'bbb'])
    expect(stateOfTab(state, 'aaa')).toBe('idle')
  })

  it('treats a pane no row names as the tab of one that it is', () => {
    // The same dichotomy `paneGroups` draws: every pane opened this run and
    // never split has no row at all, and is its own group keyed by its own id.
    const state = withStatus(splitTab, { ccc: 'waiting' })
    expect(panesOfTab(state, 'ccc')).toHaveLength(0)
    expect(state.panes.some((pane) => pane.id === 'ccc')).toBe(true)
    expect(stateOfTab(state, 'ccc')).toBe('waiting')
  })

  it('has nothing to say about an id that names neither a tab nor a pane', () => {
    const state = withStatus(splitTab, { aaa: 'crashed' })
    expect(stateOfTab(state, 'zzz')).toBeNull()
  })

  it('takes a dead pane\'s state from status, never from the tombstone', () => {
    // `state.dead` holds the ATTACH CLIENT's exit code, which is 0 however the
    // pane died — see `PaneBox.dead`. What killed a pane is read off tmux's own
    // `pane_dead_status` and arrives in `state.status`. Folding deadness into
    // the severity rule would paint a tab red over a pane that is merely idle.
    const state = { ...withStatus(splitTab, { aaa: 'idle', bbb: 'idle' }), dead: { bbb: 0 } }
    expect(panesOfTab(state, 'aaa')).toHaveLength(2)
    expect(stateOfTab(state, 'aaa')).toBe('idle')
  })

  it('carries the whole way up: a project row is the worst of its tabs', () => {
    const state = withStatus(splitTab, { aaa: 'idle', bbb: 'crashed', ccc: 'waiting' })
    // Both levels, side by side, so the two rules cannot drift: the tab dots
    // first, then the row that must be the worst of them.
    expect(tabsOfProject(state, 'p1')).toHaveLength(3)
    expect([stateOfTab(state, 'aaa'), stateOfTab(state, 'ccc')]).toEqual(['crashed', 'waiting'])
    expect(stateOfProject(state, 'p1')).toBe('crashed')
  })

  it('leaves a project row unknown when that is all its tabs have to say', () => {
    const state = withStatus(splitTab, { aaa: 'unknown', bbb: 'unknown', ccc: 'unknown' })
    expect(tabsOfProject(state, 'p1')).toHaveLength(3)
    expect(stateOfProject(state, 'p1')).toBe('unknown')
  })

  it('reports a pane\'s own state on its own, which is what the tab bar draws', () => {
    // The tab bar lists PANES, one entry each, so its dots are per-pane and
    // stay that way. This is the accessor for that, kept separate from the
    // fold above rather than answering both questions through one name.
    const state = withStatus(splitTab, { aaa: 'idle', bbb: 'crashed' })
    expect(stateOfPane(state, 'aaa')).toBe('idle')
    expect(stateOfPane(state, 'bbb')).toBe('crashed')
    expect(stateOfPane(state, 'ccc')).toBeNull()
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
    expect(stateOfPane(next, 'aaa')).toBe('waiting')
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

    expect(stateOfPane(next, 'aaa')).toBe('waiting')
    expect(stateOfPane(next, 'bbb')).toBe('thinking')
  })

  // I3: `registry.forget` now emits a transition to `null` — dismissed, or
  // killed on purpose — over the wire as `statusChanged`'s `state`. Storing
  // that as a value would let it slip into the fold behind every dot above a
  // pane (`stateOfTab` filters the statuses it reads on `undefined`, not
  // `null`) and sit in `state.status` forever, so a null clears the key
  // instead of setting it.
  it('drops the key on a null statusChanged, rather than storing null', () => {
    const seeded = workspaceReducer(three, {
      type: 'statusSnapshot',
      status: { aaa: 'waiting', bbb: 'thinking' },
    })

    const next = workspaceReducer(seeded, { type: 'statusChanged', tabId: 'aaa', state: null })

    expect(stateOfPane(next, 'aaa')).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(next.status, 'aaa')).toBe(false)
    expect(stateOfPane(next, 'bbb')).toBe('thinking')
  })

  it('has no state for a tab nothing has said anything about', () => {
    expect(stateOfPane(three, 'aaa')).toBeNull()
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

    expect(stateOfPane(next, 'aaa')).toBeNull()
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

/**
 * A tombstone across a split or a close of one of its siblings.
 *
 * The one transition the dead-pane ruling was never tested over, and the seam
 * where two correct rules met and produced a defect. Main forgets a pane at its
 * death, so a `TabShape` reply names only panes that are on disk; the renderer
 * keeps the tombstone. Taking the reply's `kids` wholesale threw the tombstone
 * out of its tab — and when the tombstone was the tab's FOUNDER, its id was the
 * row's id too, so `paneGroups` skipped the group the second time it saw that id
 * and every LIVE pane of the tab lost its box.
 *
 * Every fixture below puts the founder first in `state.panes`, which is the
 * order restore and `applyTabShape` both produce, and is the order in which the
 * live panes were the ones dropped. The reverse order dropped the tombstone
 * instead; `both orderings` covers it explicitly rather than trusting that one
 * implies the other.
 */
describe('a tombstone when its tab is split or closed', () => {
  /** Tab `aaa` founded the tab and has died; `bbb` is live beside it. */
  const deadFounder: WorkspaceState = {
    projects: [project('p1', 'lumio', 'bbb')],
    panes: [tab('aaa'), tab('bbb')],
    tabs: [ratioRow('aaa', ['aaa', 'bbb'], [0.5, 0.5])],
    activeProjectId: 'p1',
    status: { aaa: 'crashed', bbb: 'idle' },
    dead: { aaa: 0 },
  }

  /** What main sends back: the founder is not on disk, so it is not named. */
  const splitReply = {
    panes: [tab('bbb'), tab('ccc')],
    tabs: [ratioRow('aaa', ['bbb', 'ccc'], [0.5, 0.5])],
  }

  it('keeps every live pane boxed when the dead pane is the founder', () => {
    const next = workspaceReducer(deadFounder, { type: 'split', shape: splitReply })
    const groups = paneGroups(next)
    expect(groups).not.toHaveLength(0)
    const boxed = groups.flatMap((group) => group.panes.map((box) => box.pane.id))
    // The failure this exists for: `bbb` and `ccc` were skipped entirely,
    // unmounting two live xterms and destroying their scrollback.
    expect(boxed).toContain('bbb')
    expect(boxed).toContain('ccc')
    expect(boxed).toContain('aaa')
    // And still exactly one box each — the merge must not double any of them.
    expect(boxed).toHaveLength(3)
  })

  it('keeps the tombstone in its own tab rather than making it a group of its own', () => {
    const next = workspaceReducer(deadFounder, { type: 'split', shape: splitReply })
    const groups = paneGroups(next)
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('aaa')
    expect(groups[0].panes.map((box) => box.pane.id)).toEqual(['aaa', 'bbb', 'ccc'])
    // Its slot, not merely its presence: the dead pane was first and stays first.
    expect(groups[0].panes[0].dead).toBe(true)
  })

  it('keeps the tombstone its share, and leaves the row summing to a whole tab', () => {
    const next = workspaceReducer(deadFounder, { type: 'split', shape: splitReply })
    const row = next.tabs.find((candidate) => candidate.id === 'aaa')
    expect(row).toBeDefined()
    expect(row?.layout.kids).toEqual(['aaa', 'bbb', 'ccc'])
    const ratio = row?.layout.ratio ?? []
    expect(ratio).toHaveLength(3)
    expect(ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
    // The dead pane keeps the half it had EXACTLY; the two panes main sized
    // divide the other half between them in the proportions it asked for.
    // Renormalising all three alike instead gave the tombstone a third of the
    // tab — the dead pane resizing, which is what the ruling forbids.
    expect(ratio[0]).toBeCloseTo(0.5)
    expect(ratio[1]).toBeCloseTo(0.25)
    expect(ratio[2]).toBeCloseTo(0.25)
  })

  it('still reports the crashed pane in the tab and project dots', () => {
    const next = workspaceReducer(deadFounder, { type: 'split', shape: splitReply })
    const withStatus: WorkspaceState = {
      ...next,
      status: { ...next.status, ccc: 'idle' },
    }
    // Task 8's whole premise. Dropping the tombstone from the row took its
    // `crashed` out of both folds, turning the tab and the sidebar's project row
    // green while `TabBar` went on drawing that same pane's own dot red.
    expect(stateOfTab(withStatus, 'aaa')).toBe('crashed')
    expect(stateOfProject(withStatus, 'p1')).toBe('crashed')
  })

  it('drops neither side in either order of state.panes', () => {
    for (const panes of [
      [tab('aaa'), tab('bbb')],
      [tab('bbb'), tab('aaa')],
    ]) {
      const next = workspaceReducer({ ...deadFounder, panes }, { type: 'split', shape: splitReply })
      const boxed = paneGroups(next).flatMap((group) => group.panes.map((box) => box.pane.id))
      expect(boxed).toHaveLength(3)
      for (const id of ['aaa', 'bbb', 'ccc']) expect(boxed).toContain(id)
    }
  })

  it('keeps the tombstone when a sibling is closed', () => {
    const state: WorkspaceState = {
      ...deadFounder,
      panes: [tab('aaa'), tab('bbb'), tab('ccc')],
      tabs: [ratioRow('aaa', ['aaa', 'bbb', 'ccc'], [0.5, 0.25, 0.25])],
      status: { aaa: 'crashed', bbb: 'idle', ccc: 'idle' },
    }
    const next = workspaceReducer(state, {
      type: 'closedPane',
      paneId: 'ccc',
      shape: { panes: [tab('bbb')], tabs: [ratioRow('aaa', ['bbb'], [1])] },
    })
    const row = next.tabs.find((candidate) => candidate.id === 'aaa')
    expect(row?.layout.kids).toEqual(['aaa', 'bbb'])
    expect(row?.layout.ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
    // The closed pane is gone and does not come back through the merge.
    expect(next.panes.map((pane) => pane.id)).toEqual(['aaa', 'bbb'])
    expect(stateOfTab(next, 'aaa')).toBe('crashed')
  })

  it('leaves the tombstone reachable when the last live pane closes', () => {
    const next = workspaceReducer(deadFounder, {
      type: 'closedPane',
      paneId: 'bbb',
      shape: { panes: [], tabs: [] },
    })
    // The tab is gone, so the row goes with it — and the tombstone's id is no
    // longer shared with any row, which is what makes a group of its own safe.
    expect(next.tabs).toHaveLength(0)
    const groups = paneGroups(next)
    expect(groups).toHaveLength(1)
    expect(groups[0].panes.map((box) => box.pane.id)).toEqual(['aaa'])
    expect(groups[0].panes[0].dead).toBe(true)
  })

  it('leaves the new pane beside the pane it was split from', () => {
    // Main inserts a new pane directly after the sibling it was split from, and
    // has a dedicated test for it. Putting a tombstone back at its old ABSOLUTE
    // index breaks that silently — `[aaa, bbb(dead), ccc]` split at `aaa` gave
    // `[aaa, bbb, new, ccc]`, a dead pane wedged between the two halves of the
    // split just asked for. Anchoring on the successor keeps both properties.
    const state: WorkspaceState = {
      ...deadFounder,
      panes: [tab('aaa'), tab('bbb'), tab('ccc')],
      tabs: [ratioRow('aaa', ['aaa', 'bbb', 'ccc'], [0.4, 0.2, 0.4])],
      status: { aaa: 'idle', bbb: 'crashed', ccc: 'idle' },
      dead: { bbb: 0 },
    }
    const next = workspaceReducer(state, {
      type: 'split',
      shape: {
        panes: [tab('aaa'), tab('new'), tab('ccc')],
        tabs: [ratioRow('aaa', ['aaa', 'new', 'ccc'], [1 / 3, 1 / 3, 1 / 3])],
      },
    })
    const kids = next.tabs.find((candidate) => candidate.id === 'aaa')?.layout.kids
    expect(kids).toEqual(['aaa', 'new', 'bbb', 'ccc'])
    // The tombstone is still between the two panes it was between, and still
    // holds the fifth of the tab it held.
    const ratio = next.tabs.find((candidate) => candidate.id === 'aaa')?.layout.ratio ?? []
    expect(ratio[kids?.indexOf('bbb') ?? -1]).toBeCloseTo(0.2)
    expect(ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  it('keeps a tombstone that was before the split pane where it was', () => {
    // The control for the case above, so the boundary is pinned from both
    // sides rather than only where it moved.
    const state: WorkspaceState = {
      ...deadFounder,
      panes: [tab('zzz'), tab('aaa'), tab('ccc')],
      tabs: [ratioRow('zzz', ['zzz', 'aaa', 'ccc'], [0.2, 0.4, 0.4])],
      status: { zzz: 'crashed', aaa: 'idle', ccc: 'idle' },
      dead: { zzz: 0 },
    }
    const next = workspaceReducer(state, {
      type: 'split',
      shape: {
        panes: [tab('aaa'), tab('new'), tab('ccc')],
        tabs: [ratioRow('zzz', ['aaa', 'new', 'ccc'], [1 / 3, 1 / 3, 1 / 3])],
      },
    })
    expect(next.tabs.find((candidate) => candidate.id === 'zzz')?.layout.kids).toEqual([
      'zzz',
      'aaa',
      'new',
      'ccc',
    ])
  })

  it('keeps two tombstones in one tab, in order and at their own shares', () => {
    // A run of tombstones has to come back in its original order, which is what
    // anchoring each on the first SURVIVING successor buys — each anchors on the
    // one after it once that has been placed.
    const state: WorkspaceState = {
      ...deadFounder,
      panes: [tab('aaa'), tab('bbb'), tab('ccc')],
      tabs: [ratioRow('aaa', ['aaa', 'bbb', 'ccc'], [0.5, 0.25, 0.25])],
      status: { aaa: 'crashed', bbb: 'ended', ccc: 'idle' },
      dead: { aaa: 0, bbb: 0 },
    }
    const next = workspaceReducer(state, {
      type: 'split',
      shape: {
        panes: [tab('ccc'), tab('ddd')],
        tabs: [ratioRow('aaa', ['ccc', 'ddd'], [0.5, 0.5])],
      },
    })
    const row = next.tabs.find((candidate) => candidate.id === 'aaa')
    expect(row?.layout.kids).toEqual(['aaa', 'bbb', 'ccc', 'ddd'])
    const ratio = row?.layout.ratio ?? []
    expect(ratio).toHaveLength(4)
    // Both tombstones keep their shares exactly; the two live panes divide what
    // is left in the proportions main asked for. The even-split fallback would
    // resize both dead panes, which is what its own comment now says it costs.
    expect(ratio[0]).toBeCloseTo(0.5)
    expect(ratio[1]).toBeCloseTo(0.25)
    expect(ratio[2]).toBeCloseTo(0.125)
    expect(ratio[3]).toBeCloseTo(0.125)
    expect(ratio.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
  })

  it('lets a merged-back tombstone be restarted into its own slot', () => {
    const merged = workspaceReducer(deadFounder, { type: 'split', shape: splitReply })
    const next = workspaceReducer(merged, { type: 'opened', tab: tab('aaa') })
    const groups = paneGroups(next)
    expect(groups).toHaveLength(1)
    const boxes = groups[0].panes
    expect(boxes.map((box) => box.pane.id)).toEqual(['aaa', 'bbb', 'ccc'])
    // Alive again, in the slot it never left, still holding its own share.
    expect(boxes[0].dead).toBe(false)
    expect(boxes[0].style.flexBasis).toBe('50%')
  })

  it('lets a merged-back tombstone be dismissed, and renormalises what is left', () => {
    const merged = workspaceReducer(deadFounder, { type: 'split', shape: splitReply })
    const next = workspaceReducer(merged, { type: 'dismissed', id: 'aaa' })
    expect(next.panes.map((pane) => pane.id)).toEqual(['bbb', 'ccc'])
    const groups = paneGroups(next)
    expect(groups).toHaveLength(1)
    // The row still names the dismissed pane — nothing rewrites kids on a
    // dismiss — and `boxesOfRow` drops the kid whose pane has gone and shares
    // its ratio out, which is the path that already existed.
    expect(groups[0].panes.map((box) => box.pane.id)).toEqual(['bbb', 'ccc'])
    for (const box of groups[0].panes) expect(box.style.flexBasis).toBe('50%')
  })

  it('does not invent a kid for a pane that was never in the row', () => {
    // A pane in `state.panes` that the prior row never named — an `opened` tab
    // awaiting its first row — must not be swept into some other tab by the
    // merge. Only a kid the prior row itself held comes back.
    const state: WorkspaceState = { ...deadFounder, panes: [...deadFounder.panes, tab('zzz')] }
    const next = workspaceReducer(state, { type: 'split', shape: splitReply })
    expect(next.tabs.find((candidate) => candidate.id === 'aaa')?.layout.kids).toEqual([
      'aaa',
      'bbb',
      'ccc',
    ])
  })
})

describe('minRatioFor', () => {
  it('is the fraction of the axis those cells take', () => {
    expect(minRatioFor(20, 200)).toBeCloseTo(0.1)
  })

  it('never exceeds the whole tab', () => {
    // A window narrower than the floor itself. Returning >1 would make every
    // drag impossible AND make `resizeKids`' bounds cross on a tab that is
    // merely small, rather than on one that is genuinely squeezed.
    expect(minRatioFor(20, 10)).toBe(1)
  })

  it('answers 0 rather than Infinity for an unmeasured axis', () => {
    expect(minRatioFor(20, 0)).toBe(0)
  })
})

describe('resizeKids', () => {
  it('moves share from one kid to its neighbour and leaves the rest alone', () => {
    const next = resizeKids([0.25, 0.25, 0.5], 0, 0.1, 0.05, 0.05)
    expect(next).toEqual([0.35, 0.15, 0.5])
  })

  it('preserves the sum, with no renormalising', () => {
    const next = resizeKids([0.7, 0.3], 0, -0.2, 0.05, 0.05)
    expect(next.reduce((sum, share) => sum + share, 0)).toBeCloseTo(1)
    // Not `toEqual`: `0.7 - 0.2` is `0.49999999999999994` in IEEE 754, not
    // `0.5`. The property held here is that the sum is preserved BY
    // CONSTRUCTION — what one kid loses the other gains, with no rescale step
    // — which is exact algebraically and holds to within an ulp in floats.
    expect(next[0]).toBeCloseTo(0.5)
    expect(next[1]).toBeCloseTo(0.5)
  })

  it('clamps at the low kid’s floor', () => {
    const next = resizeKids([0.2, 0.8], 0, -0.5, 0.1, 0.1)
    expect(next[0]).toBeCloseTo(0.1)
    expect(next[1]).toBeCloseTo(0.9)
  })

  it('clamps at the high kid’s floor', () => {
    const next = resizeKids([0.2, 0.8], 0, 0.95, 0.1, 0.1)
    expect(next[0]).toBeCloseTo(0.9)
    expect(next[1]).toBeCloseTo(0.1)
  })

  it('lets a pane already below its floor be dragged back open', () => {
    // Ruling 4: a window resize can squeeze a pane through the floor. The
    // clamp is on the MOVEMENT, so the only moves refused are ones that make
    // it worse — opening it back up must still work.
    const next = resizeKids([0.02, 0.98], 0, 0.2, 0.1, 0.1)
    expect(next[0]).toBeCloseTo(0.22)
  })

  it('refuses to make a below-floor pane smaller', () => {
    const next = resizeKids([0.02, 0.98], 0, -0.01, 0.1, 0.1)
    expect(next).toEqual([0.02, 0.98])
  })

  it('does nothing when both kids are below their floors', () => {
    // Growing the low kid to its floor would take the high kid further below
    // its own, and the reverse is just as true — no move satisfies both
    // floors. Both bounds land on exactly 0, so the honest answer is no move
    // at all rather than whichever direction happened to win a comparison.
    const next = resizeKids([0.02, 0.03], 0, 0.5, 0.4, 0.4)
    expect(next).toEqual([0.02, 0.03])
  })

  it('returns the ratios unchanged when the index names no pair', () => {
    expect(resizeKids([0.5, 0.5], 1, 0.1, 0.1, 0.1)).toEqual([0.5, 0.5])
    expect(resizeKids([0.5, 0.5], -1, 0.1, 0.1, 0.1)).toEqual([0.5, 0.5])
  })
})
