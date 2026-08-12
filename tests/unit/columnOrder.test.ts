import { describe, it, expect } from 'vitest'
import {
  COLUMN_ORDER_DEFAULT,
  moveColumn,
  orderFromStored,
  resizerSideFor,
  type ColumnSlot,
} from '../../src/renderer/lib/columnOrder'

/**
 * The row's left-to-right order, and the two things that follow from it.
 *
 * Pure, because `vitest.config.mts` runs `environment: 'node'` and logic that
 * lives inside a component cannot be unit-tested here at all. The drag that
 * calls `moveColumn` and the render that reads `resizerSideFor` belong to a
 * component and an end-to-end spec still to come, not to this file.
 *
 * Sabotage-checked (2026-08-09), each mutation applied and reverted by hand:
 * 1. dropped the `id === 'projects'` guard in `moveColumn`: reddened "refuses
 *    to move projects", as expected.
 * 2. dropped the insertion loop in `orderFromStored`: reddened "inserts a
 *    column the stored order never heard of beside its default neighbour" and
 *    both "puts X back" tests, as expected. Re-run 2026-08-12, when that loop
 *    stopped appending and started inserting: the same deletion now reddens
 *    eight tests, every one of them about a slot the stored order does not
 *    name, and leaves the other twenty green.
 * 3. dropped the `seen.has` skip in `orderFromStored`: reddened "collapses a
 *    duplicated slot", as expected.
 * 4. `resizerSideFor` hardcoded to `'right'`: reddened "says left for a
 *    column left of the terminal" and "flips when a column is moved across",
 *    as expected.
 * 5. dropped the `known.has` check in `orderFromStored`: reddened "drops an
 *    id the app does not know", as expected.
 * All five landed on exactly the named test(s); none left the suite green.
 */

describe('COLUMN_ORDER_DEFAULT', () => {
  it('is the row as it stands before anyone drags anything', () => {
    expect(COLUMN_ORDER_DEFAULT).toEqual([
      'files', 'projects', 'tabs', 'terminal', 'browser', 'skills', 'presets', 'prompts', 'git', 'issues',
      'notes', 'todos',
    ])
  })

  it('places issues next to git in the default order', () => {
    const git = COLUMN_ORDER_DEFAULT.indexOf('git')
    const issues = COLUMN_ORDER_DEFAULT.indexOf('issues')
    expect(issues).toBeGreaterThan(-1)
    expect(Math.abs(issues - git)).toBe(1)
  })

  it('puts the browser region straight after the terminal by default', () => {
    const order = [...COLUMN_ORDER_DEFAULT]
    expect(order[order.indexOf('terminal') + 1]).toBe('browser')
  })

  // The upgrade path. Every profile on disk was written before this column
  // existed, and `orderFromStored` puts back what a stored list never
  // mentions, at the place this default order gives it.
  it('gains the browser slot from an order written before it existed', () => {
    const stored = JSON.stringify(COLUMN_ORDER_DEFAULT.filter((slot) => slot !== 'browser'))
    expect(orderFromStored(stored)).toContain('browser')
  })
})

describe('orderFromStored', () => {
  it('is the default when nothing is stored', () => {
    expect(orderFromStored(null)).toEqual([...COLUMN_ORDER_DEFAULT])
  })

  it('is the default when the entry is not parseable', () => {
    expect(orderFromStored('{oh no')).toEqual([...COLUMN_ORDER_DEFAULT])
  })

  it('is the default when the entry parses to something that is not an array', () => {
    expect(orderFromStored('"notes"')).toEqual([...COLUMN_ORDER_DEFAULT])
    expect(orderFromStored('{"0":"notes"}')).toEqual([...COLUMN_ORDER_DEFAULT])
  })

  it('keeps a stored order the app fully recognises', () => {
    const stored: ColumnSlot[] = [
      'notes', 'files', 'projects', 'tabs', 'terminal', 'browser', 'skills', 'presets', 'prompts', 'git',
      'issues', 'todos',
    ]
    expect(orderFromStored(JSON.stringify(stored))).toEqual(stored)
  })

  it('drops an id the app does not know', () => {
    const stored = ['files', 'wallpaper', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'notes']
    expect(orderFromStored(JSON.stringify(stored))).not.toContain('wallpaper')
  })

  it('inserts a column the stored order never heard of beside its default neighbour', () => {
    // The upgrade case: a profile written before a column existed must pick it
    // up rather than lose it, and pick it up where the default order says it
    // belongs. Everything missing here lands right of whichever default-order
    // neighbour the profile did store: `todos` follows `notes` to the front,
    // and `browser` follows `terminal`, so neither ends up at the far right
    // simply for being new.
    const stored: ColumnSlot[] = ['notes', 'projects', 'terminal']
    expect(orderFromStored(JSON.stringify(stored))).toEqual([
      'files', 'notes', 'todos', 'projects', 'tabs', 'terminal', 'browser', 'skills', 'presets', 'prompts',
      'git', 'issues',
    ])
  })

  it('gives todos its default place, not the end, for a profile written before the column existed', () => {
    // The same profile the previous rule shipped with, plus one drag. It is
    // the drag that makes this test able to tell the rules apart: appending
    // would put `todos` after `issues`, and its default place is beside
    // `notes`, which this user moved to the front.
    const stored = JSON.stringify(['notes', 'files', 'projects', 'tabs', 'terminal', 'browser', 'skills', 'presets', 'prompts', 'git', 'issues'])
    expect(orderFromStored(stored)).toEqual([
      'notes', 'todos', 'files', 'projects', 'tabs', 'terminal', 'browser', 'skills', 'presets', 'prompts',
      'git', 'issues',
    ])
  })

  it('gives the browser column the place beside the terminal on a profile that had dragged one', () => {
    // Why the rule changed. This is every profile that ever dragged a column:
    // it stored a complete order, and the column added since is the one thing
    // it cannot name. Beside the terminal is the whole point of this column,
    // and an append would have put it past `todos` at the far right.
    const stored = ['notes', 'files', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'issues', 'todos']
    const order = orderFromStored(JSON.stringify(stored))
    expect(order[order.indexOf('terminal') + 1]).toBe('browser')
    expect(order[order.length - 1]).toBe('todos')
  })

  it('puts a missing leftmost slot at the front, the one case with nothing to its left to sit beside', () => {
    // The insertion point is "right of the nearest default-order slot already
    // present", and `files` leads `COLUMN_ORDER_DEFAULT`, so for it alone
    // there is no such slot. The front is the answer, which is where the
    // default order puts it anyway.
    const stored: ColumnSlot[] = ['notes', 'projects']
    expect(orderFromStored(JSON.stringify(stored))[0]).toBe('files')
  })

  it('keeps the relative order of the slots the profile did store', () => {
    // Inserting the missing ones must not reshuffle the stored ones: `todos`
    // stays ahead of `notes` here even though the default order disagrees.
    const stored: ColumnSlot[] = ['todos', 'notes']
    const order = orderFromStored(JSON.stringify(stored))
    expect(order.indexOf('todos')).toBeLessThan(order.indexOf('notes'))
    expect([...order].sort()).toEqual([...COLUMN_ORDER_DEFAULT].sort())
  })

  it('collapses a duplicated slot to its first appearance', () => {
    const stored = ['terminal', 'files', 'terminal', 'projects', 'tabs', 'skills', 'presets', 'prompts', 'git', 'notes']
    const order = orderFromStored(JSON.stringify(stored))
    expect(order.filter((slot) => slot === 'terminal')).toHaveLength(1)
    expect(order[0]).toBe('terminal')
  })

  it('puts the terminal back when a stored order has none, so no profile yields a window without one', () => {
    const stored: ColumnSlot[] = ['files', 'projects', 'tabs', 'skills', 'presets', 'prompts', 'git', 'notes']
    expect(orderFromStored(JSON.stringify(stored))).toContain('terminal')
  })

  it('puts projects back when a stored order has none', () => {
    const stored: ColumnSlot[] = ['files', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'notes']
    expect(orderFromStored(JSON.stringify(stored))).toContain('projects')
  })
})

describe('moveColumn', () => {
  it('moves a column to the index asked for', () => {
    const order: ColumnSlot[] = ['files', 'projects', 'tabs', 'terminal', 'notes']
    expect(moveColumn(order, 'notes', 0)).toEqual(['notes', 'files', 'projects', 'tabs', 'terminal'])
  })

  it('moves a column across the terminal', () => {
    const order: ColumnSlot[] = ['files', 'projects', 'tabs', 'terminal', 'notes']
    expect(moveColumn(order, 'notes', 2)).toEqual(['files', 'projects', 'notes', 'tabs', 'terminal'])
  })

  it('moves a column rightward, compensating for the shift removal causes', () => {
    // `gap(3)` is the sliver between `tabs` and `terminal`, read off the row
    // BEFORE `files` comes out of it. Post-removal that sliver is index 2,
    // not 3: this is the case the whole-branch review's Critical finding
    // named (dropping `files` just left of the terminal must not carry it
    // across), and it fails without the `toIndex > from` compensation in
    // `moveColumn`.
    const order: ColumnSlot[] = ['files', 'projects', 'tabs', 'terminal', 'notes']
    expect(moveColumn(order, 'files', 3)).toEqual(['projects', 'tabs', 'files', 'terminal', 'notes'])
  })

  it('is a no-op when dropped on the gap immediately to its own right', () => {
    // The sliver right of a column's current position is visually where the
    // column already sits, so this is the natural way to abandon a drag. In
    // pre-removal index space that sliver is `from + 1`; without the
    // rightward compensation this reads as a one-place shift instead of a
    // no-op.
    const order: ColumnSlot[] = ['files', 'projects', 'tabs', 'terminal', 'notes']
    expect(moveColumn(order, 'tabs', 3)).toEqual(order)
    expect(moveColumn(order, 'notes', 5)).toEqual(order)
  })

  it('refuses to move projects, and hands back the order it was given', () => {
    const order: ColumnSlot[] = ['files', 'projects', 'tabs', 'terminal', 'notes']
    expect(moveColumn(order, 'projects', 4)).toEqual(order)
  })

  it('is a no-op for a slot the order does not hold', () => {
    const order: ColumnSlot[] = ['files', 'projects', 'terminal']
    expect(moveColumn(order, 'notes', 0)).toEqual(order)
  })

  it('does not mutate the array it was given', () => {
    const order: ColumnSlot[] = ['files', 'projects', 'tabs', 'terminal', 'notes']
    const before = [...order]
    moveColumn(order, 'notes', 0)
    expect(order).toEqual(before)
  })
})

describe('resizerSideFor', () => {
  it('says left for a column left of the terminal, so its handle goes on its right', () => {
    expect(resizerSideFor(COLUMN_ORDER_DEFAULT, 'files')).toBe('left')
    expect(resizerSideFor(COLUMN_ORDER_DEFAULT, 'tabs')).toBe('left')
  })

  it('says right for a column right of the terminal', () => {
    expect(resizerSideFor(COLUMN_ORDER_DEFAULT, 'notes')).toBe('right')
    expect(resizerSideFor(COLUMN_ORDER_DEFAULT, 'skills')).toBe('right')
  })

  it('flips when a column is moved across the terminal', () => {
    // The whole reason this function exists: crossing the terminal has to move
    // the grab handle to the column's other edge, or the user drags a strip
    // that is no longer against the terminal.
    const moved = moveColumn(COLUMN_ORDER_DEFAULT, 'notes', 0)
    expect(resizerSideFor(COLUMN_ORDER_DEFAULT, 'notes')).toBe('right')
    expect(resizerSideFor(moved, 'notes')).toBe('left')
  })

  it('says right for a column the order does not hold, rather than throwing', () => {
    expect(resizerSideFor(['projects', 'terminal'], 'notes')).toBe('right')
  })
})
