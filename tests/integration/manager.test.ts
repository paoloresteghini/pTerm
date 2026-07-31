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

/** What tmux itself thinks the session's window measures. */
async function windowSize(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_width}x#{window_height}',
  ])
  return stdout.trim()
}

/**
 * Every client attached to a session, as `"<pid> <cols>x<rows>"`.
 *
 * The window size is what reflows the pane, but it lags: tmux still reports the
 * old one for a moment after a differently-sized client has attached, so a
 * check made straight after a reattach reads the size that is about to be
 * replaced. The client's own size is settled the instant it appears.
 */
async function clients(name: string): Promise<string[]> {
  try {
    const { stdout } = await run('tmux', [
      '-L', SOCKET, 'list-clients', '-t', `=${name}`, '-F',
      '#{client_pid} #{client_width}x#{client_height}',
    ])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/** The size of the one client that is not `stalePid` — the reattached one. */
async function reattachedSize(name: string, stalePid: string): Promise<string[]> {
  const attached = await clients(name)
  return attached
    .filter((client) => !client.startsWith(`${stalePid} `))
    .map((client) => client.split(' ')[1])
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

/** Resolves with the reason the given tab's client stopped. */
function nextExit(manager: SessionManager, id: string, ms = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${id} to exit`)), ms)
    manager.onExit((record, _code, reason) => {
      if (record.id !== id) return
      clearTimeout(timer)
      resolve(reason)
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

describe('SessionManager.open', () => {
  it('rejects a saved tmux name that disagrees with the id and slug', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    expect(() =>
      manager.open({
        projectSlug: 'lumio',
        cwd: tmpdir(),
        id: 'a1b2c3d4e5f60718',
        tmuxSession: 'prcli-lumio-000000000000000f',
      }),
    ).toThrow(/does not match/i)
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

  // This is what stops a detach from erasing the durable tab record.
  it('reports the exit as detached, not as the child exiting', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    const exit = nextExit(manager, tab.id)
    manager.detach(tab.id)
    await expect(exit).resolves.toBe('detached')
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

  it('reports the exit as killed', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    const exit = nextExit(manager, tab.id)
    await manager.kill(tab.id)
    await expect(exit).resolves.toBe('killed')
  })

  // An orphan that cannot be killed from the app is an invisible leak.
  it('kills a session this app has already detached from', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    manager.detach(tab.id)
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(true)

    await manager.kill(tab.id)
    await expect(adapter.hasSession(tab.tmuxSession)).resolves.toBe(false)
  })

  it('throws rather than resolving when there is nothing to kill', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    await expect(manager.kill('000000000000000f')).rejects.toThrow(/no tmux session found/i)
  })
})

describe('SessionManager.moveToProject', () => {
  /**
   * The reattached client is the session's only one, so tmux resizes the window
   * to match it. Attaching at the 80×24 default therefore re-wraps the user's
   * scrollback — and nothing in the renderer changes size across a move, so no
   * refit follows to put it back.
   */
  it('reattaches at the size the client had, not the default', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'stray', cwd: tmpdir(), cols: 132, rows: 43 })
    await waitFor(manager, tab.id, /\$|%|#/)
    const [stale] = await clients(tab.tmuxSession)
    expect(stale).toMatch(/ 132x43$/)
    expect(await windowSize(tab.tmuxSession)).toBe('132x43')

    const moved = await manager.moveToProject(tab.id, 'lumio')

    expect(moved.tmuxSession).toBe(`prcli-lumio-${tab.id}`)
    const stalePid = stale.split(' ')[0]
    await expect
      .poll(() => reattachedSize(moved.tmuxSession, stalePid), { timeout: 8000 })
      .toEqual(['132x43'])
    // And so the window the pane lives in never shrinks.
    await expect.poll(() => windowSize(moved.tmuxSession), { timeout: 8000 }).toBe('132x43')
    manager.detachAll()
  })

  // The size a tab was opened at is not the size it has: the renderer measures
  // its container and resizes, so the move has to carry the latest one.
  it('carries a later resize through the move', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'stray', cwd: tmpdir(), cols: 132, rows: 43 })
    await waitFor(manager, tab.id, /\$|%|#/)
    manager.resize(tab.id, 101, 37)
    await expect.poll(() => windowSize(tab.tmuxSession), { timeout: 8000 }).toBe('101x37')
    const [stale] = await clients(tab.tmuxSession)

    const moved = await manager.moveToProject(tab.id, 'lumio')

    const stalePid = stale.split(' ')[0]
    await expect
      .poll(() => reattachedSize(moved.tmuxSession, stalePid), { timeout: 8000 })
      .toEqual(['101x37'])
    await expect.poll(() => windowSize(moved.tmuxSession), { timeout: 8000 }).toBe('101x37')
    manager.detachAll()
  })
})

describe('SessionManager exit reason', () => {
  it('is exited when the child ends on its own', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), command: 'true' })
    await expect(nextExit(manager, tab.id)).resolves.toBe('exited')
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
