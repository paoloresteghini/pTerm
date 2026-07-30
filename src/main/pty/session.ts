import { spawn, type IPty } from 'node-pty'
import type { TmuxAdapter } from '../tmux/adapter'

export interface PtySessionOptions {
  tmuxSession: string
  cwd: string
  cols: number
  rows: number
  /** Command to run when the session is created. Ignored when reattaching. */
  command?: string
  env?: NodeJS.ProcessEnv
}

/**
 * A single attached tmux client, exposed as a PTY.
 *
 * The lifetime of this object is the lifetime of the *client*, not the tmux
 * session. Disposing it detaches; the session and everything running inside
 * it keep going. Killing the session is TmuxAdapter's job.
 */
export class PtySession {
  readonly tmuxSession: string

  private proc: IPty | null = null
  private readonly dataListeners = new Set<(data: string) => void>()
  private readonly exitListeners = new Set<(code: number) => void>()

  constructor(
    private readonly adapter: TmuxAdapter,
    private readonly options: PtySessionOptions,
  ) {
    this.tmuxSession = options.tmuxSession
  }

  start(): void {
    if (this.proc) throw new Error(`PtySession ${this.tmuxSession} already started`)

    // `new-session -A` attaches if the session exists and creates it otherwise,
    // which is exactly the open-or-adopt behaviour we want in one call.
    const args = [
      ...this.adapter.baseArgs(),
      'new-session',
      '-A',
      '-s',
      this.options.tmuxSession,
      '-c',
      this.options.cwd,
    ]
    if (this.options.command) args.push(this.options.command)

    const env = { ...process.env, ...this.options.env }
    // Electron sets this when re-execing as Node; leaking it breaks child shells.
    delete env.ELECTRON_RUN_AS_NODE
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'

    this.proc = spawn(this.adapter.bin, args, {
      name: 'xterm-256color',
      cols: this.options.cols,
      rows: this.options.rows,
      cwd: this.options.cwd,
      env: env as Record<string, string>,
    })

    this.proc.onData((data) => {
      for (const listener of this.dataListeners) listener(data)
    })
    this.proc.onExit(({ exitCode }) => {
      this.proc = null
      for (const listener of this.exitListeners) listener(exitCode)
    })
  }

  write(data: string): void {
    this.proc?.write(data)
  }

  resize(cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return
    this.proc?.resize(cols, rows)
  }

  /** Detach the client. The tmux session survives. */
  detach(): void {
    this.proc?.kill()
  }

  onData(listener: (data: string) => void): void {
    this.dataListeners.add(listener)
  }

  onExit(listener: (code: number) => void): void {
    this.exitListeners.add(listener)
  }
}
