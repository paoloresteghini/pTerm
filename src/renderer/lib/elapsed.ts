/**
 * How long a tab has been in the state it is in, as a label.
 *
 * Coarse on purpose: twelve rows counting seconds is motion in the corner of
 * the eye all day, and "which of these is stuck" is not answered better by
 * 4m12s than by 4m.
 *
 * Pure, and given `now` rather than reading the clock, so the component can
 * tick it on its own interval and the tests need no sleeping.
 */

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * `null` means show nothing.
 *
 * Three cases answer null, and they are one idea: there is nothing worth
 * saying. Under a minute, because a label that appears and vanishes within a
 * second of every keystroke is noise. No `since` at all, because the tab has
 * no state. And `now` before `since`, which is not hypothetical on a laptop:
 * an NTP correction or a wake from sleep can move the clock backwards, and a
 * negative or enormous label is worse than none.
 */
export function elapsedLabel(since: number | null, now: number): string | null {
  if (since === null) return null
  const passed = now - since
  if (passed < MINUTE) return null
  // Floored, so the label never claims time that has not passed. That also
  // puts the hour boundary exactly at the hour: 59m59s reads `59m`, and one
  // second later reads `1h`.
  if (passed < HOUR) return `${Math.floor(passed / MINUTE)}m`
  return `${Math.floor(passed / HOUR)}h`
}
