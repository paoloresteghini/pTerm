import { describe, it, expect } from 'vitest'
import { reorderById } from '../../src/shared/paneOrder'

const panes = (...ids: string[]): { id: string }[] => ids.map((id) => ({ id }))
const ids = (rows: { id: string }[]): string[] => rows.map((row) => row.id)

describe('reorderById', () => {
  it('puts the named entries in the order asked for', () => {
    expect(ids(reorderById(panes('a', 'b', 'c'), ['c', 'a', 'b']))).toEqual(['c', 'a', 'b'])
  })

  it('leaves entries it was not asked about at the index they already had', () => {
    // 'x' and 'y' belong to another project. Dragging within a's project must
    // not pull that project's run past them.
    const rows = panes('x', 'a', 'y', 'b', 'c')
    expect(ids(reorderById(rows, ['c', 'b', 'a']))).toEqual(['x', 'c', 'y', 'b', 'a'])
  })

  it('refuses to compact the named entries together', () => {
    const rows = panes('a', 'x', 'b')
    // The interesting half: 'x' stays in the middle. A splice-based reorder
    // would answer ['b', 'a', 'x'] or ['x', 'b', 'a'].
    expect(ids(reorderById(rows, ['b', 'a']))).toEqual(['b', 'x', 'a'])
  })

  it('ignores an id the array does not hold', () => {
    const rows = panes('a', 'b', 'c')
    expect(ids(reorderById(rows, ['c', 'gone', 'a']))).toEqual(['c', 'b', 'a'])
  })

  it('collapses a repeated id rather than duplicating the entry', () => {
    const rows = panes('a', 'b', 'c')
    expect(ids(reorderById(rows, ['c', 'c', 'a']))).toEqual(['c', 'b', 'a'])
  })

  it('returns the array unchanged when nothing it names is present', () => {
    const rows = panes('a', 'b')
    expect(ids(reorderById(rows, ['gone', 'also-gone']))).toEqual(['a', 'b'])
  })

  it('keeps every entry, so a reorder can never drop a pane', () => {
    const rows = panes('a', 'b', 'c', 'd')
    expect(ids(reorderById(rows, ['d', 'a'])).slice().sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('carries the whole entry, not just its id', () => {
    const rows = [
      { id: 'a', title: 'first' },
      { id: 'b', title: 'second' },
    ]
    expect(reorderById(rows, ['b', 'a'])).toEqual([
      { id: 'b', title: 'second' },
      { id: 'a', title: 'first' },
    ])
  })

  it('never mutates the array it is given', () => {
    const rows = panes('a', 'b', 'c')
    reorderById(rows, ['c', 'b', 'a'])
    expect(ids(rows)).toEqual(['a', 'b', 'c'])
  })

  it('is a no-op for an order that already holds', () => {
    const rows = panes('a', 'b', 'c')
    expect(ids(reorderById(rows, ['a', 'b', 'c']))).toEqual(['a', 'b', 'c'])
  })
})
