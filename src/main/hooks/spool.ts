import { readFile, rename, rm } from 'node:fs/promises'
import { parseHookLine, type HookEventMessage } from './protocol'

/**
 * Roughly a day of seven events across twelve sessions, at a few hundred
 * kilobytes of this record size. Past it the oldest go, because the newest
 * are the ones that describe the present.
 *
 * The cap is applied to raw lines, before parsing — see `drainSpool` — not to
 * the parsed events afterwards.
 */
export const MAX_SPOOL_LINES = 4096

/**
 * A day-old `waiting` describes a session that has since been answered,
 * restarted or killed. Replaying it would light a dot for a past.
 */
export const MAX_SPOOL_AGE_MS = 24 * 60 * 60 * 1000

/**
 * Read a file and remove whatever is at that path, tolerating either step
 * failing independently.
 *
 * Missing is the normal case — no events were spooled. Anything else (a
 * permissions error, or a directory sitting where a file should be) is
 * treated the same way: the worst case is losing states the user can rebuild
 * by pressing a key in each session, and that beats a launch that refuses to
 * finish. `recursive` is passed to `rm` so a directory-shaped obstruction —
 * not a real spool, but still capable of jamming every future drain against
 * the same unreadable path — gets cleared rather than left behind forever.
 *
 * The read and the removal are attempted independently, not as one unit: if
 * the read succeeds but the removal then fails for some unrelated reason,
 * the content already captured is still returned rather than thrown away.
 */
async function readAndRemove(path: string): Promise<string> {
  let contents = ''
  try {
    contents = await readFile(path, 'utf8')
  } catch {
    // Nothing readable at this path. `contents` stays ''.
  }
  try {
    await rm(path, { recursive: true, force: true })
  } catch {
    // Whatever was read above is still returned below regardless.
  }
  return contents
}

/**
 * Split spooled content into raw lines.
 *
 * `String.prototype.split` leaves a trailing empty string behind whenever
 * the content ends with the delimiter, which every well-formed spool does
 * (each line, including the last, is written with its own trailing
 * newline). Left in, that phantom line would occupy one slot of the cap
 * below and push out a real one — the off-by-one this function exists to
 * avoid.
 */
function splitLines(content: string): string[] {
  if (content.length === 0) return []
  const lines = content.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Take everything the hook script spooled while the app was down.
 *
 * **Rotate, do not truncate.** A backgrounded hook can append between a read
 * and a truncate, and truncation would swallow it silently. The rename is
 * atomic, and a hook that appends to the old inode afterwards loses one
 * event it was already going to lose.
 *
 * A `.draining` file left by a drain that crashed halfway is picked up
 * first — read and removed before this drain's own rename claims that name —
 * so an interrupted launch costs nothing and the two can never collide.
 *
 * Callers must run this *after* reconciling against live tmux, so events for
 * tabs tmux no longer has are discarded rather than resurrecting dots for
 * dead sessions.
 */
export async function drainSpool(spoolPath: string, nowMs: number): Promise<HookEventMessage[]> {
  const rotated = `${spoolPath}.draining`

  // Whatever a previous interrupted drain left behind, before this one adds to it.
  const leftover = await readAndRemove(rotated)

  let current = ''
  try {
    await rename(spoolPath, rotated)
    current = await readAndRemove(rotated)
  } catch {
    // Nothing to rotate, or a spool that cannot be renamed. Either way there
    // is nothing more to take, and a launch must not fail over it.
  }

  // Capped here, before parsing, rather than after: a spool inflated by a
  // runaway bug into millions of lines must not force this reader to
  // JSON-parse every one of them just to throw most away. Bounding the raw
  // line count trades a contrived loss (a valid line buried under a run of
  // garbage ahead of the newest MAX_SPOOL_LINES) for a resource bound that
  // cannot be defeated by the size of a file this process does not control.
  const rawLines = splitLines(`${leftover}${current}`)
  const capped = rawLines.length > MAX_SPOOL_LINES ? rawLines.slice(-MAX_SPOOL_LINES) : rawLines

  const events: HookEventMessage[] = []
  for (const line of capped) {
    const message = parseHookLine(line)
    if (!message) continue
    // A future `at` is exactly as untrustworthy as a stale one — a clock
    // change or a hand-edited spool, not a real event that just happened.
    // Filtering only the past direction would let such a line through
    // unconditionally, since `nowMs - message.at` goes negative and can
    // never exceed the cap.
    if (Math.abs(nowMs - message.at) > MAX_SPOOL_AGE_MS) continue
    events.push(message)
  }

  return events
}
