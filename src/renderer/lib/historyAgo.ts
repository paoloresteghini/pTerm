/**
 * How long ago `ts` happened, in the coarsest unit that still says something.
 *
 * `ts` is epoch SECONDS, which is what the zsh hook writes and what
 * `HistoryEntry` documents, while `now` is epoch MILLISECONDS because that is
 * what `Date.now()` returns. The conversion is here so no caller has to
 * remember which side it is on, and `now` is a parameter rather than read from
 * the clock so this stays a pure function of two numbers.
 *
 * In a module of its own rather than beside the component that draws it, for
 * the reason `relativeToProject` gives: vitest runs `environment: 'node'`, so
 * nothing here can mount `HistoryOverlay`, and arithmetic left inside it would
 * be reachable only from e2e.
 *
 * A `ts` in the future reads as `just now` rather than as a negative age. The
 * clock that wrote it is the shell's and the clock reading it is this window's,
 * and they are allowed to disagree by a second or two.
 */
export function historyAgo(ts: number, now: number): string {
  const seconds = Math.floor(now / 1000) - ts
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
