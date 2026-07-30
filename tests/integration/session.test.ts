import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
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
})
