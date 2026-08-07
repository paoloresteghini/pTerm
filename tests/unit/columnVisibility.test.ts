import { describe, expect, it } from 'vitest'
import {
  COLUMN_IDS,
  anyOpen,
  hideAll,
  restore,
  type ColumnVisibility,
} from '../../src/renderer/lib/columnVisibility'

/** Every column collapsed, which is what a fresh profile looks like. */
const ALL_SHUT: ColumnVisibility = {
  files: true,
  skills: true,
  presets: true,
  prompts: true,
  notes: true,
  git: true,
}

const withOpen = (...open: Array<keyof ColumnVisibility>): ColumnVisibility => {
  const next = { ...ALL_SHUT }
  for (const id of open) next[id] = false
  return next
}

describe('COLUMN_IDS', () => {
  it('lists the six columns in on-screen order', () => {
    expect(COLUMN_IDS).toEqual(['files', 'skills', 'presets', 'prompts', 'notes', 'git'])
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
    const { remembered } = hideAll(withOpen('git', 'files'))
    expect(remembered).toEqual(['files', 'git'])
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
