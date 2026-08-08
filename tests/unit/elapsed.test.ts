/**
 * The vitals label: how long a tab has been in the state it is in.
 *
 * Coarse on purpose. Twelve rows each counting seconds is motion in the corner
 * of the eye all day, and the question the label answers ("which of these is
 * stuck") is not answered any better by knowing it has been 4m12s.
 */
import { describe, it, expect } from 'vitest'
import { elapsedLabel } from '../../src/renderer/lib/elapsed'

const at = (ms: number): string | null => elapsedLabel(1_000_000, 1_000_000 + ms)

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

describe('elapsedLabel', () => {
  // Under a minute is nothing at all: a number appearing and vanishing within
  // a second of every keystroke is noise, and "just now" is what no label
  // already means.
  it.each([0, SECOND, 30 * SECOND, 59 * SECOND])('shows nothing at %ims', (ms) => {
    expect(at(ms)).toBeNull()
  })

  it('shows whole minutes from one minute', () => {
    expect(at(MINUTE)).toBe('1m')
    expect(at(4 * MINUTE)).toBe('4m')
    expect(at(59 * MINUTE)).toBe('59m')
  })

  it('rounds minutes down, so a label never claims time that has not passed', () => {
    expect(at(MINUTE + 59 * SECOND)).toBe('1m')
  })

  it('shows whole hours from one hour', () => {
    expect(at(HOUR)).toBe('1h')
    expect(at(2 * HOUR + 30 * MINUTE)).toBe('2h')
    expect(at(25 * HOUR)).toBe('25h')
  })

  /*
   * A clock that went backwards. NTP correction, a machine waking from sleep,
   * or simply a `since` from a moment that has not arrived yet. Answering null
   * is the honest reading; a negative or enormous label would be worse than
   * none, and this is the case that actually shows up on a laptop that sleeps.
   */
  it('shows nothing when now is before since', () => {
    expect(elapsedLabel(1_000_000, 999_000)).toBeNull()
  })

  it('shows nothing for a tab with no since at all', () => {
    expect(elapsedLabel(null, 1_000_000)).toBeNull()
  })

  // The boundaries, named individually: an off-by-one at either would show
  // "60m" or "0h", both of which look like a bug to anyone reading the row.
  it('crosses from minutes to hours exactly at the hour', () => {
    expect(at(HOUR - SECOND)).toBe('59m')
    expect(at(HOUR)).toBe('1h')
  })
})
