import { describe, it, expect } from 'vitest'
import {
  MAX_VISIBLE_INACTIVE_PROJECTS,
  groupProjects,
  type ProjectGroups,
} from '../../src/renderer/lib/projectOrder'

type Row = { project: { name: string; lastClosedAt?: number | null }; open: number }

const row = (name: string, open: number, lastClosedAt?: number | null): Row => ({
  project: { name, lastClosedAt },
  open,
})
const names = (rows: Row[]): string[] => rows.map((r) => r.project.name)
const group = (rows: Row[]): ProjectGroups<Row> => groupProjects(rows, (r) => r.open > 0)

describe('groupProjects', () => {
  it('keeps the live group in the order it was given', () => {
    const rows = [row('rekupr', 3), row('EmpowerMS', 1), row('pTerm', 2)]
    expect(names(group(rows).live)).toEqual(['rekupr', 'EmpowerMS', 'pTerm'])
  })

  it('sorts the dormant group by when it was closed, not by stored order', () => {
    const rows = [row('Adecco', 0, 1000), row('LEDGE2', 0, 3000), row('GCO', 0, 2000)]
    expect(names(group(rows).dormant)).toEqual(['LEDGE2', 'GCO', 'Adecco'])
  })

  it('numbers every live project before any dormant one, whatever the stored order', () => {
    // Interleaved on purpose: this is the arrangement that produced ⌘2, ⌘4, ⌘5
    // down three consecutive rows when the badge came off the stored index.
    const rows = [
      row('Unsorted', 0, 9000),
      row('rekupr', 2),
      row('Adecco', 0, 1000),
      row('EmpowerMS', 1),
      row('pTerm', 4),
    ]
    expect(names(group(rows).visible)).toEqual([
      'rekupr',
      'EmpowerMS',
      'pTerm',
      'Unsorted',
      'Adecco',
    ])
  })

  it('caps the dormant tail at what the sidebar lists, and never the live head', () => {
    const live = Array.from({ length: 7 }, (_, i) => row(`live${i}`, 1))
    const dormant = Array.from({ length: 8 }, (_, i) => row(`dormant${i}`, 0, 1000 - i))
    const { visible } = group([...live, ...dormant])
    expect(visible).toHaveLength(7 + MAX_VISIBLE_INACTIVE_PROJECTS)
    expect(names(visible).slice(0, 7)).toEqual(names(live))
    // Most recently closed first, so the five that survive the cap are the
    // five highest stamps, not the first five in stored order.
    expect(names(visible).slice(7)).toEqual(['dormant0', 'dormant1', 'dormant2', 'dormant3', 'dormant4'])
  })

  it('leaves the whole dormant group readable, so "Show N more" can count it', () => {
    const rows = Array.from({ length: 8 }, (_, i) => row(`dormant${i}`, 0, i))
    const { dormant, visible } = group(rows)
    expect(dormant).toHaveLength(8)
    expect(visible).toHaveLength(MAX_VISIBLE_INACTIVE_PROJECTS)
  })

  it('moves a project out of the numbering the moment its last pane closes', () => {
    const before = [row('rekupr', 1), row('EmpowerMS', 1), row('pTerm', 1)]
    const after = [row('rekupr', 1), row('EmpowerMS', 0, 5000), row('pTerm', 1)]
    expect(names(group(before).visible)).toEqual(['rekupr', 'EmpowerMS', 'pTerm'])
    expect(names(group(after).visible)).toEqual(['rekupr', 'pTerm', 'EmpowerMS'])
  })

  it('reads a project with no stamp as never closed rather than as epoch zero', () => {
    const rows = [row('Adecco', 0), row('LEDGE2', 0, 5)]
    expect(names(group(rows).dormant)).toEqual(['LEDGE2', 'Adecco'])
  })

  it('never mutates the array it is given', () => {
    const rows = [row('Adecco', 0, 1000), row('LEDGE2', 0, 3000), row('rekupr', 1)]
    group(rows)
    expect(names(rows)).toEqual(['Adecco', 'LEDGE2', 'rekupr'])
  })
})
