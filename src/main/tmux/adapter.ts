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
  return typeof value === 'string' ? value : ''
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
      if (error instanceof TmuxNotInstalledError) throw error
      return false
    }
  }

  async killSession(name: string): Promise<void> {
    try {
      await this.exec(['kill-session', '-t', `=${name}`])
    } catch (error) {
      if (error instanceof TmuxNotInstalledError) throw error
      // Killing something already gone is success. Anything else is not.
      if (await this.hasSession(name)) throw error
    }
  }
}
