import { describe, it, expect } from 'vitest'
import {
  WALL_COLUMNS_DEFAULT,
  columnsFromStored,
  slotsFromStored,
  toggleSlot,
} from '../../src/renderer/lib/wallSlots'

/**
 * Which projects hold a wall slot, and how many cells go in a row.
 *
 * A preference about this window's layout, so it lives in `localStorage` beside
 * `pterm:columnOrder` rather than in the config, and it degrades the way
 * `orderFromStored` does: a hand-edited or half-written entry costs the user
 * their preference, not their window.
 *
 * Sabotage check results: all four mutations caught as predicted.
 * 1. Drop `known.has(entry)` check: "drops an id no project answers to" reddens.
 * 2. Drop `seen.has(entry)` check: "collapses a duplicated id to its first appearance" reddens.
 * 3. Return `parsed` unclamped: "clamps above four and below one" reddens.
 * 4. Mutate slots in place: "hands back a new array rather than mutating" reddens.
 */

const PROJECTS = [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }]

describe('slotsFromStored', () => {
  it('reads a clean list', () => {
    expect(slotsFromStored('["p2","p1"]', PROJECTS)).toEqual(['p2', 'p1'])
  })

  it('starts empty when nothing is stored', () => {
    expect(slotsFromStored(null, PROJECTS)).toEqual([])
  })

  it('starts empty on unparseable JSON', () => {
    expect(slotsFromStored('{oops', PROJECTS)).toEqual([])
  })

  it('starts empty when the stored value is not an array', () => {
    expect(slotsFromStored('{"p1":true}', PROJECTS)).toEqual([])
  })

  // A project removed from the sidebar leaves the wall by itself, which is why
  // membership is stored by id and resolved against the live list.
  it('drops an id no project answers to', () => {
    expect(slotsFromStored('["p1","gone","p3"]', PROJECTS)).toEqual(['p1', 'p3'])
  })

  it('collapses a duplicated id to its first appearance', () => {
    expect(slotsFromStored('["p2","p1","p2"]', PROJECTS)).toEqual(['p2', 'p1'])
  })

  it('drops an entry that is not a string', () => {
    expect(slotsFromStored('["p1",7,null,"p3"]', PROJECTS)).toEqual(['p1', 'p3'])
  })
})

describe('columnsFromStored', () => {
  it('defaults when nothing is stored', () => {
    expect(columnsFromStored(null)).toBe(WALL_COLUMNS_DEFAULT)
  })

  it('reads a stored count', () => {
    expect(columnsFromStored('2')).toBe(2)
  })

  // Past four, a cell is narrower than Claude's prompt box on any window this
  // app opens at.
  it('clamps above four and below one', () => {
    expect(columnsFromStored('9')).toBe(4)
    expect(columnsFromStored('0')).toBe(1)
  })

  it('defaults on anything that is not a number', () => {
    expect(columnsFromStored('three')).toBe(WALL_COLUMNS_DEFAULT)
    expect(columnsFromStored('')).toBe(WALL_COLUMNS_DEFAULT)
  })

  it('floors a fractional count', () => {
    expect(columnsFromStored('2.7')).toBe(2)
  })
})

describe('toggleSlot', () => {
  it('appends a project that is not on the wall', () => {
    expect(toggleSlot(['p1'], 'p2')).toEqual(['p1', 'p2'])
  })

  it('removes a project that is', () => {
    expect(toggleSlot(['p1', 'p2', 'p3'], 'p2')).toEqual(['p1', 'p3'])
  })

  it('hands back a new array rather than mutating', () => {
    const before = ['p1']
    expect(toggleSlot(before, 'p2')).not.toBe(before)
    expect(before).toEqual(['p1'])
  })
})
