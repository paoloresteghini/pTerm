import { describe, expect, it } from 'vitest'
import { parseDetail, parseSummaries } from '../../src/main/gh/issues'

const LIST = JSON.stringify([
  {
    number: 42,
    title: 'Fix the resizer',
    state: 'OPEN',
    stateReason: '',
    labels: [{ id: 'LA_x', name: 'bug', description: 'a bug', color: 'd73a4a' }],
    assignees: [{ id: 'U_x', login: 'paolo', name: 'Paolo' }],
    comments: [{}, {}, {}],
    updatedAt: '2026-08-09T10:00:00Z',
    author: { id: 'U_x', is_bot: false, login: 'paolo', name: 'Paolo' },
  },
  {
    number: 38,
    title: 'Rename the git column',
    state: 'CLOSED',
    stateReason: 'NOT_PLANNED',
    labels: [],
    assignees: [],
    comments: [],
    updatedAt: '2026-08-08T10:00:00Z',
    author: { login: 'someone' },
  },
])

describe('parseSummaries', () => {
  it('reads number, title, state and reason', () => {
    const rows = parseSummaries(LIST)
    expect(rows).toHaveLength(2)
    expect(rows[0].number).toBe(42)
    expect(rows[0].title).toBe('Fix the resizer')
    expect(rows[0].state).toBe('OPEN')
    expect(rows[1].stateReason).toBe('NOT_PLANNED')
  })

  it('reads the empty string gh sends for an open issue as no reason', () => {
    expect(parseSummaries(LIST)[0].stateReason).toBeNull()
  })

  it('keeps only the label fields the column draws', () => {
    expect(parseSummaries(LIST)[0].labels[0]).toEqual({ name: 'bug', color: 'd73a4a' })
  })

  it('collapses the comments array to a count', () => {
    expect(parseSummaries(LIST)[0].commentCount).toBe(3)
    expect(parseSummaries(LIST)[1].commentCount).toBe(0)
  })

  it('returns an empty list for an empty reply', () => {
    expect(parseSummaries('[]')).toEqual([])
  })

  it('returns an empty list rather than throwing on malformed JSON', () => {
    expect(parseSummaries('not json')).toEqual([])
  })

  it('drops an entry with no number rather than emitting NaN', () => {
    expect(parseSummaries('[{"title":"x"}]')).toEqual([])
  })
})

describe('parseDetail', () => {
  const DETAIL = JSON.stringify({
    number: 42,
    title: 'Fix the resizer',
    body: '## Steps\n\n1. Drag it',
    state: 'OPEN',
    stateReason: null,
    labels: [],
    assignees: [],
    comments: [{ author: { login: 'paolo' }, body: 'Still broken', createdAt: '2026-08-09T11:00:00Z' }],
    url: 'https://github.com/o/n/issues/42',
    createdAt: '2026-08-01T10:00:00Z',
    updatedAt: '2026-08-09T10:00:00Z',
    author: { login: 'paolo' },
  })

  it('keeps the body verbatim', () => {
    expect(parseDetail(DETAIL)?.body).toBe('## Steps\n\n1. Drag it')
  })

  it('keeps comments as a list, not a count', () => {
    const detail = parseDetail(DETAIL)
    expect(detail?.comments).toHaveLength(1)
    expect(detail?.comments[0].author.login).toBe('paolo')
    expect(detail?.commentCount).toBe(1)
  })

  it('returns null on malformed JSON', () => {
    expect(parseDetail('{')).toBeNull()
  })
})
