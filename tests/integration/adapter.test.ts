import { describe, it, expect, afterEach, afterAll, beforeAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TmuxAdapter, TmuxNotInstalledError } from '../../src/main/tmux/adapter'

const run = promisify(execFile)
const SOCKET = 'pterm-test'
const adapter = new TmuxAdapter({ socket: SOCKET })

let fakeBinDir: string | undefined

/**
 * A stand-in for the tmux binary that always fails with the given stderr.
 * Real tmux cannot be made to produce an unreachable-socket or wedged-server
 * failure on demand, and those are exactly the cases that must not be read as
 * "the session is absent".
 */
async function fakeTmuxFailingWith(stderr: string): Promise<TmuxAdapter> {
  fakeBinDir ??= await mkdtemp(join(tmpdir(), 'pterm-fake-tmux-'))
  const bin = join(fakeBinDir, `tmux-${Math.random().toString(16).slice(2)}`)
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(stderr)} >&2\nexit 1\n`, 'utf8')
  await chmod(bin, 0o755)
  // The socket is redundant — this stub ignores its arguments entirely — but a
  // socket-less adapter is the one mistake in this project that can reach the
  // user's real tmux server, so no adapter anywhere gets to be the exception.
  return new TmuxAdapter({ bin, socket: SOCKET })
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

/** The window ids a session's window list holds. */
async function windowsOf(name: string): Promise<string[]> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'list-windows', '-t', `=${name}:`, '-F', '#{window_id}',
  ])
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
}

/** What tmux says a window measures, by window id. */
async function windowSizeOf(windowId: string): Promise<string> {
  const { stdout } = await run('tmux', [
    '-L', SOCKET, 'display-message', '-p', '-t', windowId, '#{window_width}x#{window_height}',
  ])
  return stdout.trim()
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
    const pristine = new TmuxAdapter({ socket: 'pterm-test-never-created' })
    await expect(pristine.listSessions()).resolves.toEqual([])
  })

  it('returns an empty array after the server has been killed', async () => {
    await createSession('pterm-lumio-a1b2c3d4e5f60718')
    await killServer()
    await expect(adapter.listSessions()).resolves.toEqual([])
  })

  it('lists session names', async () => {
    await createSession('pterm-lumio-a1b2c3d4e5f60718')
    await createSession('someone-elses-session')
    const names = await adapter.listSessions()
    expect(names.sort()).toEqual(['pterm-lumio-a1b2c3d4e5f60718', 'someone-elses-session'])
  })
})

describe('TmuxAdapter.listPTermSessions', () => {
  it('excludes sessions that are not ours', async () => {
    await createSession('pterm-lumio-a1b2c3d4e5f60718')
    await createSession('someone-elses-session')
    await expect(adapter.listPTermSessions()).resolves.toEqual([
      'pterm-lumio-a1b2c3d4e5f60718',
    ])
  })
})

describe('TmuxAdapter.hasSession', () => {
  it('is true for an existing session and false otherwise', async () => {
    await createSession('pterm-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('pterm-lumio-a1b2c3d4e5f60718')).resolves.toBe(true)
    await expect(adapter.hasSession('pterm-lumio-000000000000000f')).resolves.toBe(false)
  })

  it('does not match on prefix', async () => {
    await createSession('pterm-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('pterm-lumio')).resolves.toBe(false)
  })

  it('is false when there is no server at all', async () => {
    const pristine = new TmuxAdapter({ socket: 'pterm-test-never-created' })
    await expect(pristine.hasSession('pterm-lumio-a1b2c3d4e5f60718')).resolves.toBe(false)
  })

  it('rethrows failures that do not mean the session is absent', async () => {
    const wedged = await fakeTmuxFailingWith('error connecting to /tmp/x (Permission denied)')
    await expect(wedged.hasSession('pterm-lumio-a1b2c3d4e5f60718')).rejects.toThrow(
      /permission denied/i,
    )
  })
})

describe('TmuxAdapter.killSession', () => {
  it('removes the session', async () => {
    await createSession('pterm-lumio-a1b2c3d4e5f60718')
    await adapter.killSession('pterm-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('pterm-lumio-a1b2c3d4e5f60718')).resolves.toBe(false)
  })

  it('is a no-op for a session that does not exist', async () => {
    await createSession('pterm-lumio-a1b2c3d4e5f60718')
    await expect(adapter.killSession('pterm-lumio-000000000000000f')).resolves.toBeUndefined()
    // The kill must not have resolved by taking anything else with it.
    await expect(adapter.hasSession('pterm-lumio-000000000000000f')).resolves.toBe(false)
    await expect(adapter.hasSession('pterm-lumio-a1b2c3d4e5f60718')).resolves.toBe(true)
  })

  it('rejects when the kill fails and the outcome cannot be verified', async () => {
    const wedged = await fakeTmuxFailingWith('error connecting to /tmp/x (Permission denied)')
    await expect(wedged.killSession('pterm-lumio-a1b2c3d4e5f60718')).rejects.toThrow(
      /permission denied/i,
    )
  })
})

describe('TmuxAdapter session options', () => {
  it('sets and reads back a session option', async () => {
    await createSession('pterm-lumio-a1b2c3d4e5f60718')
    await adapter.setSessionOption('pterm-lumio-a1b2c3d4e5f60718', 'status', 'off')
    await expect(adapter.getSessionOption('pterm-lumio-a1b2c3d4e5f60718', 'status'))
      .resolves.toBe('off')
  })

  it('targets exactly one session', async () => {
    await createSession('pterm-lumio-a1b2c3d4e5f60718')
    await createSession('pterm-lumio-00000000000000ff')
    await adapter.setSessionOption('pterm-lumio-a1b2c3d4e5f60718', 'status', 'off')
    await expect(adapter.getSessionOption('pterm-lumio-00000000000000ff', 'status'))
      .resolves.not.toBe('off')
  })

  // The test above cannot fail if the `=` is dropped: tmux resolves an exact
  // name before it tries anything else, so with both sessions present a bare
  // `-t` finds the right one anyway. The `=` only earns its place when the
  // name is *absent* — then a bare `-t` falls through to prefix matching and
  // silently acts on a different session. Every id being the same length makes
  // this look impossible, but the adapter is a general wrapper and the ids are
  // hex: a truncated or mistyped name is a prefix of a real one.
  it('refuses a name that is only a prefix, rather than hitting the longer session', async () => {
    await createSession('pterm-lumio-a1b2c3d4e5f60718')

    await expect(adapter.setSessionOption('pterm-lumio-a1b2c3d4e5f6071', 'status', 'off'))
      .rejects.toThrow()

    // The real session is untouched, not merely still alive.
    await expect(adapter.getSessionOption('pterm-lumio-a1b2c3d4e5f60718', 'status'))
      .resolves.not.toBe('off')
  })
})

describe('TmuxAdapter.renameSession', () => {
  it('renames a session, keeping it alive', async () => {
    await createSession('pterm-scratch-a1b2c3d4e5f60718')
    await adapter.renameSession('pterm-scratch-a1b2c3d4e5f60718', 'pterm-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('pterm-lumio-a1b2c3d4e5f60718')).resolves.toBe(true)
    await expect(adapter.hasSession('pterm-scratch-a1b2c3d4e5f60718')).resolves.toBe(false)
  })

  it('throws when the source does not exist', async () => {
    await expect(
      adapter.renameSession('pterm-scratch-a1b2c3d4e5f60718', 'pterm-lumio-a1b2c3d4e5f60718'),
    ).rejects.toThrow()
  })

  it('throws rather than colliding with an existing name', async () => {
    await createSession('pterm-scratch-a1b2c3d4e5f60718')
    await createSession('pterm-lumio-00000000000000ff')
    await expect(
      adapter.renameSession('pterm-scratch-a1b2c3d4e5f60718', 'pterm-lumio-00000000000000ff'),
    ).rejects.toThrow()
    // The source must survive a refused rename.
    await expect(adapter.hasSession('pterm-scratch-a1b2c3d4e5f60718')).resolves.toBe(true)
  })

  it('targets exactly one session', async () => {
    await createSession('pterm-scratch-a1b2c3d4e5f60718')
    await createSession('pterm-scratch-00000000000000ff')
    await adapter.renameSession('pterm-scratch-a1b2c3d4e5f60718', 'pterm-lumio-a1b2c3d4e5f60718')
    await expect(adapter.hasSession('pterm-scratch-00000000000000ff')).resolves.toBe(true)
  })

  // Same weakness, same fix: with both names present a bare `-t` resolves the
  // exact one anyway, so only an *absent* name proves the `=` is doing
  // anything. A rename is the worse of the two to get wrong — it would move a
  // live session into another project silently.
  it('refuses to rename from a name that is only a prefix of a real session', async () => {
    await createSession('pterm-scratch-a1b2c3d4e5f60718')

    await expect(
      adapter.renameSession('pterm-scratch-a1b2c3d4e5f6071', 'pterm-lumio-a1b2c3d4e5f60718'),
    ).rejects.toThrow()

    await expect(adapter.hasSession('pterm-scratch-a1b2c3d4e5f60718')).resolves.toBe(true)
    await expect(adapter.hasSession('pterm-lumio-a1b2c3d4e5f60718')).resolves.toBe(false)
  })
})

describe('TmuxAdapter.killSession, exact targeting', () => {
  // The same prefix hazard on the one operation that destroys work: without
  // `=`, killing an id that is gone would kill whichever live session its name
  // happens to prefix. `killSession` treats "already gone" as success, so the
  // proof is that the *other* session is still there afterwards.
  it('does not kill a longer session when asked for a prefix that no longer exists', async () => {
    await createSession('pterm-lumio-a1b2c3d4e5f60718')

    await expect(adapter.killSession('pterm-lumio-a1b2c3d4e5f6071')).resolves.toBeUndefined()

    await expect(adapter.hasSession('pterm-lumio-a1b2c3d4e5f60718')).resolves.toBe(true)
  })
})

describe('TmuxAdapter.lookupWindow', () => {
  it('reports a session tmux has never heard of as gone, not as unreachable', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'real', 'sleep', '600'])
    expect(await adapter.lookupWindow('nosuchsession')).toEqual({ kind: 'gone' })
  })

  it('reports a window it can name as found', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'real', 'sleep', '600'])
    expect(await adapter.lookupWindow('real')).toMatchObject({ kind: 'found' })
  })

  // The distinction the whole task exists for. A tmux that cannot be run at all
  // is not a session that has gone, and must not be reported as one.
  it('reports a tmux it cannot run as unreachable, not as gone', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET, bin: '/nonexistent/tmux' })
    await expect(adapter.lookupWindow('anything')).rejects.toThrow(TmuxNotInstalledError)
  })

  // The case above only proves an absent binary is a hard error, never a
  // `WindowLookup` at all — `exec` throws before `lookupWindow`'s own mapping
  // ever runs. This is the test that actually exercises that mapping's
  // `unreachable` branch: a tmux that runs and fails for a reason that is
  // neither "no such session" nor "no server". Real tmux on this machine has
  // no on-demand way to produce that failure shape, so this reuses the
  // `fakeTmuxFailingWith` stub already established above for the same reason.
  it('reports a tmux that fails without saying the session is absent as unreachable', async () => {
    const wedged = await fakeTmuxFailingWith('error connecting to /tmp/x (Permission denied)')
    await expect(wedged.lookupWindow('anything')).resolves.toEqual({ kind: 'unreachable' })
  })
})

describe('TmuxAdapter groups and windows', () => {
  it('reports an empty group for an ungrouped session and the group name for members', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'solo', 'sleep', '600'])
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'founder', 'sleep', '600'])
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-t', 'founder', '-s', 'member'])

    const rows = await adapter.listSessionsWithGroups()

    expect(rows).toEqual(
      expect.arrayContaining([
        { name: 'solo', group: '' },
        { name: 'founder', group: 'founder' },
        { name: 'member', group: 'founder' },
      ]),
    )
  })

  it('resizes one window without touching its sibling', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'f', '-x', '80', '-y', '24', 'sleep', '600'])
    const first = await adapter.windowIdOf('f')
    await run('tmux', ['-L', SOCKET, 'new-window', '-t', '=f:', 'sleep', '600'])
    const second = await adapter.windowIdOf('f')
    expect(second).not.toBe(first)

    await adapter.setSessionOption('f', 'window-size', 'manual')
    await adapter.resizeWindow(first, 100, 30)
    await adapter.resizeWindow(second, 200, 50)

    expect(await windowSizeOf(first)).toBe('100x30')
    expect(await windowSizeOf(second)).toBe('200x50')
  })

  // A window id (`@7`) is the one target form in this file that takes neither
  // `=` nor a trailing colon, so it is the one most likely to be written in
  // some other method's shape. Every wrong form here — `=@7`, `@7:`, a dropped
  // `-t` — is the signature failure of this project: tmux exits 0 and kills
  // nothing. So the window itself has to be observed. Neither the surviving
  // session nor the second call resolving `undefined` can see that: stub the
  // body of `killWindow` to `return` and both still hold.
  it('kills a window without killing the session that also holds another', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'f', 'sleep', '600'])
    await run('tmux', ['-L', SOCKET, 'new-window', '-t', '=f:', 'sleep', '600'])
    const doomed = await adapter.windowIdOf('f')
    const survivor = (await windowsOf('f')).filter((id) => id !== doomed)
    expect(survivor).toHaveLength(1)

    await adapter.killWindow(doomed)

    // The window is gone, and only that window.
    expect(await windowsOf('f')).toEqual(survivor)
    expect(await adapter.hasSession('f')).toBe(true)
    // Killing one that has already gone is success — the death hook may have
    // reaped it a moment earlier.
    await expect(adapter.killWindow(doomed)).resolves.toBeUndefined()
    expect(await windowsOf('f')).toEqual(survivor)
  })

  // Group members can each be looking at a different window in the shared
  // list from the moment they're created (measured: a freshly joined member
  // does not inherit its founder's current window). selectWindow is what
  // makes that deliberate rather than accidental, so both halves of the
  // assertion matter: the named member moves, and the other member — bound
  // separately just before — is not dragged along with it.
  it('binds the member it names to the window by index, leaving its groupmate alone', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'f', 'sleep', '600'])
    const firstIndex = (
      await run('tmux', ['-L', SOCKET, 'display-message', '-p', '-t', '=f:', '#{window_index}'])
    ).stdout.trim()
    const secondIndex = (
      await run('tmux', [
        '-L', SOCKET, 'new-window', '-t', '=f:', '-P', '-F', '#{window_index}', 'sleep', '600',
      ])
    ).stdout.trim()
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-t', 'f', '-s', 'm'])

    await adapter.selectWindow('f', firstIndex)
    await adapter.selectWindow('m', secondIndex)

    const windowIndexOf = async (name: string) =>
      (
        await run('tmux', [
          '-L', SOCKET, 'display-message', '-p', '-t', `=${name}:`, '#{window_index}',
        ])
      ).stdout.trim()

    expect(await windowIndexOf('m')).toBe(secondIndex)
    expect(await windowIndexOf('f')).toBe(firstIndex)
  })

  it('sets the option on that window only, leaving its sibling unset', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'f', 'sleep', '600'])
    const first = await adapter.windowIdOf('f')
    await run('tmux', ['-L', SOCKET, 'new-window', '-t', '=f:', 'sleep', '600'])
    const second = await adapter.windowIdOf('f')

    await adapter.setWindowOption(second, 'remain-on-exit', 'on')

    const remainOnExitOf = async (windowId: string) =>
      (
        await run('tmux', [
          '-L', SOCKET, 'show-options', '-w', '-t', windowId, '-v', 'remain-on-exit',
        ])
      ).stdout.trim()

    expect(await remainOnExitOf(second)).toBe('on')
    expect(await remainOnExitOf(first)).not.toBe('on')
  })

  it('installs the hook on that window only, leaving its sibling clean', async () => {
    const adapter = new TmuxAdapter({ socket: SOCKET })
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'f', 'sleep', '600'])
    const first = await adapter.windowIdOf('f')
    await run('tmux', ['-L', SOCKET, 'new-window', '-t', '=f:', 'sleep', '600'])
    const second = await adapter.windowIdOf('f')

    await adapter.setWindowHook(second, 'pane-died', "run-shell 'true'")

    const hooksOf = async (windowId: string) =>
      (await run('tmux', ['-L', SOCKET, 'show-hooks', '-w', '-t', windowId])).stdout

    expect(await hooksOf(second)).toContain('pane-died')
    expect(await hooksOf(first)).not.toContain('pane-died')
  })
})

/**
 * The one tmux answer that is worse than an error: silent success at the wrong
 * thing.
 *
 * **Measured 2026-08-08.** `tmux new-session -d -t <a group that does not
 * exist> -s <name>` exits **0**. It does not join a group, because there is
 * none to join — it founds a brand new group of ONE, named after the target
 * that was missing, holding a new session and a new window whose pane runs the
 * user's login shell. Every obvious check therefore agrees with the disaster:
 * the session exists, `#{session_group}` is the name that was asked for, and
 * `#{session_grouped}` is 1. `#{session_group_size}` is the only field that
 * tells a founding from a joining. And because this call passes no `-c` (a
 * session joining a group has no start directory of its own to set), that
 * shell's working directory is whatever the CALLING process happened to be in.
 *
 * Nothing attaches to that session. It holds a pty and a shell until something
 * kills the server, and when the server goes it can leave the shell behind
 * re-parented to init. That is where 287 orphaned `-zsh` processes on this
 * machine came from, 376 of a 511-pty budget, and eventually
 * `posix_spawnp failed` in unrelated tests.
 *
 * The group can vanish underneath this call for ordinary reasons — every
 * session in the tab died, or a teardown raced it by 15ms — so "check first"
 * is not enough on its own. The check that counts is the one AFTER, on the
 * thing tmux actually built.
 */
describe('TmuxAdapter.newGroupMember when the group is gone', () => {
  it('refuses, and leaves no stray session holding a shell', async () => {
    await expect(
      adapter.newGroupMember('pterm-no-such-group-ffffffffffffffff', 'pterm-victim-0123456789abcdef'),
    ).rejects.toThrow(/group/i)

    // The half that matters. A throw with the session still standing would
    // leak exactly the shell this is here to prevent.
    await expect(adapter.hasSession('pterm-victim-0123456789abcdef')).resolves.toBe(false)
  })

  it('still joins a group that is really there', async () => {
    await createSession('pterm-host-0123456789abcdef')
    await adapter.newGroupMember('pterm-host-0123456789abcdef', 'pterm-member-0123456789abcdef')

    const groups = await adapter.listSessionsWithGroups()
    const member = groups.find((row) => row.name === 'pterm-member-0123456789abcdef')
    expect(member?.group).toBe('pterm-host-0123456789abcdef')
  })
})

describe('TmuxAdapter.moveWindow and windowsOf', () => {
  it('moves a session current window into another session, keeping the process', async () => {
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'holder'])
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'src'])
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'dst'])
    const before = await run('tmux', [
      '-L', SOCKET, 'display-message', '-p', '-t', '=src:', '#{pane_pid}',
    ])

    await adapter.moveWindow('src', 'dst')

    const windows = await adapter.windowsOf('dst')
    const pids = await Promise.all(
      windows.map(async (window) =>
        (await run('tmux', [
          '-L', SOCKET, 'display-message', '-p', '-t', window.id, '#{pane_pid}',
        ])).stdout.trim(),
      ),
    )
    expect(windows).toHaveLength(2)
    expect(pids).toContain(before.stdout.trim())
    expect(await adapter.hasSession('src')).toBe(false)
  })

  it('reports window indices and ids together', async () => {
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'holder'])
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'solo'])

    const windows = await adapter.windowsOf('solo')

    expect(windows).toHaveLength(1)
    expect(windows[0].index).toMatch(/^\d+$/)
    expect(windows[0].id).toMatch(/^@\d+$/)
  })

  it('answers with no windows for a session tmux does not have', async () => {
    await run('tmux', ['-L', SOCKET, 'new-session', '-d', '-s', 'holder'])

    expect(await adapter.windowsOf('nosuchsession')).toEqual([])
  })
})
