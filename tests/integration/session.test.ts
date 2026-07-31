import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TmuxAdapter } from '../../src/main/tmux/adapter'
import { PtySession } from '../../src/main/pty/session'

const run = promisify(execFile)
const SOCKET = 'prcli-test'
const adapter = new TmuxAdapter({ socket: SOCKET })
const NAME = 'prcli-lumio-a1b2c3d4e5f60718'

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

/** Collect output until `match` appears, or reject after `ms`. */
function waitForOutput(session: PtySession, match: RegExp, ms = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${match}; saw: ${JSON.stringify(buffer)}`)),
      ms,
    )
    session.onData((data) => {
      buffer += data
      if (match.test(buffer)) {
        clearTimeout(timer)
        resolve(buffer)
      }
    })
  })
}

function open(command?: string): PtySession {
  const session = new PtySession(adapter, {
    tmuxSession: NAME,
    cwd: tmpdir(),
    cols: 80,
    rows: 24,
    command,
  })
  session.start()
  return session
}

beforeAll(killServer)
afterEach(killServer)

describe('PtySession', () => {
  it('creates the tmux session on start', async () => {
    const session = open()
    await waitForOutput(session, /\$|%|#/)
    await expect(adapter.hasSession(NAME)).resolves.toBe(true)
    session.detach()
  })

  it('runs input and streams output back', async () => {
    const session = open()
    await waitForOutput(session, /\$|%|#/)
    session.write('echo prcli-marker\r')
    const output = await waitForOutput(session, /prcli-marker/)
    expect(output).toContain('prcli-marker')
    session.detach()
  })

  it('leaves the tmux session running after detach', async () => {
    const session = open()
    await waitForOutput(session, /\$|%|#/)
    const exited = new Promise<void>((resolve) => session.onExit(() => resolve()))
    session.detach()
    await exited
    await expect(adapter.hasSession(NAME)).resolves.toBe(true)
  })

  it('reattaches to an existing session and keeps its scrollback', async () => {
    const first = open()
    await waitForOutput(first, /\$|%|#/)
    first.write('echo remembered-value\r')
    await waitForOutput(first, /remembered-value/)
    const exited = new Promise<void>((resolve) => first.onExit(() => resolve()))
    first.detach()
    await exited

    const second = open()
    const output = await waitForOutput(second, /remembered-value/)
    expect(output).toContain('remembered-value')
    second.detach()
  })

  it('runs an explicit command when one is given', async () => {
    const session = open('echo command-ran; sleep 30')
    const output = await waitForOutput(session, /command-ran/)
    expect(output).toContain('command-ran')
    session.detach()
  })

  it('exposes 24-bit colour support to the child process', async () => {
    const session = open()
    await waitForOutput(session, /\$|%|#/)
    session.write('echo "TERM=$TERM COLORTERM=$COLORTERM"\r')
    const output = await waitForOutput(session, /COLORTERM=truecolor/)
    expect(output).toMatch(/TERM=(screen|tmux)-256color/)
    session.detach()
  })

  it('disables tmux\'s own status line, which would collide with the app\'s tab bar', async () => {
    const session = open()
    await waitForOutput(session, /\$|%|#/)
    await expect(adapter.getSessionOption(NAME, 'status')).resolves.toBe('off')
    session.detach()
  })
})

/**
 * `remain-on-exit` and the `pane-died` hook go on together or not at all: the
 * option with no hook to reap turns every ordinary `exit` into a session
 * nothing removes, the stray this project has already shipped once.
 *
 * Half of that rule is decided here, in the arguments `start()` builds —
 * before tmux has been asked anything, and before `SessionManager` can install
 * or refuse a hook. So the arguments are what has to be read: a session whose
 * hook was refused for an unsafe reporter starts perfectly normally, and asking
 * tmux afterwards cannot tell "never set" from "set and then unset by
 * `wireDeathHook`". The other half — a hook refused by tmux itself, once the
 * option is already on — is `pane-death.test.ts`'s.
 */
describe('PtySession remain-on-exit', () => {
  let recorderDir: string | undefined

  afterAll(async () => {
    if (recorderDir) await rm(recorderDir, { recursive: true, force: true })
  })

  /** A stand-in for the tmux binary that writes the argv it was handed. */
  async function recordingTmux(): Promise<{ adapter: TmuxAdapter; argv: () => Promise<string[]> }> {
    recorderDir ??= await mkdtemp(join(tmpdir(), 'prcli-argv-'))
    const bin = join(recorderDir, `tmux-${Math.random().toString(16).slice(2)}`)
    const log = `${bin}.argv`
    await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`, 'utf8')
    await chmod(bin, 0o755)
    return {
      // A socket even here: the stub ignores its arguments, but a socket-less
      // adapter is the one mistake that can reach the user's real tmux server,
      // so nothing in this repo gets to be the exception.
      adapter: new TmuxAdapter({ bin, socket: SOCKET }),
      argv: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean),
    }
  }

  function startWith(adapter: TmuxAdapter, deathReporter: string): PtySession {
    const session = new PtySession(adapter, {
      tmuxSession: NAME,
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      command: 'sleep 30',
      deathReporter,
      tabId: 'a1b2c3d4e5f60718',
    })
    session.start()
    return session
  }

  it('chains the option on when a hook can be built for the reporter', async () => {
    const { adapter: recorder, argv } = await recordingTmux()
    const session = startWith(recorder, '/Users/paolo/.prcli/prcli-hook')

    await expect.poll(argv, { timeout: 8000 }).toContain('remain-on-exit')
    session.detach()
  })

  // The paired case, and the one that matters. A single quote ends the quoting
  // the hook command uses to hold a path with a space in it together, so
  // `canBuildDeathHook` refuses — and the option must not go on without it.
  // Without that guard this is a session preserved on every exit with nothing
  // that will ever reap it.
  it('leaves the option off when the reporter path makes a hook unsafe', async () => {
    const { adapter: recorder, argv } = await recordingTmux()
    const session = startWith(recorder, "/Users/o'brien/.prcli/prcli-hook")

    // Wait for the spawn to have happened at all, so this cannot pass by
    // reading an empty log — `status` is chained unconditionally.
    await expect.poll(argv, { timeout: 8000 }).toContain('status')
    expect(await argv()).not.toContain('remain-on-exit')
    session.detach()
  })

  it('leaves the option off when the tab id is not one this app generated', async () => {
    const { adapter: recorder, argv } = await recordingTmux()
    const session = new PtySession(recorder, {
      tmuxSession: NAME,
      cwd: tmpdir(),
      cols: 80,
      rows: 24,
      command: 'sleep 30',
      deathReporter: '/Users/paolo/.prcli/prcli-hook',
      tabId: "abc'; rm -rf /",
    })
    session.start()

    await expect.poll(argv, { timeout: 8000 }).toContain('status')
    expect(await argv()).not.toContain('remain-on-exit')
    session.detach()
  })
})
