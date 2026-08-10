import { describe, expect, it } from 'vitest'
import type { IssueSummary } from '../../src/shared/ipc'
import {
  filterIssues,
  issueStateLabel,
  shouldRefetchOnFocus,
  sortIssues,
  FOCUS_REFETCH_THROTTLE_MS,
} from '../../src/renderer/lib/issueList'

function issue(over: Partial<IssueSummary>): IssueSummary {
  return {
    number: 1,
    title: 'A title',
    state: 'OPEN',
    stateReason: null,
    labels: [],
    assignees: [],
    updatedAt: '2026-08-01T00:00:00Z',
    author: { login: 'paolo' },
    ...over,
  }
}

describe('filterIssues', () => {
  const rows = [
    issue({ number: 42, title: 'Fix the resizer', labels: [{ name: 'bug', color: 'aaa' }] }),
    issue({ number: 7, title: 'Add a column' }),
  ]

  it('returns everything for an empty query', () => {
    expect(filterIssues(rows, '')).toHaveLength(2)
  })

  it('matches the title case-insensitively', () => {
    expect(filterIssues(rows, 'RESIZER').map((row) => row.number)).toEqual([42])
  })

  it('matches the number', () => {
    expect(filterIssues(rows, '7').map((row) => row.number)).toEqual([7])
  })

  it('matches the number with a leading hash', () => {
    expect(filterIssues(rows, '#42').map((row) => row.number)).toEqual([42])
  })

  it('matches a label name', () => {
    expect(filterIssues(rows, 'bug').map((row) => row.number)).toEqual([42])
  })

  it('returns nothing when nothing matches', () => {
    expect(filterIssues(rows, 'zzzz')).toEqual([])
  })

  it('ignores surrounding whitespace', () => {
    expect(filterIssues(rows, '  resizer  ').map((row) => row.number)).toEqual([42])
  })
})

describe('sortIssues', () => {
  const rows = [
    issue({ number: 1, updatedAt: '2026-08-01T00:00:00Z' }),
    issue({ number: 9, updatedAt: '2026-08-09T00:00:00Z' }),
    issue({ number: 5, updatedAt: '2026-08-05T00:00:00Z' }),
  ]

  it('sorts by most recently updated', () => {
    expect(sortIssues(rows, 'updated').map((row) => row.number)).toEqual([9, 5, 1])
  })

  it('sorts by newest number', () => {
    expect(sortIssues(rows, 'newest').map((row) => row.number)).toEqual([9, 5, 1])
  })

  it('does not mutate its input', () => {
    const before = rows.map((row) => row.number)
    sortIssues(rows, 'newest')
    expect(rows.map((row) => row.number)).toEqual(before)
  })

  it('separates newest from recently updated', () => {
    const mixed = [
      issue({ number: 100, updatedAt: '2026-01-01T00:00:00Z' }),
      issue({ number: 2, updatedAt: '2026-08-09T00:00:00Z' }),
    ]
    expect(sortIssues(mixed, 'newest').map((row) => row.number)).toEqual([100, 2])
    expect(sortIssues(mixed, 'updated').map((row) => row.number)).toEqual([2, 100])
  })
})

describe('issueStateLabel', () => {
  it('reads open issues as Open regardless of a leftover reason', () => {
    expect(issueStateLabel('OPEN', null)).toBe('Open')
    expect(issueStateLabel('OPEN', 'REOPENED')).toBe('Open')
  })

  it('reads a closed issue with no reason as completed', () => {
    expect(issueStateLabel('CLOSED', null)).toBe('Closed as completed')
  })

  it('reads a closed issue marked completed as completed', () => {
    expect(issueStateLabel('CLOSED', 'COMPLETED')).toBe('Closed as completed')
  })

  it('reads a closed issue marked not planned as not planned', () => {
    expect(issueStateLabel('CLOSED', 'NOT_PLANNED')).toBe('Closed as not planned')
  })
})

describe('shouldRefetchOnFocus', () => {
  it('allows a refetch when nothing has been fetched yet', () => {
    expect(shouldRefetchOnFocus(null, 1_000)).toBe(true)
  })

  it('refuses a focus that arrives before the throttle window has passed', () => {
    const last = 10_000
    expect(shouldRefetchOnFocus(last, last + FOCUS_REFETCH_THROTTLE_MS - 1)).toBe(false)
  })

  it('allows a focus once the throttle window has fully passed', () => {
    const last = 10_000
    expect(shouldRefetchOnFocus(last, last + FOCUS_REFETCH_THROTTLE_MS)).toBe(true)
  })

  it('allows a focus arriving well after the window', () => {
    const last = 10_000
    expect(shouldRefetchOnFocus(last, last + FOCUS_REFETCH_THROTTLE_MS * 5)).toBe(true)
  })
})
