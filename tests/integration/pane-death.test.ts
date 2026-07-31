import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TmuxAdapter } from '../../src/main/tmux/adapter'
import { SessionManager } from '../../src/main/sessions/manager'
import { HookServer } from '../../src/main/hooks/server'
import { renderScript } from '../../src/main/hooks/install'
import type { HookLine } from '../../src/main/hooks/protocol'

const run = promisify(execFile)
const SOCKET = 'prcli-test'

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

async function sessionExists(name: string): Promise<boolean> {
  try {
    await run('tmux', ['-L', SOCKET, 'has-session', '-t', `=${name}`])
    return true
  } catch {
    return false
  }
}

let dir: string
let hookServer: HookServer | null = null
let manager: SessionManager | null = null

/**
 * A manager wired to a real reporter script and a real socket server.
 *
 * The socket lives in a short temp path on purpose: `HookServer` refuses a
 * path over 104 bytes, which a nested temp directory would exceed.
 */
async function harness(): Promise<{ manager: SessionManager; received: HookLine[] }> {
  dir = await mkdtemp(join(tmpdir(), 'prcli-death-'))
  const paths = {
    script: join(dir, 'prcli-hook'),
    socket: join(dir, 'h.sock'),
    spool: join(dir, 'h.spool'),
  }
  await writeFile(paths.script, renderScript(paths), 'utf8')
  await chmod(paths.script, 0o755)

  hookServer = new HookServer(paths.socket)
  await hookServer.start()
  const received: HookLine[] = []
  hookServer.onEvent((message) => received.push(message))

  manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }), {
    deathReporter: paths.script,
  })
  return { manager, received }
}

beforeAll(killServer)

afterEach(async () => {
  await killServer()
  await hookServer?.stop()
  hookServer = null
  manager = null
  await rm(dir, { recursive: true, force: true })
})

describe('a pane that dies', () => {
  it('reports the status its command exited with', async () => {
    const { manager: sessions, received } = await harness()

    const record = sessions.open({
      projectSlug: 'alpha',
      cwd: dir,
      command: 'sh -c "exit 3"',
      type: 'preset',
    })

    await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThan(0)
    expect(received[0]).toEqual({
      tabId: record.id,
      event: 'Exit',
      status: 3,
      at: expect.any(Number),
    })
  })

  it('reports a clean exit as a status of zero, not as silence', async () => {
    const { manager: sessions, received } = await harness()

    const record = sessions.open({
      projectSlug: 'alpha',
      cwd: dir,
      command: 'sh -c "exit 0"',
      type: 'preset',
    })

    await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThan(0)
    expect(received[0]).toMatchObject({ tabId: record.id, event: 'Exit', status: 0 })
  })

  // `remain-on-exit` is what makes the status readable at all, and it also
  // stops tmux reaping the session on its own. If the hook did not kill it,
  // every crashed tab would leave a session behind — the stray-session failure
  // this project has already had once.
  it('leaves no tmux session behind', async () => {
    const { manager: sessions, received } = await harness()

    const record = sessions.open({
      projectSlug: 'alpha',
      cwd: dir,
      command: 'sh -c "exit 3"',
      type: 'preset',
    })

    await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThan(0)
    await expect
      .poll(() => sessionExists(record.tmuxSession), { timeout: 10_000 })
      .toBe(false)
  })
})
