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
}
