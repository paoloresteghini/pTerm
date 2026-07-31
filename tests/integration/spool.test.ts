import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drainSpool, MAX_SPOOL_LINES } from '../../src/main/hooks/spool'
import { formatHookLine } from '../../src/main/hooks/protocol'
import type { HookEvent } from '../../src/main/status/machine'

const ID = '0123456789abcdef'
const NOW = 1_800_000_000_000

let dir: string

async function spoolWith(lines: string[]): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'prcli-spool-'))
  const path = join(dir, 'hook.spool')
  await writeFile(path, lines.join(''), 'utf8')
  return path
}

function line(event: HookEvent, at: number): string {
  return formatHookLine({ tabId: ID, event, at })
}

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('drainSpool', () => {
  it('returns nothing when there is no spool', async () => {
    dir = await mkdtemp(join(tmpdir(), 'prcli-spool-'))
    expect(await drainSpool(join(dir, 'hook.spool'), NOW)).toEqual([])
  })

  it('returns events in the order they were appended', async () => {
    const path = await spoolWith([line('UserPromptSubmit', NOW - 3), line('Notification', NOW - 2)])

    const events = await drainSpool(path, NOW)

    // Append order is chronological, and replaying out of order would land a
    // tab in the state before the one it actually reached.
    expect(events.map((event) => event.event)).toEqual(['UserPromptSubmit', 'Notification'])
  })

  it('removes the spool once drained', async () => {
    const path = await spoolWith([line('Stop', NOW)])

    await drainSpool(path, NOW)

    await expect(readFile(path, 'utf8')).rejects.toThrow()
  })

  it('leaves no rotation file behind', async () => {
    const path = await spoolWith([line('Stop', NOW)])

    await drainSpool(path, NOW)

    expect(await readdir(dir)).toEqual([])
  })

  it('drains a second time to nothing', async () => {
    const path = await spoolWith([line('Stop', NOW)])

    expect(await drainSpool(path, NOW)).toHaveLength(1)
    expect(await drainSpool(path, NOW)).toEqual([])
  })

  it('skips lines it cannot parse and keeps the rest', async () => {
    const path = await spoolWith(['garbage\n', line('Stop', NOW), '\n', '{"partial":\n'])

    const events = await drainSpool(path, NOW)

    expect(events).toHaveLength(1)
    expect(events[0]?.event).toBe('Stop')
  })

  it('discards events older than a day', async () => {
    const path = await spoolWith([
      line('Notification', NOW - 25 * 60 * 60 * 1000),
      line('Stop', NOW - 60 * 1000),
    ])

    const events = await drainSpool(path, NOW)

    // A day-old "waiting" describes a session that has since been answered,
    // restarted or killed. Replaying it would light a dot for a past.
    expect(events.map((event) => event.event)).toEqual(['Stop'])
  })

  it('keeps the newest lines when the file is over the cap', async () => {
    const many: string[] = []
    for (let index = 0; index < MAX_SPOOL_LINES + 500; index += 1) {
      many.push(line('PostToolUse', NOW - (MAX_SPOOL_LINES + 500 - index)))
    }
    many.push(line('Notification', NOW))
    const path = await spoolWith(many)

    const events = await drainSpool(path, NOW)

    expect(events).toHaveLength(MAX_SPOOL_LINES)
    // The newest describe the present; the oldest are what to drop.
    expect(events[events.length - 1]?.event).toBe('Notification')
  })

  // Rotate-not-truncate, from the reader's side: a rotation file left behind
  // by a drain that crashed halfway must not silently lose its events.
  it('picks up a rotation file left by an interrupted drain', async () => {
    const path = await spoolWith([line('Stop', NOW)])
    await writeFile(`${path}.draining`, line('Notification', NOW), 'utf8')

    const events = await drainSpool(path, NOW)

    expect(events.map((event) => event.event).sort()).toEqual(['Notification', 'Stop'])
    expect(await readdir(dir)).toEqual([])
  })

  it('survives an unreadable spool rather than failing the launch', async () => {
    dir = await mkdtemp(join(tmpdir(), 'prcli-spool-'))
    const path = join(dir, 'hook.spool')
    // A directory where a file should be: unreadable in a way no amount of
    // retrying fixes. Restore must still finish.
    await rm(path, { force: true })
    await mkdir(path)

    await expect(drainSpool(path, NOW)).resolves.toEqual([])
  })

  // The brief's own reference implementation checks only
  // `nowMs - message.at > MAX_SPOOL_AGE_MS`, which never trips for a future
  // `at`: the subtraction goes negative and can never exceed a positive
  // ceiling. A future timestamp is exactly as untrustworthy as a stale one —
  // a clock change, or a hand-edited spool — and must be discarded the same
  // way.
  it('discards an event whose timestamp is in the future', async () => {
    const path = await spoolWith([
      line('Notification', NOW + 2 * 24 * 60 * 60 * 1000),
      line('Stop', NOW - 60 * 1000),
    ])

    const events = await drainSpool(path, NOW)

    expect(events.map((event) => event.event)).toEqual(['Stop'])
  })

  // The brief's reference implementation parses every raw line before
  // applying MAX_SPOOL_LINES, capping only the array of successfully parsed
  // events. That means a spool inflated by a runaway bug into millions of
  // garbage lines still gets JSON.parse called on every single one of them
  // before anything is thrown away — the cap does nothing to bound the work.
  // Capping the raw lines first bounds that cost, at the price of this
  // contrived case: a single valid line sitting ahead of a run of garbage
  // that exceeds the cap gets pushed out of the window along with it.
  it('caps by raw line count before parsing, not by parsed event count afterwards', async () => {
    const garbage: string[] = []
    for (let index = 0; index < MAX_SPOOL_LINES; index += 1) {
      garbage.push('not json\n')
    }
    const path = await spoolWith([line('Stop', NOW), ...garbage])

    const events = await drainSpool(path, NOW)

    expect(events).toEqual([])
  })
})
