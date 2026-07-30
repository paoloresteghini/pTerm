import { describe, it, expect } from 'vitest'
import {
  slugify,
  newSessionId,
  encodeSessionName,
  decodeSessionName,
  isPrcliSession,
} from '../../src/main/tmux/names'

describe('slugify', () => {
  it('lowercases and replaces unsafe characters with underscores', () => {
    expect(slugify('HartfordRents')).toBe('hartfordrents')
    expect(slugify('Hartford Rents Web')).toBe('hartford_rents_web')
    expect(slugify('REKUPR-b1b2')).toBe('rekupr_b1b2')
    expect(slugify('ginos-estate-agents')).toBe('ginos_estate_agents')
  })

  it('collapses runs of unsafe characters into one underscore', () => {
    expect(slugify('a  --  b')).toBe('a_b')
  })

  it('trims leading and trailing underscores', () => {
    expect(slugify('  Lumio  ')).toBe('lumio')
  })

  it('throws when nothing usable remains', () => {
    expect(() => slugify('...')).toThrow(/no usable characters/i)
  })
})

describe('newSessionId', () => {
  it('produces 16 lowercase hex characters', () => {
    expect(newSessionId()).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces distinct ids', () => {
    expect(newSessionId()).not.toBe(newSessionId())
  })
})

describe('encodeSessionName', () => {
  it('joins prefix, slug and id with dashes', () => {
    expect(encodeSessionName({ projectSlug: 'lumio', id: 'a1b2c3d4e5f60718' }))
      .toBe('prcli-lumio-a1b2c3d4e5f60718')
  })

  it('rejects a slug that is not already sanitised', () => {
    expect(() => encodeSessionName({ projectSlug: 'Lumio-Web', id: 'a1b2c3d4e5f60718' }))
      .toThrow(/invalid project slug/i)
  })

  it('rejects a malformed id', () => {
    expect(() => encodeSessionName({ projectSlug: 'lumio', id: 'nope' }))
      .toThrow(/invalid session id/i)
  })
})

describe('decodeSessionName', () => {
  it('round-trips an encoded name', () => {
    const parts = { projectSlug: 'hartford_rents', id: '00112233445566aa' }
    expect(decodeSessionName(encodeSessionName(parts))).toEqual(parts)
  })

  it('returns null for foreign session names', () => {
    expect(decodeSessionName('0')).toBeNull()
    expect(decodeSessionName('work')).toBeNull()
    expect(decodeSessionName('prcli')).toBeNull()
    expect(decodeSessionName('other-lumio-a1b2c3d4e5f60718')).toBeNull()
  })

  it('returns null when the id is malformed', () => {
    expect(decodeSessionName('prcli-lumio-XYZ')).toBeNull()
  })
})

describe('isPrcliSession', () => {
  it('distinguishes ours from foreign sessions', () => {
    expect(isPrcliSession('prcli-lumio-a1b2c3d4e5f60718')).toBe(true)
    expect(isPrcliSession('my-work-session')).toBe(false)
  })
})
