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
 * 2. dropped the append loop in `orderFromStored`: reddened "appends a column
 *    the stored order never heard of" and both "puts X back" tests, as
 *    expected.
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
      'files', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'notes',
    ])
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
      'notes', 'files', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git',
    ]
    expect(orderFromStored(JSON.stringify(stored))).toEqual(stored)
  })

  it('drops an id the app does not know', () => {
    const stored = ['files', 'wallpaper', 'projects', 'tabs', 'terminal', 'skills', 'presets', 'prompts', 'git', 'notes']
    expect(orderFromStored(JSON.stringify(stored))).not.toContain('wallpaper')
  })

  it('appends a column the stored order never heard of, in default order', () => {
    // The upgrade case: a profile written before a column existed must pick it
    // up rather than lose it. Two missing at once, to pin that they arrive in
    // COLUMN_ORDER_DEFAULT's order and not in some incidental one.
    const stored: ColumnSlot[] = ['notes', 'projects', 'terminal']
    expect(orderFromStored(JSON.stringify(stored))).toEqual([
      'notes', 'projects', 'terminal', 'files', 'tabs', 'skills', 'presets', 'prompts', 'git',
    ])
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
