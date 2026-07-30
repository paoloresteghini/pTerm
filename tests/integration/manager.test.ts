import { describe, it, expect, afterEach, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { TmuxAdapter } from '../../src/main/tmux/adapter'
import { SessionManager } from '../../src/main/sessions/manager'

const run = promisify(execFile)
const SOCKET = 'prcli-test'

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

function waitFor(
  manager: SessionManager,
  id: string,
  match: RegExp,
  ms = 8000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${match}; saw: ${JSON.stringify(buffer)}`)),
      ms,
    )
    manager.onData((emittedId, data) => {
      if (emittedId !== id) return
      buffer += data
      if (match.test(buffer)) {
        clearTimeout(timer)
        resolve(buffer)
      }
    })
  })
}

beforeAll(killServer)
afterEach(killServer)

describe('SessionManager.open', () => {
  it('returns a record with a generated id and encoded tmux name', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    expect(tab.id).toMatch(/^[0-9a-f]{16}$/)
    expect(tab.tmuxSession).toBe(`prcli-lumio-${tab.id}`)
    await waitFor(manager, tab.id, /\$|%|#/)
    manager.detachAll()
  })

  it('reuses a supplied id so a tab can be reattached', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), id: 'a1b2c3d4e5f60718' })
    expect(tab.tmuxSession).toBe('prcli-lumio-a1b2c3d4e5f60718')
    await waitFor(manager, tab.id, /\$|%|#/)
    manager.detachAll()
  })

  it('rejects opening the same id twice', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    expect(() => manager.open({ projectSlug: 'lumio', cwd: tmpdir(), id: tab.id }))
      .toThrow(/already open/i)
    manager.detachAll()
  })
})

describe('SessionManager.write', () => {
  it('routes input to the right session', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    manager.write(tab.id, 'echo routed-ok\r')
    await expect(waitFor(manager, tab.id, /routed-ok/)).resolves.toContain('routed-ok')
    manager.detachAll()
  })
})

describe('SessionManager.detach', () => {
  it('removes the tab from the registry but keeps the tmux session', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    manager.detach(tab.id)
    expect(manager.get(tab.id)).toBeUndefined()
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(true)
  })
})

describe('SessionManager.kill', () => {
  it('destroys the tmux session', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    await manager.kill(tab.id)
    expect(manager.get(tab.id)).toBeUndefined()
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(false)
  })
})

describe('SessionManager.findOrphans', () => {
  it('reports prcli sessions that are not currently open', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const first = new SessionManager(adapter)
    const tab = first.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(first, tab.id, /\$|%|#/)
    first.detachAll()

    const second = new SessionManager(adapter)
    const orphans = await second.findOrphans()
    expect(orphans).toHaveLength(1)
    expect(orphans[0]).toMatchObject({
      id: tab.id,
      projectSlug: 'lumio',
      tmuxSession: tab.tmuxSession,
    })
  })

  it('ignores sessions that are already open', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    await expect(manager.findOrphans()).resolves.toEqual([])
    manager.detachAll()
  })

  it('ignores foreign tmux sessions', async () => {
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'not-ours', 'sleep', '600'])
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    await expect(manager.findOrphans()).resolves.toEqual([])
  })
})
