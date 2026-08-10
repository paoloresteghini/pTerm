import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { TmuxAdapter } from '../../src/main/tmux/adapter'
import { SessionManager } from '../../src/main/sessions/manager'
import { encodeSessionName } from '../../src/main/tmux/names'

const run = promisify(execFile)
const SOCKET = 'pterm-test'
const cwd = tmpdir()

let idCounter = 0

/**
 * A pane id unique to this call, never reused across the file.
 *
 * `encodeSessionName` requires a 16-character hex id (see `names.ts`'s
 * `ID_RE`), which `padStart` satisfies for any counter value this file will
 * reach. Every test used to open panes under the same literal `aaa`/`bbb`/
 * `ccc`, sharing one `manager` and one `adapter` across the whole file the
 * way its neighbours do; a controller-measured flake (`join.test.ts`, "no
 * pane <id>" from `splitTab`, a manager entry missing moments after
 * `manager.open` created it) traced to a previous test's pty still
 * finishing its async exit against the OLD entry for that same id after the
 * next test had already opened a NEW one under it. Distinct ids per test
 * remove the possibility of that collision outright, rather than trying to
 * close the race.
 */
function freshId(): string {
  idCounter += 1
  return idCounter.toString(16).padStart(16, '0')
}

async function killServer(): Promise<void> {
  try {
    await run('tmux', ['-L', SOCKET, 'kill-server'])
  } catch {
    // No server running.
  }
}

/** A short wait for tmux to catch up with an async `manager.open`. */
const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The pid of the process running in whatever window this session is showing. */
async function panePid(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{pane_pid}',
  ])
  return stdout.trim()
}

/** The window id each named session is currently showing. */
async function shownWindows(names: string[]): Promise<string[]> {
  return Promise.all(
    names.map(async (name) => {
      const { stdout } = await run('tmux', [
        '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_id}',
      ])
      return stdout.trim()
    }),
  )
}

const adapter = new TmuxAdapter({ socket: SOCKET })
const manager = new SessionManager(adapter)

beforeAll(async () => {
  await killServer()
  // The shared test socket's server exits the moment its last session dies.
  // `joinTab` kills and recreates sessions constantly, so without a session
  // that outlives every test the server itself could disappear mid-file and
  // every test after that would be running against a socket nothing is
  // listening on. `holder` is not a `pterm-*` name, so `listPTermSessions`
  // never touches it and the per-test cleanup below never kills it either.
  await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'holder'])
})

afterAll(killServer)

afterEach(async () => {
  vi.restoreAllMocks()
  manager.detachAll()
  // Not `killServer()`: that would take `holder` down with everything else
  // and the next test would start against a dead socket. Every session
  // `joinTab` and `manager.open` can make is `pterm-*`, which is exactly
  // what `listPTermSessions` reports, so this clears out anything this
  // test left running without touching `holder`.
  for (const name of await adapter.listPTermSessions()) {
    await adapter.killSession(name).catch(() => undefined)
  }
})

describe('SessionManager.joinTab', () => {
  it('keeps the moved pane process alive when two standalone tabs merge', async () => {
    const aaa = freshId()
    const bbb = freshId()
    const target = manager.open({ id: aaa, projectSlug: 'demo', cwd })
    const moved = manager.open({ id: bbb, projectSlug: 'demo', cwd })
    await settle()
    const before = await panePid(moved.tmuxSession)

    const joined = await manager.joinTab({ paneId: bbb, targetPaneId: aaa })

    expect(await panePid(joined.record.tmuxSession)).toBe(before)
    expect(joined.tabId).toBe(aaa)
    expect(await panePid(target.tmuxSession)).not.toBe(before)
  })

  it('puts both panes in one tmux group', async () => {
    const aaa = freshId()
    const bbb = freshId()
    manager.open({ id: aaa, projectSlug: 'demo', cwd })
    manager.open({ id: bbb, projectSlug: 'demo', cwd })
    await settle()

    await manager.joinTab({ paneId: bbb, targetPaneId: aaa })

    const rows = await adapter.listSessionsWithGroups()
    const groups = [aaa, bbb].map(
      (id) => rows.find((row) => row.name === encodeSessionName({ projectSlug: 'demo', id }))?.group,
    )
    expect(groups[0]).toBeTruthy()
    expect(groups[1]).toBe(groups[0])
  })

  it('leaves every member of the target group on a window of its own', async () => {
    const aaa = freshId()
    const ccc = freshId()
    manager.open({ id: aaa, projectSlug: 'demo', cwd })
    await settle()
    await manager.splitTab({ paneId: aaa, cols: 80, rows: 24 })
    manager.open({ id: ccc, projectSlug: 'demo', cwd })
    await settle()

    await manager.joinTab({ paneId: ccc, targetPaneId: aaa })

    const names = (await adapter.listSessionsWithGroups())
      .filter((row) => row.group && row.name.includes('demo'))
      .map((row) => row.name)
    const shown = await shownWindows(names)
    expect(new Set(shown).size).toBe(shown.length)
  })

  it('keeps both processes alive when a pane moves between two splits', async () => {
    const aaa = freshId()
    const ccc = freshId()
    manager.open({ id: aaa, projectSlug: 'demo', cwd })
    manager.open({ id: ccc, projectSlug: 'demo', cwd })
    await settle()
    const second = await manager.splitTab({ paneId: aaa, cols: 80, rows: 24 })
    await manager.splitTab({ paneId: ccc, cols: 80, rows: 24 })
    const before = await panePid(second.tmuxSession)

    const joined = await manager.joinTab({ paneId: second.id, targetPaneId: ccc })

    expect(await panePid(joined.record.tmuxSession)).toBe(before)
    expect(joined.tabId).toBe(ccc)
  })

  it('leaves the survivor of a founder move alive and on its own window', async () => {
    const aaa = freshId()
    const ccc = freshId()
    manager.open({ id: aaa, projectSlug: 'demo', cwd })
    manager.open({ id: ccc, projectSlug: 'demo', cwd })
    await settle()
    const survivor = await manager.splitTab({ paneId: aaa, cols: 80, rows: 24 })
    const survivorPid = await panePid(survivor.tmuxSession)

    await manager.joinTab({ paneId: aaa, targetPaneId: ccc })

    expect(await panePid(survivor.tmuxSession)).toBe(survivorPid)
  })

  it('refuses to join a pane to its own tab', async () => {
    const aaa = freshId()
    manager.open({ id: aaa, projectSlug: 'demo', cwd })
    await settle()
    const sibling = await manager.splitTab({ paneId: aaa, cols: 80, rows: 24 })

    await expect(manager.joinTab({ paneId: sibling.id, targetPaneId: aaa })).rejects.toThrow(
      /already/i,
    )
  })

  it('leaves the source pane untouched when the join cannot start', async () => {
    const aaa = freshId()
    const bbb = freshId()
    manager.open({ id: aaa, projectSlug: 'demo', cwd })
    const moved = manager.open({ id: bbb, projectSlug: 'demo', cwd })
    await settle()
    const before = await panePid(moved.tmuxSession)
    vi.spyOn(adapter, 'newGroupMember').mockRejectedValueOnce(new Error('nope'))

    await expect(manager.joinTab({ paneId: bbb, targetPaneId: aaa })).rejects.toThrow('nope')

    expect(await adapter.hasSession(moved.tmuxSession)).toBe(true)
    expect(await panePid(moved.tmuxSession)).toBe(before)
    const rows = await adapter.listSessionsWithGroups()
    expect(rows.find((row) => row.name === moved.tmuxSession)?.group).toBeFalsy()
  })

  it('cleans up the staging session when the move fails', async () => {
    const aaa = freshId()
    const bbb = freshId()
    manager.open({ id: aaa, projectSlug: 'demo', cwd })
    const moved = manager.open({ id: bbb, projectSlug: 'demo', cwd })
    await settle()
    vi.spyOn(adapter, 'moveWindow').mockRejectedValueOnce(new Error('nope'))

    await expect(manager.joinTab({ paneId: bbb, targetPaneId: aaa })).rejects.toThrow('nope')

    const names = (await adapter.listSessionsWithGroups()).map((row) => row.name)
    expect(names.filter((name) => name.includes('-joining'))).toEqual([])
    expect(await adapter.hasSession(moved.tmuxSession)).toBe(true)
  })
})
