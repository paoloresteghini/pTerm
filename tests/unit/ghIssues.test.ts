import { describe, expect, it } from 'vitest'
import { issueNumberFromUrl, parseDetail, parseSummaries } from '../../src/main/gh/issues'

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

const GOOD_ROW = {
  number: 1,
  title: 'Good row',
  state: 'OPEN',
  stateReason: '',
  labels: [],
  assignees: [],
  comments: [],
  updatedAt: '2026-08-09T10:00:00Z',
  author: { login: 'paolo' },
}

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

  it('does not carry a comment count, which the list payload no longer fetches', () => {
    expect('commentCount' in parseSummaries(LIST)[0]).toBe(false)
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

  it('drops a null entry in the list rather than throwing', () => {
    const rows = parseSummaries(JSON.stringify([null, GOOD_ROW]))
    expect(rows).toHaveLength(1)
    expect(rows[0].number).toBe(1)
  })

  it('drops a null label rather than throwing', () => {
    const row = { ...GOOD_ROW, labels: [null, { name: 'bug', color: 'd73a4a' }] }
    const rows = parseSummaries(JSON.stringify([row]))
    expect(rows[0].labels).toEqual([{ name: 'bug', color: 'd73a4a' }])
  })

  it('drops a null assignee rather than throwing', () => {
    const row = { ...GOOD_ROW, assignees: [null, { login: 'paolo' }] }
    const rows = parseSummaries(JSON.stringify([row]))
    expect(rows[0].assignees).toEqual([{ login: 'paolo' }])
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

  it('drops a null comment rather than throwing', () => {
    const detail = JSON.parse(DETAIL)
    detail.comments = [
      null,
      { author: { login: 'paolo' }, body: 'ok', createdAt: '2026-08-09T11:00:00Z' },
    ]
    const parsed = parseDetail(JSON.stringify(detail))
    expect(parsed?.comments).toHaveLength(1)
    expect(parsed?.comments[0].body).toBe('ok')
  })
})

describe('issueNumberFromUrl', () => {
  it('reads the number out of what gh issue create prints', () => {
    expect(issueNumberFromUrl('https://github.com/o/n/issues/42\n')).toBe(42)
  })

  it('reads a multi-digit number rather than one digit of it', () => {
    expect(issueNumberFromUrl('https://github.com/o/n/issues/1234\n')).toBe(1234)
  })

  it('reads an enterprise host the same way', () => {
    expect(issueNumberFromUrl('https://github.corp.ghe.com/o/n/issues/7\n')).toBe(7)
  })

  it('tolerates the trailing whitespace gh actually sends', () => {
    expect(issueNumberFromUrl('  https://github.com/o/n/issues/42  \n\n')).toBe(42)
  })

  it('answers 0 for an empty reply rather than NaN', () => {
    expect(issueNumberFromUrl('')).toBe(0)
    expect(issueNumberFromUrl('\n')).toBe(0)
  })

  it('answers 0 for a URL with no issue number', () => {
    expect(issueNumberFromUrl('https://github.com/o/n/issues\n')).toBe(0)
    expect(issueNumberFromUrl('https://github.com/o/n\n')).toBe(0)
  })

  it('answers 0 when the number is not the last thing on the line', () => {
    // `gh` prints the URL alone, so anything after it means the output is not
    // the shape this parse assumes and a guessed number would be worse than 0.
    expect(issueNumberFromUrl('https://github.com/o/n/issues/42/comments')).toBe(0)
  })

  it('answers 0 for a pull request URL', () => {
    expect(issueNumberFromUrl('https://github.com/o/n/pull/42\n')).toBe(0)
  })
})
