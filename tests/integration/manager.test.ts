import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TmuxAdapter } from '../../src/main/tmux/adapter'
import { SessionManager } from '../../src/main/sessions/manager'
import { encodeSessionName } from '../../src/main/tmux/names'

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

/** A window-scoped option as tmux reads it back, by window id. */
async function windowOption(windowId: string, option: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'show-options', '-w', '-t', windowId, '-v', option,
  ])
  return stdout.trim()
}

/** The window a session is currently showing. */
async function windowIdOf(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_id}',
  ])
  return stdout.trim()
}

/** The window ids a tab's group holds, seen through one of its members. */
async function windowsIn(name: string): Promise<string[]> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'list-windows', '-t', `=${name}:`, '-F', '#{window_id}',
  ])
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** Whether a tmux session by this name currently exists. */
async function sessionExists(name: string): Promise<boolean> {
  try {
    await run('tmux', ['-L', SOCKET, 'has-session', '-t', `=${name}`])
    return true
  } catch {
    return false
  }
}

/** What tmux's session-scoped environment holds for `key`, or `''` if unset. */
async function sessionEnv(name: string, key: string): Promise<string> {
  try {
    const { stdout } = await run('tmux', ['-L', SOCKET, 'show-environment', '-t', `=${name}`, key])
    return stdout.trim()
  } catch {
    return ''
  }
}

/**
 * The pid of the process a session's pane is running, per tmux.
 *
 * Trailing colon on the target: same requirement as `windowIdOf` above —
 * without it this is an exact-match *window* target and tmux answers "can't
 * find pane".
 */
async function panePid(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{pane_pid}',
  ])
  return stdout.trim()
}

/**
 * Whether a process with this pid still exists. Signal `0` sends nothing —
 * it only asks the kernel whether the pid is live — so this cannot disturb
 * the process it is checking.
 */
function isRunning(pid: string): boolean {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
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
afterEach(async () => {
  vi.restoreAllMocks()
  await killServer()
})

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

  it('kills one pane of a split without leaving its window or its process behind', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const founder = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, founder.id, /\$|%|#/)
    const second = await manager.splitTab({ paneId: founder.id, command: 'sleep 600' })
    // Deliberately NO `waitFor` on `second`. Measured during pre-flight: a client
    // attached to a pane running `sleep 600` emits 791 bytes of screen setup and
    // not one `$`, `%` or `#`, so waiting for a prompt here times out at 8s and
    // throws — the test could never pass. There is nothing left to wait for
    // either: `splitTab` has already awaited every tmux call it makes.
    const windows = await windowsIn(founder.tmuxSession)
    expect(windows).toHaveLength(2)
    // Read before the kill — afterwards there is no pane left to ask.
    const pid = await panePid(second.tmuxSession)
    expect(pid).toMatch(/^\d+$/)

    await manager.kill(second.id)

    expect(await sessionExists(second.tmuxSession)).toBe(false)
    await expect.poll(() => windowsIn(founder.tmuxSession), { timeout: 10_000 }).toHaveLength(1)
    // The window is gone, and so is what was running inside it. Asserted on the
    // process rather than inferred from the window count, because "a running
    // command with no session and no UI" is the actual harm this task prevents.
    await expect.poll(() => isRunning(pid), { timeout: 10_000 }).toBe(false)
    expect(await sessionExists(founder.tmuxSession)).toBe(true)
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

describe('SessionManager.splitTab', () => {
  it('adds a pane with its own session, window and tab id', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const first = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, first.id, /\$|%|#/)

    const second = await manager.splitTab({ paneId: first.id })

    expect(second.id).not.toBe(first.id)
    expect(second.tmuxSession).toBe(`prcli-lumio-${second.id}`)
    // Both panes are members of one group, so one tab holds them both.
    const rows = await adapter.listSessionsWithGroups()
    const group = rows.find((row) => row.name === first.tmuxSession)?.group
    expect(group).toBeTruthy()
    expect(rows.find((row) => row.name === second.tmuxSession)?.group).toBe(group)
    // And each pane's process carries its OWN id, not the founder's.
    await expect
      .poll(() => sessionEnv(second.tmuxSession, 'PRCLI_TAB_ID'), { timeout: 10_000 })
      .toBe(`PRCLI_TAB_ID=${second.id}`)
    await expect
      .poll(() => sessionEnv(first.tmuxSession, 'PRCLI_TAB_ID'), { timeout: 10_000 })
      .toBe(`PRCLI_TAB_ID=${first.id}`)
    manager.detachAll()
  })

  // Bind before attach. A newly joined member's current window is arbitrary —
  // measured @0 every time — so attaching first gives the new client a
  // SIBLING's window and, under any non-manual sizing, resizes it. This is the
  // 80x24 geometry defect class in a new disguise.
  //
  // The sizes below are necessary but NOT sufficient, and the difference is
  // the whole point of the option assertion further down. Under
  // `window-size latest` each window is sized by the client that begins
  // viewing it, so both of them read back exactly right while nothing has
  // actually been set — which is how the split pane spent this milestone on
  // `latest` with a `set-option` that exited 0 and did nothing.
  it('binds the new member to its own window, at its own size', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const first = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 100, rows: 30 })
    await waitFor(manager, first.id, /\$|%|#/)

    const second = await manager.splitTab({ paneId: first.id, cols: 200, rows: 50 })
    await waitFor(manager, second.id, /\$|%|#/)

    await expect.poll(() => windowSize(first.tmuxSession), { timeout: 8000 }).toBe('100x30')
    await expect.poll(() => windowSize(second.tmuxSession), { timeout: 8000 }).toBe('200x50')
    manager.detachAll()
  })

  // What the sizes above cannot see. `window-size` is a WINDOW option, so it
  // has to be read back off the window — and set there: a `set-option -t
  // '=<member>:'` resolves to whichever window that member is currently
  // showing, which for a freshly joined one is the FOUNDER's. That call
  // succeeds, sets the founder's window a second time, and leaves the new
  // pane's window on tmux's default.
  //
  // It matters because plan 2's restore attaches a client to this window, and
  // a `latest` window follows whatever size that client arrives at.
  // The other half of `window-size manual`: once it is on, resizing the tmux
  // CLIENT does nothing at all — measured, a manual window ignores a client of
  // a different size — so `resize` has to drive `resize-window` too. Without
  // it a founder pane is frozen at its split-time geometry for the rest of its
  // life, while its sibling (created at the new size) is not, and the two
  // halves of one tab disagree about how wide the tab is.
  it('resizes a split tab\'s window, not only its client', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const first = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 100, rows: 30 })
    await waitFor(manager, first.id, /\$|%|#/)
    const second = await manager.splitTab({ paneId: first.id, cols: 100, rows: 30 })
    await waitFor(manager, second.id, /\$|%|#/)
    expect(await windowSize(first.tmuxSession)).toBe('100x30')

    manager.resize(first.id, 137, 41)
    manager.resize(second.id, 91, 22)

    await expect.poll(() => windowSize(first.tmuxSession), { timeout: 8000 }).toBe('137x41')
    await expect.poll(() => windowSize(second.tmuxSession), { timeout: 8000 }).toBe('91x22')
    manager.detachAll()
  })

  // Everything a split creates after `new-window` is invisible to the app and
  // visible to tmux. An abandoned window sits in the tab's SHARED window list
  // running a shell; an abandoned member session is a name `findOrphans`
  // cannot tell from a real pane, so the next restore would resurrect a pane
  // the user never created, attached to a window nothing has a record of.
  //
  // `respawnPane` is the failure point chosen here because it is the last
  // step, so both objects exist by the time it throws — which is also the
  // real-world case: the placeholder shell dying on its own before the
  // command replaces it.
  it('leaves no window and no member session behind when a split fails', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const first = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, first.id, /\$|%|#/)
    const before = await windowsIn(first.tmuxSession)
    expect(before).toHaveLength(1)

    vi.spyOn(adapter, 'respawnPane').mockRejectedValue(new Error('respawn-pane refused'))

    await expect(
      manager.splitTab({ paneId: first.id, command: 'sleep 600' }),
    ).rejects.toThrow(/respawn-pane refused/)

    // The caller's own error, not the cleanup's — and nothing left over.
    expect(await windowsIn(first.tmuxSession)).toEqual(before)
    await expect(adapter.listPrcliSessions()).resolves.toEqual([first.tmuxSession])
    manager.detachAll()
  })

  it('puts window-size manual on the new pane\'s own window, not the founder\'s', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const first = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 100, rows: 30 })
    await waitFor(manager, first.id, /\$|%|#/)
    const founderWindow = await windowIdOf(first.tmuxSession)

    const second = await manager.splitTab({ paneId: first.id, cols: 200, rows: 50 })
    await waitFor(manager, second.id, /\$|%|#/)

    const splitWindow = await windowIdOf(second.tmuxSession)
    expect(splitWindow).not.toBe(founderWindow)
    expect(await windowOption(splitWindow, 'window-size')).toBe('manual')
    expect(await windowOption(founderWindow, 'window-size')).toBe('manual')
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

  // The cwd used to be synthesised as $HOME, on the reasoning that reattaching
  // does not change a session's directory — true, but the value is not inert:
  // it is what a restart re-creates the session with, and what a move would
  // save over the truth. tmux knows the real one.
  it('reports the session\'s real working directory, not $HOME', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const first = new SessionManager(adapter)
    const cwd = await mkdtemp(join(tmpdir(), 'prcli-orphan-cwd-'))
    const tab = first.open({ projectSlug: 'lumio', cwd })
    await waitFor(first, tab.id, /\$|%|#/)
    first.detachAll()

    const orphans = await new SessionManager(adapter).findOrphans()

    // macOS hands out /var/folders/... as a symlink to /private/var/folders,
    // and tmux reports the resolved path — so compare what the filesystem
    // agrees on rather than the string mkdtemp happened to return.
    expect(await realpath(orphans[0].cwd)).toBe(await realpath(cwd))
    await rm(cwd, { recursive: true, force: true })
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

describe('SessionManager.findOrphanTabs', () => {
  it('groups a split tab\'s panes under one tab id', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const first = new SessionManager(adapter)
    const founder = first.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(first, founder.id, /\$|%|#/)
    const second = await first.splitTab({ paneId: founder.id })
    await waitFor(first, second.id, /\$|%|#/)
    first.detachAll()

    const tabs = await new SessionManager(adapter).findOrphanTabs()

    expect(tabs).toHaveLength(1)
    expect(tabs[0].tabId).toBe(founder.id)
    expect(tabs[0].panes.map((pane) => pane.id).sort()).toEqual([founder.id, second.id].sort())
  })

  it('reports a never-split session as a one-pane tab', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const first = new SessionManager(adapter)
    const only = first.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(first, only.id, /\$|%|#/)
    first.detachAll()

    const tabs = await new SessionManager(adapter).findOrphanTabs()

    expect(tabs).toEqual([
      expect.objectContaining({ tabId: only.id, panes: [expect.objectContaining({ id: only.id })] }),
    ])
  })

  // A group keeps the name its founding session had when the group was
  // created and does not follow a rename (see tabIdFromGroupName) — so once
  // the founder has moved to a different project, the group name still says
  // 'lumio' while the founder's own session name says otherwise. Each pane's
  // projectSlug must come from that pane's own session name, never the
  // group's — a stale slug read off the group would report the founder as
  // still belonging to 'lumio'.
  it('reads each pane\'s own project slug, not the group\'s stale one', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const first = new SessionManager(adapter)
    const founder = first.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(first, founder.id, /\$|%|#/)
    const second = await first.splitTab({ paneId: founder.id })
    await waitFor(first, second.id, /\$|%|#/)

    // Rename the founder's session directly, the way a project move would,
    // without going through SessionManager — the group name tmux tracks is
    // unaffected either way.
    const moved = encodeSessionName({ projectSlug: 'atlas', id: founder.id })
    await adapter.renameSession(founder.tmuxSession, moved)

    first.detachAll()

    const tabs = await new SessionManager(adapter).findOrphanTabs()

    expect(tabs).toHaveLength(1)
    const panes = tabs[0].panes
    expect(panes.find((pane) => pane.id === founder.id)).toMatchObject({ projectSlug: 'atlas' })
    expect(panes.find((pane) => pane.id === second.id)).toMatchObject({ projectSlug: 'lumio' })
  })
})

describe('SessionManager.panesOfTab', () => {
  // A group outlives its founder — measured: the group name and its windows
  // survive and only `group_size` drops. `findOrphanTabs` handled that already
  // because it reads the tab id out of the frozen group name; `panesOfTab`
  // looked for a session whose OWN id was the tab id and answered `[]` when
  // there was none. So the two disagreed about whether a tab existed at
  // exactly the moment this milestone is built around — the founder pane
  // crashed, its sibling still running — and the visible cost was a tab that
  // could never be moved to another project again.
  it('still finds a tab whose founder pane has gone', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const founder = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, founder.id, /\$|%|#/)
    const second = await manager.splitTab({ paneId: founder.id })
    await waitFor(manager, second.id, /\$|%|#/)

    // Straight through the adapter: a founder that died, not one this app
    // closed. The tab id stays the dead founder's, because that is what the
    // group is named after and a group name never follows anything.
    await adapter.killSession(founder.tmuxSession)
    await expect.poll(() => sessionExists(founder.tmuxSession), { timeout: 8000 }).toBe(false)

    const panes = await manager.panesOfTab(founder.id)
    expect(panes.map((pane) => pane.id)).toEqual([second.id])

    // And the tab is movable again, which is what the empty array cost.
    const moved = await manager.moveTabToProject(founder.id, 'gco')
    expect(moved.map((pane) => pane.tmuxSession)).toEqual([`prcli-gco-${second.id}`])
    manager.detachAll()
  })

  it('reports nothing for a tab id no live session or group carries', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, tab.id, /\$|%|#/)
    await expect(manager.panesOfTab('000000000000000f')).resolves.toEqual([])
    manager.detachAll()
  })
})

describe('SessionManager.moveTabToProject', () => {
  it('renames every pane, and the tab still lists under the destination', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const founder = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, founder.id, /\$|%|#/)
    const second = await manager.splitTab({ paneId: founder.id })
    await waitFor(manager, second.id, /\$|%|#/)

    const moved = await manager.moveTabToProject(founder.id, 'gco')

    expect(moved.map((pane) => pane.tmuxSession).sort()).toEqual(
      [`prcli-gco-${founder.id}`, `prcli-gco-${second.id}`].sort(),
    )
    // The stale-slug trap: the GROUP name still says lumio, because a group
    // name does not follow a rename. The tab must still list under gco, which
    // it does only if nothing reads the slug out of the group name.
    const group = await manager.groupNameOf(founder.id)
    expect(group).toContain('lumio')

    // Both panes, read back from live tmux rather than from the return value.
    const panes = await manager.panesOfTab(founder.id)
    expect(panes).toHaveLength(2)          // never assert over a collection
    for (const pane of panes) expect(pane.projectSlug).toBe('gco')
    manager.detachAll()
  })

  // The partial-failure rule, which is the whole reason this is one operation
  // rather than a loop of single-pane moves. A tab split across two projects is
  // the one outcome that must not happen, and tmux refuses a rename onto a name
  // already in use — so the second rename failing must undo the first.
  it('rolls back every rename when one of them fails', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const founder = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, founder.id, /\$|%|#/)
    const second = await manager.splitTab({ paneId: founder.id })
    await waitFor(manager, second.id, /\$|%|#/)

    // Occupy the name the SECOND pane would move to, so its rename is refused
    // while the first pane's has already gone through.
    await run('tmux', [
      '-L', SOCKET, 'new-session', '-d', '-s', `prcli-gco-${second.id}`, 'sleep', '600',
    ])

    await expect(manager.moveTabToProject(founder.id, 'gco')).rejects.toThrow()

    // Neither pane moved: the tab is still whole, and still in lumio.
    const panes = await manager.panesOfTab(founder.id)
    expect(panes).toHaveLength(2)
    for (const pane of panes) expect(pane.projectSlug).toBe('lumio')
    manager.detachAll()
  })

  // The rollback needs one of its own. A rename back can be refused too —
  // something took the source name in the meantime — and the loop used to
  // abort on the spot: every pane it had not reached yet stayed in the
  // destination project, and the error the caller saw was the UNDO's, which
  // describes the recovery rather than the cause and describes it for a tab
  // that is in fact broken.
  it('keeps undoing after one undo is refused, and says the tab may be split', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const founder = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, founder.id, /\$|%|#/)
    for (let i = 0; i < 2; i++) {
      const pane = await manager.splitTab({ paneId: founder.id })
      await waitFor(manager, pane.id, /\$|%|#/)
    }

    // The rename order is `panesOfTab`'s, so take it from there rather than
    // assuming which sibling tmux lists first.
    const order = await manager.panesOfTab(founder.id)
    expect(order).toHaveLength(3)
    const [first, middle, last] = order

    const rename = adapter.renameSession.bind(adapter)
    vi.spyOn(adapter, 'renameSession').mockImplementation(async (from, to) => {
      // The move itself fails on the last pane, so the first two need undoing.
      if (to === `prcli-gco-${last.id}`) throw new Error('destination name in use')
      // And the middle pane's undo is refused, the way a recreated source
      // name would refuse it.
      if (from === `prcli-gco-${middle.id}`) throw new Error('source name in use')
      return rename(from, to)
    })

    await expect(manager.moveTabToProject(founder.id, 'gco')).rejects.toThrow(
      /may now be split across projects/,
    )

    // The undo the loop reached AFTER the refused one still ran.
    expect(await sessionExists(first.tmuxSession)).toBe(true)
    // The one that was refused is where it was left, which is what the
    // message warns about.
    expect(await sessionExists(`prcli-gco-${middle.id}`)).toBe(true)
    // And the pane whose rename failed never moved at all.
    expect(await sessionExists(last.tmuxSession)).toBe(true)
    manager.detachAll()
  })
})

describe('SessionManager tab id in the session environment', () => {
  it('puts the tab id in the session environment, where a hook can read it', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const record = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), type: 'shell' })

    // Ask tmux what the session's environment holds, rather than asking the
    // shell — the shell may not have finished starting, and the session
    // environment is the thing that outlives this client anyway.
    await expect
      .poll(() => sessionEnv(record.tmuxSession, 'PRCLI_TAB_ID'), { timeout: 10_000 })
      .toBe(`PRCLI_TAB_ID=${record.id}`)

    manager.detach(record.id)
  })

  it('keeps the same tab id in the environment across a detach and reattach', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const record = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), type: 'shell' })
    await expect.poll(async () => sessionExists(record.tmuxSession), { timeout: 10_000 }).toBe(true)

    manager.detach(record.id)
    const again = manager.open({
      id: record.id,
      projectSlug: 'lumio',
      cwd: tmpdir(),
      tmuxSession: record.tmuxSession,
      type: 'shell',
    })

    // The id is the second half of the session name and does not change, so a
    // reattached session's environment is already correct — which is why tmux
    // not updating it on reattach is right rather than a limitation.
    expect(again.id).toBe(record.id)
    await expect
      .poll(() => sessionEnv(record.tmuxSession, 'PRCLI_TAB_ID'), { timeout: 10_000 })
      .toBe(`PRCLI_TAB_ID=${record.id}`)

    manager.detach(record.id)
  })

  // The literal fix — merging the id into the spawned tmux client's own
  // process env — passes the two tests above but fails this one: tmux does
  // not populate a session's environment from the env of whatever process
  // happened to run `new-session`. That only seeds the tmux *server's*
  // global environment, and only once, at server start. A second session
  // opened later on the same (already-running) server would silently read
  // back the *first* session's id instead of its own. `-e` on `new-session`
  // is what actually scopes it per session.
  it('gives two sessions on the same server their own distinct tab id', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const first = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), type: 'shell' })
    const second = manager.open({ projectSlug: 'gco', cwd: tmpdir(), type: 'shell' })
    expect(first.id).not.toBe(second.id)

    await expect
      .poll(() => sessionEnv(first.tmuxSession, 'PRCLI_TAB_ID'), { timeout: 10_000 })
      .toBe(`PRCLI_TAB_ID=${first.id}`)
    await expect
      .poll(() => sessionEnv(second.tmuxSession, 'PRCLI_TAB_ID'), { timeout: 10_000 })
      .toBe(`PRCLI_TAB_ID=${second.id}`)

    manager.detach(first.id)
    manager.detach(second.id)
  })

  it('carries the tab type on the record and through a move', async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const record = manager.open({
      projectSlug: 'lumio',
      cwd: tmpdir(),
      command: 'sleep 600',
      type: 'preset',
    })
    await expect.poll(async () => sessionExists(record.tmuxSession), { timeout: 10_000 }).toBe(true)

    const moved = await manager.moveToProject(record.id, 'gco')

    // A tab that was a preset before the move is still a preset after it.
    expect(moved.type).toBe('preset')
    manager.detach(moved.id)
  })

  it('defaults an unspecified type to shell', () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const record = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    expect(record.type).toBe('shell')
    manager.detach(record.id)
  })
})
