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

/** The hooks installed on a window, as `show-hooks -w` prints them. */
async function hooksOf(windowId: string): Promise<string> {
  const { stdout } = await run('tmux', ['-L', SOCKET, 'show-hooks', '-w', '-t', windowId])
  return stdout
}

/** The window ids a tab's group holds, seen through one of its members. */
async function windowsIn(name: string): Promise<string[]> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'list-windows', '-t', `=${name}:`, '-F', '#{window_id}',
  ])
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/**
 * Every window on the whole server, whatever session it is linked into.
 *
 * `windowsIn` asks a session, which is no use for proving a window was
 * reaped: the session that leaked it may be gone while the window it left
 * behind is still linked into a sibling's list.
 */
async function allWindows(): Promise<string[]> {
  try {
    const { stdout } = await run('tmux', ['-L', SOCKET, 'list-windows', '-a', '-F', '#{window_id}'])
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    // No server left at all, which is the strongest form of "that window is
    // gone". Callers assert this list CONTAINS the window first, so an empty
    // answer can never be the reason a later `not.toContain` passes.
    return []
  }
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

  // The window must end up at the size the CLIENT was given, whatever size the
  // window happened to be beforehand. Under `manual` it will not follow on its
  // own, and `latest` is no longer reliable once anything has called resize-window.
  it('sizes the window to the client on every attach, not only the first', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter)
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 100, rows: 30 })
    await waitFor(manager, tab.id, /\$|%|#/)
    // Force the window to `manual` at a different size, exactly as a renderer
    // resize would, then drop the client.
    manager.resize(tab.id, 140, 45)
    await expect.poll(() => windowSize(tab.tmuxSession), { timeout: 8000 }).toBe('140x45')
    manager.detach(tab.id)

    // Reattach at a third size. Nothing else will correct this.
    const again = manager.open({
      id: tab.id, projectSlug: 'lumio', cwd: tmpdir(),
      tmuxSession: tab.tmuxSession, type: tab.type, cols: 120, rows: 40,
    })
    await waitFor(manager, again.id, /\$|%|#/)

    await expect.poll(() => windowSize(tab.tmuxSession), { timeout: 8000 }).toBe('120x40')
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

  // The rollback's own defect, mirrored: a pane renamed back to its old name
  // while its hook still names the one it was briefly renamed to is exactly
  // the same staleness this task closes, just reached from the undo side
  // instead of the forward one.
  it('restores a rolled-back pane\'s hook to its original name too, not only the session', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const manager = new SessionManager(adapter, {
      deathReporter: join(tmpdir(), 'prcli-hook-test-reporter'),
    })
    const founder = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, founder.id, /\$|%|#/)
    await expect
      .poll(async () => hooksOf(await windowIdOf(founder.tmuxSession)), { timeout: 10_000 })
      .toContain('pane-died')
    const second = await manager.splitTab({ paneId: founder.id })
    await waitFor(manager, second.id, /\$|%|#/)

    // Occupy the name the SECOND pane would move to, so its rename is refused
    // while the founder's has already gone through — and already picked up a
    // hook naming the destination it will shortly be undone out of.
    await run('tmux', [
      '-L', SOCKET, 'new-session', '-d', '-s', `prcli-gco-${second.id}`, 'sleep', '600',
    ])

    await expect(manager.moveTabToProject(founder.id, 'gco')).rejects.toThrow()

    // The founder's session is back under its original name...
    expect(await sessionExists(founder.tmuxSession)).toBe(true)
    // ...and so is its hook: naming the session as restored, never the
    // destination it was renamed to and then undone from.
    const hooks = await hooksOf(await windowIdOf(founder.tmuxSession))
    expect(hooks).toContain(`=${founder.tmuxSession}`)
    expect(hooks).not.toContain(`prcli-gco-${founder.id}`)
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

  // The residue plan 1 left behind: hooks used to be reinstalled in a second
  // loop, only after every rename had already landed. So a pane dying between
  // two renames still met a hook naming the session that FIRST rename had
  // just made stop existing — and `kill-session` is the first command in that
  // hook, so its failure forfeits the `kill-window` after it (measured, see
  // `deathHookCommand`). The dead pane, its window and its now-orphaned
  // session are all left behind.
  //
  // A real kill was tried and rejected: it can be timed deterministically
  // through the same `renameSession` spy used below, but the aftermath is not
  // about this residue at all. `moveTabToProject`'s own reattach recreates a
  // killed pane's session with a bare `new-session -A`, which — reaped
  // correctly or not — falls straight out of the tab's tmux group, a real and
  // separate defect this task does not touch. Asserting through that would
  // make the test about group membership, not about stale hooks. So this
  // asserts the invariant the residue violates directly: before EVERY rename
  // in the loop, every hook this run has already installed for an earlier
  // pane is read back from tmux, and the session it names is checked to still
  // exist. A hook only reinstalled after the whole loop fails this the moment
  // the second pane's rename begins; one reinstalled alongside its own rename
  // never does.
  it('never leaves a hook naming a session that an earlier rename in the same move has already renamed away', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    // `wireDeathHook` returns on its first line with no `deathReporter` — a
    // manager built without one installs no hooks at all, and every check
    // below would pass vacuously.
    const manager = new SessionManager(adapter, {
      deathReporter: join(tmpdir(), 'prcli-hook-test-reporter'),
    })

    const founder = manager.open({ projectSlug: 'lumio', cwd: tmpdir() })
    await waitFor(manager, founder.id, /\$|%|#/)
    // `open()`'s hook installs asynchronously, once its session exists.
    // Renaming out from under it before that lands would test nothing.
    await expect
      .poll(async () => hooksOf(await windowIdOf(founder.tmuxSession)), { timeout: 10_000 })
      .toContain('pane-died')
    const second = await manager.splitTab({ paneId: founder.id })
    await waitFor(manager, second.id, /\$|%|#/)

    const order = await manager.panesOfTab(founder.id)
    expect(order.length).toBeGreaterThan(0) // never iterate a pane list unchecked
    const windowIds: string[] = []
    for (const pane of order) windowIds.push(await windowIdOf(pane.tmuxSession))

    const violations: string[] = []
    const rename = adapter.renameSession.bind(adapter)
    vi.spyOn(adapter, 'renameSession').mockImplementation(async (from, to) => {
      for (const windowId of windowIds) {
        const hooks = await hooksOf(windowId)
        const match = hooks.match(/kill-session -t =(\S+)/)
        if (match && !(await sessionExists(match[1]))) {
          violations.push(`${windowId} still names ${match[1]}: ${hooks.trim()}`)
        }
      }
      return rename(from, to)
    })

    const moved = await manager.moveTabToProject(founder.id, 'gco')
    expect(moved.length).toBeGreaterThan(0)

    expect(violations).toEqual([])

    // And by the time the move has returned, every pane's hook names its
    // CURRENT session, never the one it came from.
    for (const pane of moved) {
      const hooks = await hooksOf(await windowIdOf(pane.tmuxSession))
      expect(hooks).toContain(`=${pane.tmuxSession}`)
      expect(hooks).not.toContain('prcli-lumio-')
    }
    manager.detachAll()
  })
})

/**
 * The window lookup an attach starts is a poll: `lookupWindow` answers `gone`
 * for a session tmux has not finished creating, so asking once would leave most
 * tabs with no hook. Before this branch it ran only for a manager with a death
 * reporter; Task 5 gave it a second caller on every attach. Nothing ever ended
 * one early, and a session that never appears costs ~370 `tmux` spawns.
 */
describe('SessionManager window lookup', () => {
  const idle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('stops polling for a window once the pane it was opened for has gone', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    // The answer the poll keeps going on. A real dead-or-never-created session
    // gives exactly this, and so does a tmux server that has been killed under
    // a still-running test file.
    let calls = 0
    vi.spyOn(adapter, 'lookupWindow').mockImplementation(async () => {
      calls += 1
      return { kind: 'gone' }
    })
    const manager = new SessionManager(adapter, {
      deathReporter: join(tmpdir(), 'prcli-hook-test-reporter'),
    })
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 100, rows: 30 })

    await idle(250)
    const whilePolling = calls
    // It really was polling, so "it stopped" below cannot pass on a poll that
    // never started. At 20ms this is a dozen or so calls.
    expect(whilePolling).toBeGreaterThan(2)

    manager.detach(tab.id)
    await idle(250)
    const settled = calls
    await idle(250)

    // Stopped dead, not merely slowed: the answer in flight when the pane was
    // detached is allowed to land, nothing after it.
    expect(calls).toBe(settled)
    expect(settled).toBeLessThanOrEqual(whilePolling + 2)
    manager.detachAll()
  })

  // Task 5's own deferred item: `wireDeathHook` and `sizeWindowOnAttach` each
  // ran their own poll of the same session, so a manager with a reporter had
  // two in flight per attach and twice the spawns for an attach that never
  // resolves.
  it('runs one lookup per attach, not one per thing that wants it', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const real = adapter.lookupWindow.bind(adapter)
    // Concurrency, not a call count: a count has to be compared against a
    // baseline that depends on how long tmux takes to make the session, while
    // "two polls of one session" is visible directly as two lookups in flight
    // at once. The delay is what makes that certain rather than likely — two
    // independent polls start in the same tick.
    let inFlight = 0
    let peak = 0
    vi.spyOn(adapter, 'lookupWindow').mockImplementation(async (name) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        await idle(30)
        return await real(name)
      } finally {
        inFlight -= 1
      }
    })
    const manager = new SessionManager(adapter, {
      deathReporter: join(tmpdir(), 'prcli-hook-test-reporter'),
    })
    // Both consumers want a window here: the hook (a reporter is set) and the
    // attach-time resize (a size is given).
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 100, rows: 30 })
    await expect
      .poll(async () => hooksOf(await windowIdOf(tab.tmuxSession)), { timeout: 10_000 })
      .toContain('pane-died')
    await expect.poll(() => windowSize(tab.tmuxSession), { timeout: 8000 }).toBe('100x30')

    // Something was looked up at all, and never twice at once.
    expect(peak).toBe(1)
    manager.detachAll()
  })
})

/**
 * A member whose OWN window has died silently falls back onto a sibling's —
 * measured on tmux 3.7b, in both directions — and its session survives.
 * `restoreWorkspace` is the only place in the app that knew about this state;
 * everywhere else `display-message -t '=member:' '#{window_id}'` was taken to
 * mean "the window this pane's process is in", which for such a member names
 * the SIBLING's window and its sibling's process.
 *
 * Each test below writes to a window through the fallen-back member and
 * asserts the sibling is untouched: its geometry, its process, its hook.
 */
describe('SessionManager and a member that has fallen back onto a sibling window', () => {
  /**
   * Split a tab, then kill the second pane's window only. Its client goes
   * first, because killing a window under an attached client is a different
   * sequence — this reproduces a pane whose process died and was reaped while
   * the app was not looking, which is what leaves the member behind.
   */
  async function fallenBack(manager: SessionManager) {
    const founder = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 120, rows: 40 })
    await waitFor(manager, founder.id, /\$|%|#/)
    const second = await manager.splitTab({ paneId: founder.id, cols: 100, rows: 30 })
    const founderWindow = await windowIdOf(founder.tmuxSession)
    const secondWindow = await windowIdOf(second.tmuxSession)
    expect(founderWindow).toMatch(/^@\d+$/)
    expect(secondWindow).not.toBe(founderWindow)

    manager.detach(second.id)
    await run('tmux', ['-L', SOCKET, 'kill-window', '-t', secondWindow])
    // The fallback itself, asserted rather than assumed: without it every
    // test below would be about an ordinary split and would pass on anything.
    await expect.poll(() => windowIdOf(second.tmuxSession), { timeout: 8000 }).toBe(founderWindow)
    expect(await sessionExists(second.tmuxSession)).toBe(true)
    return { founder, second, founderWindow }
  }

  // New with Task 5: before it there was no attach-time `resize-window` at
  // all, so one pane's reattach could not reshape its sibling.
  it("does not resize the sibling's window when it reattaches", async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const { founder, second, founderWindow } = await fallenBack(manager)
    expect(await windowSize(founder.tmuxSession)).toBe('120x40')

    manager.open({
      id: second.id, projectSlug: 'lumio', cwd: tmpdir(),
      tmuxSession: second.tmuxSession, cols: 60, rows: 20,
    })
    // The client really did attach — otherwise "the window did not change"
    // would be true because nothing happened at all.
    await expect.poll(() => clients(second.tmuxSession), { timeout: 8000 }).toHaveLength(1)
    // An attach's window sizing is asynchronous: it has to wait for tmux to
    // name a window before it can resize one, measured at ~25ms. A second is
    // two orders of magnitude of headroom, and this assertion is RED without
    // the ownership check — so the wait is demonstrably long enough to catch
    // the resize it is asserting does not happen.
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(await windowSize(founder.tmuxSession)).toBe('120x40')
    expect(await windowIdOf(founder.tmuxSession)).toBe(founderWindow)
    manager.detachAll()
  })

  it("kills its own session without taking the sibling's window and process", async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const { founder, second, founderWindow } = await fallenBack(manager)
    // Reattached first, which is the path the finding names: Task 5 caches
    // `entry.windowId` from the same lookup, so a kill that trusts the cache
    // and one that re-asks tmux both arrive at the sibling's window.
    manager.open({
      id: second.id, projectSlug: 'lumio', cwd: tmpdir(),
      tmuxSession: second.tmuxSession, cols: 60, rows: 20,
    })
    await expect.poll(() => clients(second.tmuxSession), { timeout: 8000 }).toHaveLength(1)
    // Read before the kill: afterwards there may be no pane left to ask.
    const pid = await panePid(founder.tmuxSession)
    expect(pid).toMatch(/^\d+$/)

    await manager.kill(second.id)

    expect(await sessionExists(second.tmuxSession)).toBe(false)
    expect(await sessionExists(founder.tmuxSession)).toBe(true)
    expect(await windowIdOf(founder.tmuxSession)).toBe(founderWindow)
    // The harm this prevents, stated as the process rather than the window:
    // the user closes one pane and the OTHER pane's shell is killed.
    expect(isRunning(pid)).toBe(true)
    manager.detachAll()
  })

  // Pre-existing rather than new — the reinstall call is byte-identical to the
  // one at `81cd203` — but Task 7 established in the same branch that this
  // state is real and detectable, so it is fixed with the rest of it.
  it("does not rewrite the sibling's death hook when the tab is moved", async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }), {
      deathReporter: join(tmpdir(), 'prcli-hook-test-reporter'),
    })
    const { founder, second, founderWindow } = await fallenBack(manager)
    // `open()`'s hook installs asynchronously. Moving before it lands would
    // leave nothing for the move to clobber.
    await expect.poll(() => hooksOf(founderWindow), { timeout: 10_000 }).toContain('pane-died')

    const moved = await manager.moveTabToProject(founder.id, 'gco')
    expect(moved.length).toBeGreaterThan(0)

    // The founder's window still reports the founder's death, and still reaps
    // the founder's own session. A hook naming the other pane sends the red
    // dot to the wrong tab and reaps the wrong session, leaving the founder's
    // own behind as a stray.
    const hooks = await hooksOf(founderWindow)
    expect(hooks).toContain(`PRCLI_TAB_ID=${founder.id}`)
    expect(hooks).toContain(`=prcli-gco-${founder.id}`)
    expect(hooks).not.toContain(second.id)
    manager.detachAll()
  })

  // The denial has to be cached as well as a grant. `windowId` is only ever
  // filled in with a window this pane may write to, so a denied pane had
  // nothing to remember and re-ran the whole check — `list-sessions` plus one
  // `windowIdOf` per sibling — on every `resize()`, which during a drag means
  // every frame. Same subprocess-storm shape the branch's memoised window
  // lookup exists to remove.
  it('asks who owns a window once per pane, not once per resize', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    const owners = vi.spyOn(adapter, 'listSessionsWithGroups')
    const manager = new SessionManager(adapter)
    const { second } = await fallenBack(manager)

    manager.open({
      id: second.id, projectSlug: 'lumio', cwd: tmpdir(),
      tmuxSession: second.tmuxSession, cols: 60, rows: 20,
    })
    await expect.poll(() => clients(second.tmuxSession), { timeout: 8000 }).toHaveLength(1)
    // The attach's own check is asynchronous; wait for it to land, then take
    // the baseline. `toBeGreaterThan(0)` is what stops everything below from
    // passing on a check that never ran at all.
    await expect.poll(() => owners.mock.calls.length, { timeout: 8000 }).toBeGreaterThan(0)
    const afterAttach = owners.mock.calls.length

    // A drag, at one frame per size.
    for (let width = 61; width <= 65; width += 1) manager.resize(second.id, width, 20)
    await new Promise((resolve) => setTimeout(resolve, 500))

    // Five frames, and tmux was asked nothing more. Without the cached denial
    // this is `afterAttach + 5`.
    expect(owners.mock.calls.length).toBe(afterAttach)
    manager.detachAll()
  })

  /**
   * The mirror image, which the founder-first tie-break gets wrong on its own:
   * the FOUNDER's window dies and the founder falls back onto the second
   * pane's. `ownsWindow(second, @second)` then finds the founder among the
   * claimants, the founder wins by being the tab's own id, and the pane that
   * genuinely owns the window is vetoed off it.
   *
   * Which member truly owns a shared window is not recoverable from tmux, so
   * the tie-break itself cannot be fixed and is not being fixed here. What is
   * fixed is that `kill()` was putting the question to tmux at all for a
   * window it already had a cached, self-made id for. `splitTab` made this
   * window for this pane and handed the id to `attach`; tmux's report is not a
   * better source than that, and here it is a worse one.
   */
  it("kills its own window when the FOUNDER is the pane that has fallen back", async () => {
    const manager = new SessionManager(new TmuxAdapter({ socket: SOCKET }))
    const founder = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 120, rows: 40 })
    await waitFor(manager, founder.id, /\$|%|#/)
    const second = await manager.splitTab({ paneId: founder.id, cols: 100, rows: 30 })
    const founderWindow = await windowIdOf(founder.tmuxSession)
    const secondWindow = await windowIdOf(second.tmuxSession)
    expect(founderWindow).toMatch(/^@\d+$/)
    expect(secondWindow).not.toBe(founderWindow)

    // The founder is the one that loses its window this time.
    manager.detach(founder.id)
    await run('tmux', ['-L', SOCKET, 'kill-window', '-t', founderWindow])
    // Asserted rather than assumed: without the fallback this is an ordinary
    // one-pane kill and would pass on anything.
    await expect.poll(() => windowIdOf(founder.tmuxSession), { timeout: 8000 }).toBe(secondWindow)
    expect(await sessionExists(founder.tmuxSession)).toBe(true)

    // Read before the kill: this is the process the leak leaves running.
    const pid = await panePid(second.tmuxSession)
    expect(pid).toMatch(/^\d+$/)
    // And the window is there to be reaped, so the `not.toContain` below is
    // asserting a removal rather than a list that never held it.
    expect(await allWindows()).toContain(secondWindow)

    await manager.kill(second.id)

    expect(await sessionExists(second.tmuxSession)).toBe(false)
    // The window and the shell inside it, not just the session. Killing only
    // the session leaves `@n` linked into the surviving group with a live
    // `zsh` in it, reachable afterwards only through `list-windows` — the
    // spec's "a crashed or closed pane leaves no window and no member session
    // behind", failed. Polled because the kernel reaps the shell a moment
    // after tmux takes the window.
    await expect.poll(() => isRunning(pid), { timeout: 8000 }).toBe(false)
    const left = await allWindows()
    expect(left).not.toContain(secondWindow)
    manager.detachAll()
  })
})

/**
 * `ownsWindow` reads `list-sessions`, which returns `[]` only for "no server"
 * and rethrows everything else — a failed `spawn` under load, most
 * realistically. It is consulted on paths that had no throwing tmux call in
 * them before this branch, and a throw escaping it is not an unanswered
 * question but a broken caller. Both tests below make that call reject and
 * assert the caller finished its job anyway.
 */
describe('SessionManager when tmux will not say who owns a window', () => {
  /** `list-sessions` refusing to answer, on a manager that is otherwise real. */
  function withBrokenOwnership(options: { deathReporter?: string } = {}): SessionManager {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    vi.spyOn(adapter, 'listSessionsWithGroups').mockRejectedValue(
      new Error('tmux said something odd'),
    )
    return new SessionManager(adapter, options)
  }

  it('still pairs the death hook with remain-on-exit on an ordinary attach', async () => {
    const manager = withBrokenOwnership({
      deathReporter: join(tmpdir(), 'prcli-hook-test-reporter'),
    })
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 100, rows: 30 })
    await waitFor(manager, tab.id, /\$|%|#/)
    const window = await windowIdOf(tab.tmuxSession)
    expect(window).toMatch(/^@\d+$/)

    // The option goes on chained into `new-session`, so it is on before
    // `ownsWindow` is ever reached. If the throw escapes, it escapes PAST
    // `disableRemainOnExit` too and this window is left preserving its pane on
    // exit with nothing to reap it — option on, no hook, the stray-session
    // class this project has shipped once.
    await expect.poll(() => hooksOf(window), { timeout: 10_000 }).toContain('pane-died')
    expect(await windowOption(window, 'remain-on-exit')).toBe('on')
    manager.detachAll()
  })

  it('still kills the session and its window', async () => {
    const manager = withBrokenOwnership()
    const tab = manager.open({ projectSlug: 'lumio', cwd: tmpdir(), cols: 100, rows: 30 })
    await waitFor(manager, tab.id, /\$|%|#/)
    const window = await windowIdOf(tab.tmuxSession)
    expect(await allWindows()).toContain(window)

    // The check runs BEFORE `killSession`, so a throw here leaves the session
    // alive, the entry still registered, and `CHANNELS.closePane`'s handler
    // rejecting before it can forget the tab.
    await manager.kill(tab.id)

    expect(await sessionExists(tab.tmuxSession)).toBe(false)
    expect(await allWindows()).not.toContain(window)
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
