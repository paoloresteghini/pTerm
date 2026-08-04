import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readExpanded, writeExpanded, toggled } from '../../src/renderer/lib/treeState'

// vitest runs `environment: 'node'`, so there is no `localStorage` to use and
// no DOM to give one. This is the whole reason the storage lives in a module
// of its own rather than inline in `FileTree.tsx`: a component reading
// `localStorage` directly could only be covered by e2e.
beforeEach(() => {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  })
})

describe('toggled', () => {
  it('adds a path that was closed', () => {
    expect([...toggled(new Set(), 'src')]).toEqual(['src'])
  })

  it('removes a path that was open', () => {
    expect([...toggled(new Set(['src']), 'src')]).toEqual([])
  })

  // A new Set every time rather than mutating: React state, and a mutated Set
  // is the same reference, so nothing re-renders.
  it('returns a new set rather than mutating the one given', () => {
    const before = new Set(['src'])
    const after = toggled(before, 'docs')
    expect(after).not.toBe(before)
    expect([...before]).toEqual(['src'])
  })
})

describe('readExpanded and writeExpanded', () => {
  it('round-trips a set for one project', () => {
    writeExpanded('p1', new Set(['src', 'src/main']))
    expect([...readExpanded('p1')].sort()).toEqual(['src', 'src/main'])
  })

  // Per project, which is the point of the key: switching projects must not
  // show the previous project's directories as open.
  it('keeps projects apart', () => {
    writeExpanded('p1', new Set(['src']))
    writeExpanded('p2', new Set(['docs']))
    expect([...readExpanded('p1')]).toEqual(['src'])
    expect([...readExpanded('p2')]).toEqual(['docs'])
  })

  it('reads an unknown project as nothing open', () => {
    expect([...readExpanded('never-seen')]).toEqual([])
  })

  // localStorage is a text file by another name: a hand-edited or truncated
  // value must not throw inside a render.
  it('reads unparseable or wrongly shaped storage as nothing open', () => {
    localStorage.setItem('prcli:treeExpanded:p1', '{not json')
    expect([...readExpanded('p1')]).toEqual([])
    localStorage.setItem('prcli:treeExpanded:p1', '{"src":true}')
    expect([...readExpanded('p1')]).toEqual([])
    localStorage.setItem('prcli:treeExpanded:p1', '[1,2,3]')
    expect([...readExpanded('p1')]).toEqual([])
  })
})
