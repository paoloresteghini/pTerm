import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { TmuxAdapter, TmuxNotInstalledError } from '../../src/main/tmux/adapter'

const run = promisify(execFile)
const SOCKET = 'prcli-test'
const adapter = new TmuxAdapter({ socket: SOCKET })

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
})

describe('TmuxAdapter.killSession', () => {
  it('removes the session', async () => {
    await createSession('prcli-lumio-a1b2c3d4e5f60718')
    await adapter.killSession('prcli-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('prcli-lumio-a1b2c3d4e5f60718')).resolves.toBe(false)
  })

  it('is a no-op for a session that does not exist', async () => {
    await expect(adapter.killSession('prcli-lumio-000000000000000f')).resolves.toBeUndefined()
  })
})
