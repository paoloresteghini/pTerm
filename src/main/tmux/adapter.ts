import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isPrcliSession } from './names'

const run = promisify(execFile)

export class TmuxNotInstalledError extends Error {
  constructor(message = 'tmux is not installed or not on PATH') {
    super(message)
    this.name = 'TmuxNotInstalledError'
  }
}

export interface TmuxAdapterOptions {
  bin?: string
  /** tmux server socket name. Tests pass one so they never touch the user's server. */
  socket?: string
}

/**
 * The three answers `lookupWindow` can give, where `windowIdOf` used to
 * collapse all of them into `''`: a window it can name (`found`), a session
 * it can positively say tmux has never heard of (`gone`), and a tmux that
 * failed for some other reason and cannot be trusted either way
 * (`unreachable`).
 */
export type WindowLookup = { kind: 'found'; id: string } | { kind: 'gone' } | { kind: 'unreachable' }

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function stderrOf(error: unknown): string {
  const value = (error as { stderr?: unknown } | undefined)?.stderr
  if (typeof value === 'string') return value
  // execFile hands back a Buffer under `encoding: 'buffer'`. Returning '' for
  // it would silently stop every stderr match below from ever firing.
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

/**
 * tmux reports "no server for this socket" two different ways depending on
 * whether the socket file was ever created:
 *   never created  -> error connecting to /tmp/.../sock (No such file or directory)
 *   created, gone  -> no server running on /tmp/.../sock
 * Both mean zero sessions. Anything else is a real failure and must throw.
 */
function isNoServer(error: unknown): boolean {
  const stderr = stderrOf(error)
  return (
    /no server running/i.test(stderr) ||
    /error connecting to .*no such file or directory/i.test(stderr)
  )
}

/**
 * The session genuinely is not there: either tmux said so, or there is no
 * server at all. Every other failure — unreachable socket, permission denied,
 * a wedged server — is a real error and must not be read as "absent".
 */
function isNoSuchSession(error: unknown): boolean {
  return /can't find session/i.test(stderrOf(error)) || isNoServer(error)
}

export class TmuxAdapter {
  readonly bin: string
  private readonly socket?: string

  constructor(options: TmuxAdapterOptions = {}) {
    this.bin = options.bin ?? 'tmux'
    this.socket = options.socket
  }

  /** Args that must precede every tmux subcommand. PtySession needs these too. */
  baseArgs(): string[] {
    return this.socket ? ['-L', this.socket] : []
  }

  private async exec(args: string[]): Promise<string> {
    try {
      const { stdout } = await run(this.bin, [...this.baseArgs(), ...args])
      return stdout
    } catch (error) {
      if (isEnoent(error)) throw new TmuxNotInstalledError()
      throw error
    }
  }

  async version(): Promise<string> {
    return (await this.exec(['-V'])).trim()
  }

  async listSessions(): Promise<string[]> {
    try {
      const stdout = await this.exec(['list-sessions', '-F', '#{session_name}'])
      return stdout.split('\n').map((line) => line.trim()).filter(Boolean)
    } catch (error) {
      if (isNoServer(error)) return []
      throw error
    }
  }

  async listPrcliSessions(): Promise<string[]> {
    return (await this.listSessions()).filter(isPrcliSession)
  }

  /** `=name` is tmux's exact-match syntax; without it `prcli-lumio` matches by prefix. */
  async hasSession(name: string): Promise<boolean> {
    try {
      await this.exec(['has-session', '-t', `=${name}`])
      return true
    } catch (error) {
      if (isNoSuchSession(error)) return false
      throw error
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await this.exec(['kill-session', '-t', `=${name}`])
    } catch (error) {
      if (error instanceof TmuxNotInstalledError) throw error
      // Killing something already gone is success. Anything else is not, and
      // an unverifiable kill counts as a failure — resolving would report
      // success while the processes carry on running.
      let stillRunning: boolean
      try {
        stillRunning = await this.hasSession(name)
      } catch {
        throw error
      }
      if (stillRunning) throw error
    }
  }

  /**
   * Rename a session in place. Everything running inside it is untouched —
   * this only changes the name, and with it which project the tab matches.
   *
   * `=from` is exact-match syntax; without it `prcli-lumio` would match by
   * prefix. Note the target here takes no trailing colon: unlike
   * `set-option`/`show-options`, `rename-session`'s `-t` is a session target
   * already.
   */
  async renameSession(from: string, to: string): Promise<void> {
    await this.exec(['rename-session', '-t', `=${from}`, to])
  }

  /**
   * `=name:` keeps this on one session; without it tmux matches by prefix.
   * The trailing `:` is required here (unlike `has-session`/`kill-session`):
   * for `set-option`/`show-options` tmux parses a bare `=name` as an
   * exact-match *window* target and reports "no such session", so the
   * session part of the target must be terminated explicitly.
   */
  async setSessionOption(name: string, option: string, value: string): Promise<void> {
    await this.exec(['set-option', '-t', `=${name}:`, option, value])
  }

  async getSessionOption(name: string, option: string): Promise<string> {
    return (await this.exec(['show-options', '-t', `=${name}:`, '-v', option])).trim()
  }

  /**
   * Where the session's pane actually is, or `''` if tmux will not say.
   *
   * The trailing colon on the target is the same requirement the option
   * methods above carry: without it this is an exact-match *window* target and
   * tmux answers "can't find pane".
   *
   * Empty rather than throwing, because every caller has something better to
   * do with a missing answer than fail: a session whose directory cannot be
   * read is still a session worth listing, killing and reattaching.
   */
  async paneCurrentPath(name: string): Promise<string> {
    try {
      return (
        await this.exec(['display-message', '-p', '-t', `=${name}:`, '#{pane_current_path}'])
      ).trim()
    } catch {
      return ''
    }
  }

  /**
   * Every session with the group it belongs to, `''` when it belongs to none.
   *
   * A one-pane tab is an ungrouped session, so an empty group is the common
   * case rather than an error. This is what reassembles tabs from live tmux
   * instead of from anything stored.
   */
  async listSessionsWithGroups(): Promise<{ name: string; group: string }[]> {
    try {
      const stdout = await this.exec([
        'list-sessions', '-F', '#{session_name}\t#{session_group}',
      ])
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [name, group = ''] = line.split('\t')
          return { name, group }
        })
    } catch (error) {
      if (isNoServer(error)) return []
      throw error
    }
  }

  /**
   * The window the session is currently showing, or `''` if tmux will not say.
   *
   * Trailing colon: without it this is an exact-match window target and tmux
   * answers "can't find pane".
   *
   * Kept only for the callers that have nothing better to do with a missing
   * answer than treat it as absent either way — a founder's own window,
   * looked up so it can be resized back to what the app already tracked for
   * it, and a cached window id refreshed lazily on resize. Anywhere the
   * difference between "gone" and "tmux would not answer" matters, use
   * `lookupWindow` instead.
   */
  async windowIdOf(name: string): Promise<string> {
    try {
      return (
        await this.exec(['display-message', '-p', '-t', `=${name}:`, '#{window_id}'])
      ).trim()
    } catch {
      return ''
    }
  }

  /**
   * The window a session is currently showing, distinguishing the three cases
   * `windowIdOf` collapses into `''`. See `WindowLookup`.
   *
   * **Measured on tmux 3.7b:** `display-message` naming a session that does
   * not exist SUCCEEDS, with one blank line of stdout —
   * `$ tmux -L probe display-message -p -t '=nosuchsession:' '#{window_id}'`
   * exits 0 with empty output. It never reaches `isNoSuchSession`, which only
   * ever sees a *failure*. So empty-on-success has to be read as `gone` here,
   * directly — not inferred from an error that will not occur. This is also
   * what a session `open()` has just asked tmux to create looks like in the
   * instant before tmux has finished making it, which is the ordinary case
   * `awaitWindowId` polls through.
   *
   * `isNoSuchSession` (which folds in `isNoServer`) still covers the failure
   * shape a session on a socket that was never created produces. Anything
   * else that fails is `unreachable`: this app cannot tell what tmux meant,
   * and reading it as `gone` would be the exact conflation this method exists
   * to remove.
   */
  async lookupWindow(name: string): Promise<WindowLookup> {
    let stdout: string
    try {
      stdout = await this.exec(['display-message', '-p', '-t', `=${name}:`, '#{window_id}'])
    } catch (error) {
      if (error instanceof TmuxNotInstalledError) throw error
      if (isNoSuchSession(error)) return { kind: 'gone' }
      return { kind: 'unreachable' }
    }
    const id = stdout.trim()
    return id ? { kind: 'found', id } : { kind: 'gone' }
  }

  /**
   * A window id (`@7`) is already an exact target and takes no `=` or colon.
   * Killing one that has gone is success — the death hook may have reaped it
   * a moment earlier, and that race is expected rather than exceptional.
   */
  async killWindow(windowId: string): Promise<void> {
    try {
      await this.exec(['kill-window', '-t', windowId])
    } catch (error) {
      if (error instanceof TmuxNotInstalledError) throw error
      if (/can't find window/i.test(stderrOf(error)) || isNoServer(error)) return
      throw error
    }
  }

  /**
   * Bind a member session to the window it is the view of.
   *
   * By INDEX, and with the member named. Measured: a bare `select-window -t @7`
   * binds whichever session tmux picks — in the probe, the wrong one — and a
   * doubled `-t` silently keeps only the last, so both bind nothing and exit 0.
   * Members of a group share one window list, so the index is the same for all
   * of them and naming the member is what makes this unambiguous.
   */
  async selectWindow(name: string, windowIndex: string): Promise<void> {
    await this.exec(['select-window', '-t', `=${name}:${windowIndex}`])
  }

  /**
   * A window-scoped option. `remain-on-exit` is set this way rather than on the
   * session so a sibling pane's window is left alone — measured: the sibling
   * window reads unset afterwards.
   */
  async setWindowOption(windowId: string, option: string, value: string): Promise<void> {
    await this.exec(['set-option', '-w', '-t', windowId, option, value])
  }

  async resizeWindow(windowId: string, cols: number, rows: number): Promise<void> {
    await this.exec(['resize-window', '-t', windowId, '-x', String(cols), '-y', String(rows)])
  }

  /**
   * A window-scoped hook. Measured: a `pane-died` hook set with `-w` fires only
   * for its own window, where a session-scoped one is shared by every member of
   * the group.
   */
  async setWindowHook(windowId: string, hook: string, command: string): Promise<void> {
    await this.exec(['set-hook', '-w', '-t', windowId, hook, command])
  }

  /**
   * Install the `pane-died` hook on a window, and fire it if the pane is
   * already dead.
   *
   * The catch-up is what makes a late hook harmless. `open()` cannot know its
   * window id until tmux has made the session, so the hook always arrives after
   * the pane, and a pane running `exit 3` is dead before it does — measured, on
   * every run. `remain-on-exit` (chained atomically by `PtySession.start()`)
   * keeps that dead pane readable, and `set-hook -R` then runs the hook against
   * it: measured, `#{pane_dead_status}` still expands to 3 and the reap
   * proceeds exactly as if the hook had been there all along.
   *
   * Both halves go in ONE invocation on purpose. tmux runs a command list to
   * completion inside a single event-loop callback, so no pane death can be
   * processed between them — which is what stops a pane that dies right here
   * from being reported twice, once by the hook and once by the catch-up.
   *
   * `if-shell -F` tests the format rather than running a shell, so the
   * condition is tmux's own view of the pane and not a subprocess's.
   */
  async setDeathHook(windowId: string, command: string): Promise<void> {
    try {
      await this.exec([
        'set-hook', '-w', '-t', windowId, 'pane-died', command,
        ';',
        'if-shell', '-F', '-t', windowId, '#{pane_dead}',
        `set-hook -w -t ${windowId} -R pane-died`,
      ])
    } catch (error) {
      if (error instanceof TmuxNotInstalledError) throw error
      // Two expected non-zero exits, both measured, neither a failure:
      //
      // "no current target" — what the catch-up run itself exits with. The
      // hook has already reported and reaped by then; the status came back as
      // 3 and the session was gone. tmux is complaining that the commands it
      // just ran had no client to belong to, not that they did nothing. This
      // is the "exits non-zero and did the work" mirror of the defect class
      // that produced every other bug here, and the state is what settles it.
      //
      // "can't find window" — the window went between being named and being
      // hooked. Nothing survives to leak, so there is nothing to install.
      if (/no current target/i.test(stderrOf(error))) return
      if (/can't find window/i.test(stderrOf(error)) || isNoServer(error)) return
      throw error
    }
  }

  /**
   * Replace what a pane is running.
   *
   * How a split pane's command is started AFTER its window has been wired for
   * death rather than as part of creating it. Measured: with the command on
   * `new-window`, `sh -c "exit 3"` was gone before the next tmux call — nothing
   * had set `remain-on-exit` yet, so tmux reaped the pane, the window and the
   * index, and `select-window` then failed with "can't find window: 1".
   *
   * `-k` kills whatever is in the pane first. Measured: that does NOT fire
   * `pane-died`, even with `remain-on-exit` on and the hook already installed,
   * so clearing the placeholder shell cannot report a death of its own.
   *
   * `-c` and `-e` are passed rather than assumed: a respawn does not inherit
   * the start directory or environment the window was created with.
   */
  async respawnPane(
    windowId: string,
    input: { command: string; cwd: string; env?: Record<string, string> },
  ): Promise<void> {
    const args = ['respawn-pane', '-k', '-t', windowId, '-c', input.cwd]
    for (const [key, value] of Object.entries(input.env ?? {})) {
      args.push('-e', `${key}=${value}`)
    }
    args.push(input.command)
    await this.exec(args)
  }

  /**
   * A new window in the group, holding one pane. Returns its window id.
   *
   * `-P -F '#{window_id} #{window_index}'` is what makes the id knowable here:
   * the death hook needs it as a literal, because tmux does not expand formats
   * in a command argument outside `run-shell`.
   *
   * It takes no command, and must not: a command given to `new-window` starts
   * before anything can set `remain-on-exit` on the window it is in, and one
   * that exits quickly takes the whole window with it. `respawnPane` is how a
   * command gets in here, once the window is wired.
   */
  async newWindow(input: {
    /** A LIVE member session, never the group name — see Global Constraints. */
    member: string
    cwd: string
    env?: Record<string, string>
  }): Promise<{ id: string; index: string }> {
    const args = [
      'new-window', '-d', '-P', '-F', '#{window_id} #{window_index}',
      '-t', `=${input.member}:`, '-c', input.cwd,
    ]
    for (const [key, value] of Object.entries(input.env ?? {})) {
      args.push('-e', `${key}=${value}`)
    }
    const [id, index] = (await this.exec(args)).trim().split(' ')
    return { id, index }
  }

  /**
   * Join `name` to `group` as a new view onto its shared window list.
   *
   * `env` lands in `name`'s own session-environment table — `show-environment
   * -t =name` reports it — because this call reuses `new-session`'s `-e`, not
   * `new-window`'s: measured, `new-window -e` reaches the spawned pane's
   * process but never that table.
   */
  async newGroupMember(group: string, name: string, env?: Record<string, string>): Promise<void> {
    const args = ['new-session', '-d', '-t', group, '-s', name]
    for (const [key, value] of Object.entries(env ?? {})) {
      args.push('-e', `${key}=${value}`)
    }
    await this.exec(args)
  }
}
