import { describe, expect, it } from 'vitest'
import {
  COLUMN_IDS,
  anyOpen,
  hideAll,
  restore,
  showsTabBar,
  type ColumnId,
  type ColumnVisibility,
} from '../../src/renderer/lib/columnVisibility'

/** Every column collapsed, which is what a fresh profile looks like. */
const ALL_SHUT: ColumnVisibility = {
  tabs: true,
  files: true,
  skills: true,
  presets: true,
  prompts: true,
  notes: true,
  git: true,
  issues: true,
  todos: true,
  browser: true,
}

const withOpen = (...open: Array<keyof ColumnVisibility>): ColumnVisibility => {
  const next = { ...ALL_SHUT }
  for (const id of open) next[id] = false
  return next
}

describe('COLUMN_IDS', () => {
  it('lists the ten columns in on-screen order', () => {
    // `tabs` leads because the column sits leftmost, immediately right of the
    // projects sidebar, and this array is documented as on-screen order.
    expect(COLUMN_IDS).toEqual([
      'tabs', 'files', 'browser', 'skills', 'presets', 'prompts', 'git', 'issues', 'notes', 'todos',
    ])
  })

  // Membership is what puts this column under hide-all and its `restore`,
  // which is the only route a user has to hiding it: it has no View menu item
  // and no shortcut of its own.
  it('lists the browser column', () => {
    expect(COLUMN_IDS).toContain('browser')
  })
})

describe('anyOpen', () => {
  it('is false when every column is collapsed', () => {
    expect(anyOpen(ALL_SHUT)).toBe(false)
  })

  it('is true when one column is open', () => {
    expect(anyOpen(withOpen('git'))).toBe(true)
  })
})

describe('hideAll', () => {
  it('closes everything and remembers what was open', () => {
    const { next, remembered } = hideAll(withOpen('files', 'git'))
    expect(next).toEqual(ALL_SHUT)
    expect(remembered).toEqual(['files', 'git'])
  })

  it('remembers in on-screen order, not the order they were opened', () => {
    // Insertion order deliberately reversed, so a `Object.keys(state)` walk
    // would return ['git', 'files'] and this would fail. `withOpen` cannot
    // show that: it always spreads `ALL_SHUT`, so its insertion order is
    // always `COLUMN_IDS` order regardless of which columns end up open.
    const opened: ColumnVisibility = {
      git: false,
      notes: true,
      prompts: true,
      presets: true,
      skills: true,
      files: false,
      tabs: true,
      issues: true,
      todos: true,
      browser: true,
    }
    expect(hideAll(opened).remembered).toEqual(['files', 'git'])
  })

  it('remembers a single open column', () => {
    expect(hideAll(withOpen('notes')).remembered).toEqual(['notes'])
  })

  it('remembers nothing when nothing was open', () => {
    const { next, remembered } = hideAll(ALL_SHUT)
    expect(remembered).toEqual([])
    expect(next).toEqual(ALL_SHUT)
  })
})

describe('restore', () => {
  it('reopens exactly the remembered set and nothing else', () => {
    expect(restore(ALL_SHUT, ['files', 'git'])).toEqual(withOpen('files', 'git'))
  })

  // The fresh-profile case: pressing the item with nothing open and nothing
  // remembered must not invent a default.
  it('changes nothing when nothing is remembered', () => {
    expect(restore(ALL_SHUT, [])).toEqual(ALL_SHUT)
  })

  it('leaves an already-open column open', () => {
    expect(restore(withOpen('notes'), ['notes'])).toEqual(withOpen('notes'))
  })
})

describe('the round trip', () => {
  it('returns the exact starting state', () => {
    const start = withOpen('skills', 'prompts', 'notes')
    const { next, remembered } = hideAll(start)
    expect(restore(next, remembered)).toEqual(start)
  })
})

describe('showsTabBar', () => {
  const allCollapsed: ColumnVisibility = {
    tabs: true, files: true, skills: true, presets: true, prompts: true, git: true, issues: true, notes: true,
    todos: true, browser: true,
  }
  const noneHidden: Record<ColumnId, boolean> = {
    tabs: false, files: false, skills: false, presets: false, prompts: false, git: false, issues: false, notes: false,
    todos: false, browser: false,
  }

  it('shows the bar when the tabs column is collapsed to its strip', () => {
    expect(showsTabBar(allCollapsed, noneHidden)).toBe(true)
  })

  it('shows the bar when the tabs column is hidden outright', () => {
    expect(showsTabBar({ ...allCollapsed, tabs: false }, { ...noneHidden, tabs: true })).toBe(true)
  })

  it('hides the bar only when the tabs column is fully open', () => {
    expect(showsTabBar({ ...allCollapsed, tabs: false }, noneHidden)).toBe(false)
  })

  it('ignores every other column', () => {
    // The tabs column is open, so the bar must stand down, and it must stand
    // down no matter what the other columns are doing. Every one of them is
    // open here too, which is what makes this test able to fail: a predicate
    // that asked "is any column open" would answer true and show the bar, where
    // the right answer is false. An earlier version had the tabs column
    // COLLAPSED with the others open, where both readings answer true and the
    // test could not tell them apart.
    const alsoOpen: ColumnVisibility = {
      tabs: false, files: false, skills: false, presets: false,
      prompts: false, git: false, issues: false, notes: false, todos: false, browser: false,
    }
    expect(showsTabBar(alsoOpen, noneHidden)).toBe(false)
  })
})
