import { describe, it, expect } from 'vitest'
import { byName, scoreEntry, filterEntries, rankSessions } from '../../src/renderer/lib/match'

describe('scoreEntry', () => {
  it('returns null when a query character is absent', () => {
    expect(scoreEntry('zz', 'brainstorming')).toBeNull()
  })

  it('matches characters out of adjacency but in order', () => {
    // `bsm` is a subsequence of `brainstorming`. This is the whole point of a
    // fuzzy filter: nobody types the middle of a 24-character plugin name.
    expect(scoreEntry('bsm', 'brainstorming')).not.toBeNull()
  })

  it('refuses a query whose characters are in the wrong order', () => {
    expect(scoreEntry('mb', 'brainstorming')).toBeNull()
  })

  it('is case insensitive in both directions', () => {
    expect(scoreEntry('BR', 'brainstorming')).not.toBeNull()
    expect(scoreEntry('br', 'BRAINSTORMING')).not.toBeNull()
  })

  it('scores a contiguous run above the same characters scattered', () => {
    // Both names place the query characters at the same first index and the
    // same last index, and skip three characters in total either way, so the
    // ONLY difference between them is that two characters are adjacent in the
    // first. Remove the adjacency bonus and the two score identically, which
    // is what makes this assertion pin that bonus and nothing else.
    //
    // A realistic-looking pair does not work here, and was tried:
    // `bra` against `brainstorming` and `boring-random-away` scores 8 against
    // 3 with the bonus removed, so it passes either way. It reads better and
    // measures nothing. The synthetic pair is the honest one.
    const contiguous = scoreEntry('abc', 'xabqqc')
    const scattered = scoreEntry('abc', 'xaqbqc')
    expect(contiguous).not.toBeNull()
    expect(scattered).not.toBeNull()
    expect(contiguous as number).toBeGreaterThan(scattered as number)
  })

  it('scores a segment start above a match buried mid-word', () => {
    // `:` and `-` start a segment. `superpowers:brainstorming` is why: typing
    // `b` should favour the entry where `b` begins a segment.
    const boundary = scoreEntry('b', 'superpowers:brainstorming')
    const buried = scoreEntry('b', 'aaab')
    expect(boundary).not.toBeNull()
    expect(buried).not.toBeNull()
    expect(boundary as number).toBeGreaterThan(buried as number)
  })

  it('keeps a segment start ahead however far into the name it sits', () => {
    // The bug this pins: the skip cost once grew with position without limit
    // while the segment bonus stayed fixed, so a segment start far into a long
    // name lost to a buried match near the front of a short one. Distance must
    // not be able to outweigh starting a segment.
    const far = scoreEntry('b', 'solutions-architect-skills:business-continuity')
    const near = scoreEntry('b', 'aab')
    expect(far).not.toBeNull()
    expect(near).not.toBeNull()
    expect(far as number).toBeGreaterThan(near as number)
  })

  it('scores an empty query as zero rather than refusing it', () => {
    expect(scoreEntry('', 'anything')).toBe(0)
  })
})

describe('byName', () => {
  it('orders case insensitively', () => {
    const sorted = [{ name: 'Zebra' }, { name: 'apple' }].sort(byName)
    expect(sorted.map((entry) => entry.name)).toEqual(['apple', 'Zebra'])
  })

  it('groups a plugin\'s entries together by sorting on the whole name', () => {
    // The prefix is part of the name, so grouping falls out of the sort and
    // needs no grouping mechanism.
    const sorted = [
      { name: 'superpowers:brainstorming' },
      { name: 'atlassian:triage-issue' },
      { name: 'superpowers:writing-plans' },
      { name: 'atlassian:spec-to-backlog' },
    ].sort(byName)
    expect(sorted.map((entry) => entry.name)).toEqual([
      'atlassian:spec-to-backlog',
      'atlassian:triage-issue',
      'superpowers:brainstorming',
      'superpowers:writing-plans',
    ])
  })

  it('is a total order: equal lowercase names fall back to the raw name', () => {
    const sorted = [{ name: 'Ship' }, { name: 'ship' }].sort(byName)
    expect(sorted.map((entry) => entry.name)).toEqual(['Ship', 'ship'])
  })
})

describe('filterEntries', () => {
  const entries = [
    { name: 'browse' },
    { name: 'superpowers:brainstorming' },
    { name: 'gsd:stats' },
    { name: 'ship' },
  ]

  it('returns everything in name order when the query is empty', () => {
    const result = filterEntries('', entries)
    expect(result.length).toBe(4)
    expect(result.map((entry) => entry.name)).toEqual([
      'browse',
      'gsd:stats',
      'ship',
      'superpowers:brainstorming',
    ])
  })

  it('drops entries that do not match at all', () => {
    const result = filterEntries('brow', entries)
    expect(result.length).toBeGreaterThan(0)
    expect(result.map((entry) => entry.name)).toEqual(['browse'])
  })

  it('returns an empty array when nothing matches, rather than everything', () => {
    // 161 entries means the user will type something that matches nothing.
    // Falling back to "show all" would be worse than showing none.
    expect(filterEntries('zzzz', entries)).toEqual([])
  })

  it('orders by score, not by name, once a query is present', () => {
    const result = filterEntries('s', entries)
    expect(result.length).toBeGreaterThan(0)
    // `ship` and `stats` start a segment; `brainstorming`'s `s` is buried.
    expect(result[0]?.name).not.toBe('superpowers:brainstorming')
  })

  it('breaks a score tie by name, so the order never depends on input order', () => {
    const tied = [{ name: 'sb' }, { name: 'sa' }]
    const result = filterEntries('s', tied)
    expect(result.length).toBe(2)
    expect(result.map((entry) => entry.name)).toEqual(['sa', 'sb'])
  })

  it('does not mutate the array it is given', () => {
    const original = [{ name: 'b' }, { name: 'a' }]
    filterEntries('', original)
    expect(original.map((entry) => entry.name)).toEqual(['b', 'a'])
  })
})

describe('rankSessions', () => {
  // `severity` is an index into the shared SEVERITY order, so lower is worse:
  // 0 is `crashed`, 1 is `waiting`.
  const sessions = [
    { name: 'alpha · aaaaaa', severity: 4 },
    { name: 'beta · bbbbbb', severity: 0 },
    { name: 'gamma · cccccc', severity: 1 },
  ]

  it('breaks a score tie by severity, worst first', () => {
    // No query, so every score is equal and severity is the only signal. The
    // crashed one is what the user opened this to find.
    const result = rankSessions('', sessions)
    expect(result.length).toBe(3)
    expect(result.map((session) => session.name)).toEqual([
      'beta · bbbbbb',
      'gamma · cccccc',
      'alpha · aaaaaa',
    ])
  })

  it('still lets a better score beat a worse state', () => {
    // Severity is a tie-break, not an override: someone who typed `alpha`
    // asked for alpha.
    const result = rankSessions('alpha', sessions)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]?.name).toBe('alpha · aaaaaa')
  })

  it('drops non-matches like filterEntries does', () => {
    expect(rankSessions('zzzz', sessions)).toEqual([])
  })

  it('breaks a severity tie by name, so the order never depends on input order', () => {
    const tied = [
      { name: 'b · bbbbbb', severity: 2 },
      { name: 'a · aaaaaa', severity: 2 },
    ]
    const result = rankSessions('', tied)
    expect(result.length).toBe(2)
    expect(result.map((session) => session.name)).toEqual(['a · aaaaaa', 'b · bbbbbb'])
  })
})
