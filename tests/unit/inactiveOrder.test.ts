import { describe, it, expect } from 'vitest'
import { byRecentlyClosed } from '../../src/renderer/lib/inactiveOrder'

const row = (name: string, lastClosedAt: number | null) => ({ project: { name, lastClosedAt } })
const names = (rows: { project: { name: string } }[]): string[] => rows.map((r) => r.project.name)

describe('byRecentlyClosed', () => {
  it('puts the most recently closed project first', () => {
    const rows = [row('Adecco', 1000), row('Lumio', 3000), row('GCO', 2000)]
    expect(names(byRecentlyClosed(rows))).toEqual(['Lumio', 'GCO', 'Adecco'])
  })

  it('sinks projects that have never had a pane close, in their manual order', () => {
    const rows = [row('Adecco', null), row('Lumio', 2000), row('GCO', null)]
    expect(names(byRecentlyClosed(rows))).toEqual(['Lumio', 'Adecco', 'GCO'])
  })

  it('keeps the manual order of two projects closed in the same millisecond', () => {
    const rows = [row('Adecco', 1000), row('Lumio', 1000)]
    expect(names(byRecentlyClosed(rows))).toEqual(['Adecco', 'Lumio'])
  })

  it('reads a missing field as never closed, not as epoch zero', () => {
    const rows = [{ project: { name: 'Adecco' } }, { project: { name: 'Lumio', lastClosedAt: 5 } }]
    expect(names(byRecentlyClosed(rows))).toEqual(['Lumio', 'Adecco'])
  })

  it('never mutates the array it is given', () => {
    const rows = [row('Adecco', 1000), row('Lumio', 3000)]
    byRecentlyClosed(rows)
    expect(names(rows)).toEqual(['Adecco', 'Lumio'])
  })
})
