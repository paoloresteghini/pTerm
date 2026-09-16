import { describe, it, expect } from 'vitest'
import { moveBlock } from '../../src/renderer/lib/moveBlock'

const order = ['a', 'b', 'c', 'd', 'e']

describe('moveBlock', () => {
  it('drops a single id after its target', () => {
    expect(moveBlock(order, ['a'], 'c', 'after')).toEqual(['b', 'c', 'a', 'd', 'e'])
  })

  it('drops a single id before its target', () => {
    expect(moveBlock(order, ['e'], 'b', 'before')).toEqual(['a', 'e', 'b', 'c', 'd'])
  })

  it('keeps a run together and in its own order', () => {
    expect(moveBlock(order, ['b', 'c'], 'e', 'after')).toEqual(['a', 'd', 'e', 'b', 'c'])
  })

  it('counts the target position after the run is lifted out, not before', () => {
    // 'a' and 'b' come out first, so 'c' is at index 0 of the remainder.
    // Reading the index off the original array would insert one slot late.
    expect(moveBlock(order, ['a', 'b'], 'c', 'before')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(moveBlock(order, ['a', 'b'], 'd', 'before')).toEqual(['c', 'a', 'b', 'd', 'e'])
  })

  it('does nothing when the run is dropped on itself', () => {
    expect(moveBlock(order, ['b', 'c'], 'c', 'before')).toEqual(order)
    expect(moveBlock(order, ['b'], 'b', 'after')).toEqual(order)
  })

  it('does nothing when the target is not in the order', () => {
    expect(moveBlock(order, ['a'], 'gone', 'after')).toEqual(order)
  })

  it('does nothing when none of the run is in the order', () => {
    expect(moveBlock(order, ['gone'], 'c', 'after')).toEqual(order)
  })

  it('moves the part of a run the order holds and ignores the rest', () => {
    expect(moveBlock(order, ['b', 'gone'], 'd', 'after')).toEqual(['a', 'c', 'd', 'b', 'e'])
  })

  it('moves to the very front and the very back', () => {
    expect(moveBlock(order, ['d'], 'a', 'before')).toEqual(['d', 'a', 'b', 'c', 'e'])
    expect(moveBlock(order, ['a'], 'e', 'after')).toEqual(['b', 'c', 'd', 'e', 'a'])
  })

  it('keeps every id, so a drag can never drop one', () => {
    expect(moveBlock(order, ['b', 'd'], 'a', 'before').slice().sort()).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ])
  })

  it('never mutates the order it is given', () => {
    const given = [...order]
    moveBlock(given, ['a'], 'e', 'after')
    expect(given).toEqual(order)
  })
})
