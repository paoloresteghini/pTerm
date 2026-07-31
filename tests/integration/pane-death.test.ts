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

/** The window ids a tab's group holds, seen through one of its members. */
async function windowsIn(name: string): Promise<string[]> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'list-windows', '-t', `=${name}:`, '-F', '#{window_id}',
  ])
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

async function windowIdOf(name: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_id}',
  ])
  return stdout.trim()
}

async function paneIsDead(windowId: string): Promise<boolean> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', windowId, '#{pane_dead}',
  ])
  return stdout.trim() === '1'
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

  // The case a status alone cannot describe: tmux reports an empty
  // `#{pane_dead_status}` and the signal's name instead. A segfault and an OOM
  // kill both land here, and reading the missing status as 0 would show them
  // grey.
  it('reports the signal name when the pane was killed rather than exited', async () => {
    const { manager: sessions, received } = await harness()

    const record = sessions.open({
      projectSlug: 'alpha',
      cwd: dir,
      command: 'sh -c "sleep 30"',
      type: 'preset',
    })

    // `open()` returns before the tmux client it spawned has created anything.
    await expect
      .poll(() => sessionExists(record.tmuxSession), { timeout: 10_000 })
      .toBe(true)

    // The pane's own process, killed the way the OOM killer would.
    const { stdout } = await run('tmux', [
      '-L', SOCKET, 'display-message', '-p', '-t', `=${record.tmuxSession}:`, '#{pane_pid}',
    ])
    await run('kill', ['-9', stdout.trim()])

    await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThan(0)
    expect(received[0]).toMatchObject({ tabId: record.id, event: 'Exit', signal: 'kill' })
    expect(received[0]).not.toHaveProperty('status')
  })

  // A carry-forward since M2a: "a session that dies while DETACHED is never
  // observed at all (no client, so no exit event); its state is corrected only
  // at the next restore reconcile." The exit path that statement is about is
  // the *client's*, and a detached tab has none. tmux's hooks are the server's
  // and do not care, so this asks directly whether the gap is still there.
  it('reports a death that happens while no client is attached', async () => {
    const { manager: sessions, received } = await harness()

    const record = sessions.open({
      projectSlug: 'alpha',
      cwd: dir,
      command: 'sh -c "sleep 30"',
      type: 'preset',
    })
    await expect.poll(() => sessionExists(record.tmuxSession), { timeout: 10_000 }).toBe(true)

    // Detach every client, then kill what is running inside. Nothing is
    // watching from this process at all.
    sessions.detachAll()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const { stdout } = await run('tmux', [
      '-L', SOCKET, 'display-message', '-p', '-t', `=${record.tmuxSession}:`, '#{pane_pid}',
    ])
    await run('kill', ['-9', stdout.trim()])

    await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThan(0)
    expect(received[0]).toMatchObject({ tabId: record.id, event: 'Exit', signal: 'kill' })
  })

  // Where the gap that remains actually is. `pane-died` fires when a pane's
  // command dies; destroying the session outright kills the pane without one,
  // so an outsider's `tmux kill-session` on a detached tab still goes
  // unnoticed until restore reconciles. Recorded as a bounded wait rather than
  // left as a belief.
  it('does not notice an outsider destroying a detached session', async () => {
    const { manager: sessions, received } = await harness()

    const record = sessions.open({
      projectSlug: 'alpha',
      cwd: dir,
      command: 'sh -c "sleep 30"',
      type: 'preset',
    })
    await expect.poll(() => sessionExists(record.tmuxSession), { timeout: 10_000 }).toBe(true)
    sessions.detachAll()
    await new Promise((resolve) => setTimeout(resolve, 300))

    await run('tmux', ['-L', SOCKET, 'kill-session', '-t', `=${record.tmuxSession}`])
    await new Promise((resolve) => setTimeout(resolve, 1_500))

    expect(received).toEqual([])
  })

  // The M2c blocker: a pane of a split tab crashes, and the tab keeps working.
  //
  // The window assertion is the one that carries this test. Measured against
  // the pre-M2c hook, which ended in `kill-session`: it does report the status
  // and it does reap the dead pane's own member session, so those two pass
  // either way. What it cannot do is remove the dead pane's WINDOW, because a
  // session group's windows are shared and killing one member unlinks nothing
  // from the others. The dead pane is then left in the surviving sibling's
  // window list, permanently — the stray this project has already had once,
  // reached through a split instead of a crash.
  it('takes down only the pane that died, not its siblings', async () => {
    const { manager: sessions, received } = await harness()

    const survivor = sessions.open({
      projectSlug: 'alpha',
      cwd: dir,
      command: 'sh -c "sleep 30"',
      type: 'preset',
    })
    await expect.poll(() => sessionExists(survivor.tmuxSession), { timeout: 10_000 }).toBe(true)
    const survivorWindow = await windowIdOf(survivor.tmuxSession)

    const doomed = await sessions.splitTab({ paneId: survivor.id, command: 'sh -c "exit 3"' })
    // Two panes, two windows, one shared list: the tab this is all about.
    expect(await windowsIn(survivor.tmuxSession)).toHaveLength(2)

    // The dead pane reported its own status under its own id...
    await expect.poll(() => received.length, { timeout: 10_000 }).toBeGreaterThan(0)
    expect(received[0]).toMatchObject({ tabId: doomed.id, event: 'Exit', status: 3 })

    // ...its member session was reaped...
    await expect.poll(() => sessionExists(doomed.tmuxSession), { timeout: 10_000 }).toBe(false)

    // ...and so was its window, leaving the tab holding only the survivor's.
    await expect
      .poll(() => windowsIn(survivor.tmuxSession), { timeout: 10_000 })
      .toEqual([survivorWindow])

    // ...and the sibling is untouched, with a live pane.
    expect(await sessionExists(survivor.tmuxSession)).toBe(true)
    expect(await paneIsDead(survivorWindow)).toBe(false)
    sessions.detachAll()
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
