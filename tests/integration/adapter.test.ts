import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TmuxAdapter, TmuxNotInstalledError } from '../../src/main/tmux/adapter'

const run = promisify(execFile)
const SOCKET = 'prcli-test'
const adapter = new TmuxAdapter({ socket: SOCKET })

let fakeBinDir: string | undefined

/**
 * A stand-in for the tmux binary that always fails with the given stderr.
 * Real tmux cannot be made to produce an unreachable-socket or wedged-server
 * failure on demand, and those are exactly the cases that must not be read as
 * "the session is absent".
 */
async function fakeTmuxFailingWith(stderr: string): Promise<TmuxAdapter> {
  fakeBinDir ??= await mkdtemp(join(tmpdir(), 'prcli-fake-tmux-'))
  const bin = join(fakeBinDir, `tmux-${Math.random().toString(16).slice(2)}`)
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(stderr)} >&2\nexit 1\n`, 'utf8')
  await chmod(bin, 0o755)
  return new TmuxAdapter({ bin })
}

afterAll(async () => {
  if (fakeBinDir) await rm(fakeBinDir, { recursive: true, force: true })
})

async function createSession(name: string): Promise<void> {
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', name, 'sleep', '600'])
}

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running — nothing to clean up.
  }
}

beforeAll(killServer)
afterEach(killServer)

describe('TmuxAdapter.version', () => {
  it('returns the tmux version string', async () => {
    await expect(adapter.version()).resolves.toMatch(/^tmux /)
  })

  it('throws TmuxNotInstalledError when the binary is missing', async () => {
    const missing = new TmuxAdapter({ bin: '/nonexistent/tmux', socket: SOCKET })
    await expect(missing.version()).rejects.toBeInstanceOf(TmuxNotInstalledError)
  })
})

describe('TmuxAdapter.listSessions', () => {
  // tmux words this case differently depending on whether the socket file was
  // ever created, so both paths need covering.
  it('returns an empty array when the socket was never created', async () => {
    const pristine = new TmuxAdapter({ socket: 'prcli-test-never-created' })
    await expect(pristine.listSessions()).resolves.toEqual([])
  })

  it('returns an empty array after the server has been killed', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await killServer()
    await expect(adapter.listSessions()).resolves.toEqual([])
  })

  it('lists session names', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await createSession('someone-elses-session')
    const names = await adapter.listSessions()
    expect(names.sort()).toEqual(['prcli-lumio-a1b2c3d4e5f60718', 'someone-elses-session'])
  })
})

describe('TmuxAdapter.listPrcliSessions', () => {
  it('excludes sessions that are not ours', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await createSession('someone-elses-session')
    await expect(adapter.listPrcliSessions()).resolves.toEqual([
      'prcli-lumio-a1b2c3d4e5f60718',
    ])
  })
})

describe('TmuxAdapter.hasSession', () => {
  it('is true for an existing session and false otherwise', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('prcli-lumio-a1b2c3d4e5f60718')).resolves.toBe(true)
    await expect(adapter.hasSession('prcli-lumio-000000000000000f')).resolves.toBe(false)
  })

  it('does not match on prefix', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('prcli-lumio')).resolves.toBe(false)
  })

  it('is false when there is no server at all', async () => {
    const pristine = new TmuxAdapter({ socket: 'prcli-test-never-created' })
    await expect(pristine.hasSession('prcli-lumio-a1b2c3d4e5f60718')).resolves.toBe(false)
  })

  it('rethrows failures that do not mean the session is absent', async () => {
    const wedged = await fakeTmuxFailingWith('error connecting to /tmp/x (Permission denied)')
    await expect(wedged.hasSession('prcli-lumio-a1b2c3d4e5f60718')).rejects.toThrow(
      /permission denied/i,
    )
  })
})

describe('TmuxAdapter.killSession', () => {
  it('removes the session', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await adapter.killSession('prcli-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('prcli-lumio-a1b2c3d4e5f60718')).resolves.toBe(false)
  })

  it('is a no-op for a session that does not exist', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await expect(adapter.killSession('prcli-lumio-000000000000000f')).resolves.toBeUndefined()
    // The kill must not have resolved by taking anything else with it.
    await expect(adapter.hasSession('prcli-lumio-000000000000000f')).resolves.toBe(false)
    await expect(adapter.hasSession('prcli-lumio-a1b2c3d4e5f60718')).resolves.toBe(true)
  })

  it('rejects when the kill fails and the outcome cannot be verified', async () => {
    const wedged = await fakeTmuxFailingWith('error connecting to /tmp/x (Permission denied)')
    await expect(wedged.killSession('prcli-lumio-a1b2c3d4e5f60718')).rejects.toThrow(
      /permission denied/i,
    )
  })
})

describe('TmuxAdapter session options', () => {
  it('sets and reads back a session option', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await adapter.setSessionOption('prcli-lumio-a1b2c3d4e5f60718', 'status', 'off')
    await expect(adapter.getSessionOption('prcli-lumio-a1b2c3d4e5f60718', 'status'))
      .resolves.toBe('off')
  })

  it('targets exactly one session', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await createSession('prcli-lumio-00000000000000ff')
    await adapter.setSessionOption('prcli-lumio-a1b2c3d4e5f60718', 'status', 'off')
    await expect(adapter.getSessionOption('prcli-lumio-00000000000000ff', 'status'))
      .resolves.not.toBe('off')
  })
})
