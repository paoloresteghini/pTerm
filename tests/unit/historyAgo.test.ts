import { describe, it, expect } from 'vitest'
import { historyAgo } from '../../src/renderer/lib/historyAgo'

/**
 * The relative time on every history row. The e2e spec proves a row carries
 * one and that it matches the shape `just now|Nm ago|Nh ago|Nd ago`; the
 * boundaries between those four units are only reachable here, because the
 * seconds either side of each of them are a second apart and no e2e test can
 * pin a clock.
 *
 * `now` is milliseconds and `ts` is seconds, which is the one thing about this
 * function easy to get backwards, so every case below spells both out.
 */
const NOW = 1_700_000_000_000
const NOW_SECONDS = NOW / 1000

describe('historyAgo', () => {
  it('reads the moment itself as just now', () => {
    expect(historyAgo(NOW_SECONDS, NOW)).toBe('just now')
  })

  it('holds just now up to the last second of the first minute', () => {
    expect(historyAgo(NOW_SECONDS - 59, NOW)).toBe('just now')
  })

  it('turns over to minutes at exactly 60 seconds', () => {
    expect(historyAgo(NOW_SECONDS - 60, NOW)).toBe('1m ago')
  })

  it('holds minutes up to the last minute of the first hour', () => {
    // 59 minutes and 59 seconds: the unit is decided on whole minutes, so the
    // trailing seconds must not round it up into hours.
    expect(historyAgo(NOW_SECONDS - (59 * 60 + 59), NOW)).toBe('59m ago')
  })

  it('turns over to hours at exactly 60 minutes', () => {
    expect(historyAgo(NOW_SECONDS - 3600, NOW)).toBe('1h ago')
  })

  it('holds hours up to the last hour of the first day', () => {
    expect(historyAgo(NOW_SECONDS - (23 * 3600 + 3599), NOW)).toBe('23h ago')
  })

  it('turns over to days at exactly 24 hours', () => {
    expect(historyAgo(NOW_SECONDS - 24 * 3600, NOW)).toBe('1d ago')
  })

  it('counts whole days above that', () => {
    expect(historyAgo(NOW_SECONDS - 9 * 24 * 3600, NOW)).toBe('9d ago')
  })

  it('reads a timestamp from the future as just now rather than a negative age', () => {
    // The shell's clock wrote `ts` and this window's clock reads it. They are
    // allowed to disagree, and `-1m ago` would be the only visible symptom.
    expect(historyAgo(NOW_SECONDS + 30, NOW)).toBe('just now')
  })

  it('takes `now` in milliseconds, not seconds', () => {
    // Passing seconds where milliseconds belong would make everything look
    // ancient. Pinned because the two arguments are both bare numbers and
    // nothing else would catch the mix-up.
    expect(historyAgo(NOW_SECONDS - 3600, NOW_SECONDS)).not.toBe('1h ago')
  })
})
