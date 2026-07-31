import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:net'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderScript } from '../../src/main/hooks/install'
import { parseHookLine } from '../../src/main/hooks/protocol'

const ID = '0123456789abcdef'

let dir: string
let server: Server | null = null

/** Write the rendered script to a temp dir and make it executable. */
async function install(): Promise<{ script: string; socket: string; spool: string }> {
  dir = await mkdtemp(join(tmpdir(), 'prcli-hook-'))
  const paths = { script: join(dir, 'prcli-hook'), socket: join(dir, 'h.sock'), spool: join(dir, 'h.spool') }
  await writeFile(paths.script, renderScript(paths), 'utf8')
  await chmod(paths.script, 0o755)
  return paths
}

/**
 * Run the script the way Claude does: argv[1] is the event name.
 *
 * `status` is the second argument tmux's `pane-died` hook passes and Claude
 * never does — optional here for exactly that reason, so every Claude-shaped
 * call in this file stays a one-argument call.
 */
function runHook(
  script: string,
  event: string,
  tabId: string | undefined,
  status?: string,
  signal?: string,
): Promise<{ ms: number; stdout: string; code: number }> {
  const started = Date.now()
  const args = [event]
  if (status !== undefined) args.push(status)
  if (signal !== undefined) args.push(signal)
  return new Promise((resolve, reject) => {
    execFile(
      script,
      args,
      {
        timeout: 5_000,
        env: tabId === undefined ? { PATH: process.env.PATH ?? '' } : { PATH: process.env.PATH ?? '', PRCLI_TAB_ID: tabId },
      },
      (error, stdout) => {
        if (error && typeof error.code !== 'number') return reject(error)
        resolve({ ms: Date.now() - started, stdout, code: typeof error?.code === 'number' ? error.code : 0 })
      },
    )
  })
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = null
  await rm(dir, { recursive: true, force: true })
})

describe('prcli-hook', () => {
  it('delivers a line to a listening socket', async () => {
    const paths = await install()
    const received: string[] = []
    server = createServer((connection) => {
      connection.on('data', (chunk) => received.push(String(chunk)))
    })
    await new Promise<void>((resolve) => server?.listen(paths.socket, resolve))

    await runHook(paths.script, 'Notification', ID)

    await expect
      .poll(() => received.length, { timeout: 4_000 })
      .toBeGreaterThan(0)
    const message = parseHookLine(received.join(''))
    expect(message).toEqual({ tabId: ID, event: 'Notification', at: expect.any(Number) })
  })

  it("carries a dead pane's exit status when tmux passes one", async () => {
    const paths = await install()
    const received: string[] = []
    server = createServer((connection) => {
      connection.on('data', (chunk) => received.push(String(chunk)))
    })
    await new Promise<void>((resolve) => server?.listen(paths.socket, resolve))

    await runHook(paths.script, 'Exit', ID, '3')

    await expect.poll(() => received.length, { timeout: 4_000 }).toBeGreaterThan(0)
    expect(parseHookLine(received.join(''))).toEqual({
      tabId: ID,
      event: 'Exit',
      status: 3,
      at: expect.any(Number),
    })
  })

  // A pane killed by a signal reports an empty status and the signal's name,
  // so the line has to carry the name or the crash arrives explaining nothing.
  it('carries the signal name when the pane was killed rather than exited', async () => {
    const paths = await install()
    const received: string[] = []
    server = createServer((connection) => {
      connection.on('data', (chunk) => received.push(String(chunk)))
    })
    await new Promise<void>((resolve) => server?.listen(paths.socket, resolve))

    await runHook(paths.script, 'Exit', ID, '', 'kill')

    await expect.poll(() => received.length, { timeout: 4_000 }).toBeGreaterThan(0)
    expect(parseHookLine(received.join(''))).toEqual({
      tabId: ID,
      event: 'Exit',
      signal: 'kill',
      at: expect.any(Number),
    })
  })

  it('writes nothing when a death reports neither a status nor a signal', async () => {
    const paths = await install()

    const { code } = await runHook(paths.script, 'Exit', ID, '', '')

    expect(code).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await expect(readFile(paths.spool, 'utf8')).rejects.toThrow()
  })

  it('writes nothing at all when handed a signal that is not a name', async () => {
    const paths = await install()

    const { code } = await runHook(paths.script, 'Exit', ID, '', 'kill","evil":"1')

    expect(code).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await expect(readFile(paths.spool, 'utf8')).rejects.toThrow()
  })

  // The status is interpolated into JSON *unquoted* — it has to be, or it
  // would arrive as a string and the parser would refuse it. That makes this
  // the one field where a non-numeric argument would escape its own value, so
  // the script checks the shape before building the line rather than trusting
  // where the argument came from.
  it('writes nothing at all when handed a status that is not a number', async () => {
    const paths = await install()

    const { code } = await runHook(paths.script, 'Exit', ID, '3,"evil":true')

    expect(code).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 500))
    await expect(readFile(paths.spool, 'utf8')).rejects.toThrow()
  })

  // The measured reason the write is backgrounded. Apple's nc does not exit
  // when the server closes, so a foreground write costs ~1s with -w 1 and
  // hangs without it — seven times a turn, across twelve sessions, with
  // PreToolUse blocking Claude while it runs.
  it('returns in milliseconds, not seconds, even with a server that never replies', async () => {
    const paths = await install()
    server = createServer(() => {
      // Accept and say nothing at all.
    })
    await new Promise<void>((resolve) => server?.listen(paths.socket, resolve))

    const { ms, code } = await runHook(paths.script, 'Stop', ID)

    expect(code).toBe(0)
    expect(ms).toBeLessThan(500)
  })

  it('exits 0 and spools when nothing is listening', async () => {
    const paths = await install()

    const { code } = await runHook(paths.script, 'Stop', ID)

    expect(code).toBe(0)
    await expect
      .poll(async () => {
        try {
          return (await readFile(paths.spool, 'utf8')).length
        } catch {
          return 0
        }
      }, { timeout: 4_000 })
      .toBeGreaterThan(0)
    const spooled = parseHookLine((await readFile(paths.spool, 'utf8')).trim())
    expect(spooled?.event).toBe('Stop')
  })

  it('appends rather than overwriting, so concurrent hooks do not lose each other', async () => {
    const paths = await install()

    await Promise.all([
      runHook(paths.script, 'Stop', ID),
      runHook(paths.script, 'Notification', ID),
      runHook(paths.script, 'PreToolUse', ID),
    ])

    await expect
      .poll(async () => {
        try {
          return (await readFile(paths.spool, 'utf8')).trim().split('\n').filter(Boolean).length
        } catch {
          return 0
        }
      }, { timeout: 4_000 })
      .toBe(3)
  })

  it('writes nothing at all when the tab id is absent', async () => {
    const paths = await install()

    const { code } = await runHook(paths.script, 'Stop', undefined)

    expect(code).toBe(0)
    // A Claude session started outside PRCLI fires these too. It must cost
    // nothing and leave nothing behind.
    await expect(readFile(paths.spool, 'utf8')).rejects.toThrow()
  })

  it('writes nothing when the tab id is not a tab id', async () => {
    const paths = await install()

    const { code } = await runHook(paths.script, 'Stop', 'not-a-tab-id"; rm -rf /')

    expect(code).toBe(0)
    await expect(readFile(paths.spool, 'utf8')).rejects.toThrow()
  })

  // The brief's own validation — `case "$id" in *[!0-9a-f]*) exit 0 ;; esac` —
  // only rejects a character outside 0-9a-f. A string that is entirely valid
  // hex but the wrong length (here, 7 chars instead of 16) contains no such
  // character, so that pattern falls through without exiting and the value
  // reaches the socket/spool write despite failing the documented "16 hex
  // characters" contract and protocol.ts's own TAB_ID_RE. Fixed by matching
  // the id against an exact 16-hex-character pattern instead of a charset-only
  // negation.
  //
  // The wait after runHook matters: against the buggy version the write is
  // still issued (just with a bad id), and it happens in the backgrounded
  // subshell, so it can land a few milliseconds *after* the foreground
  // process has already exited and this test's immediate readFile would race
  // it and pass for the wrong reason. Waiting first makes the assertion
  // about the write that did or didn't happen, not about a timing accident.
  it('writes nothing when the tab id is valid hex but the wrong length', async () => {
    const paths = await install()

    const { code } = await runHook(paths.script, 'Stop', '0123abc')
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(code).toBe(0)
    await expect(readFile(paths.spool, 'utf8')).rejects.toThrow()
  })

  it('produces no output, so Claude sees nothing on stdout', async () => {
    const paths = await install()

    const { stdout } = await runHook(paths.script, 'Stop', ID)

    expect(stdout).toBe('')
  })

  it('refuses to render against a path that would break the quoting', () => {
    expect(() => renderScript({ socket: '/tmp/a"b/h.sock', spool: '/tmp/h.spool' })).toThrow()
    expect(() => renderScript({ socket: '/tmp/h.sock', spool: '/tmp/$HOME/h.spool' })).toThrow()
  })
})
