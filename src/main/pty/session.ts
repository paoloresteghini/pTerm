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
    // Set session-scoped environment with `-e`, not by putting it in the
    // spawned tmux client's own process env. tmux's per-session environment
    // is not populated from the env of whichever process happens to run
    // `new-session` — that only seeds the server's *global* environment, and
    // only once, when the server itself starts. Every session created
    // afterwards on the same (already-running) server would silently read
    // back the *first* session's value instead of its own, and even that
    // first session's value would not show up under a session-scoped
    // `show-environment -t` query, only under `-g`. `-e` is applied before
    // the initial pane's shell spawns and is scoped to this session, so each
    // tab gets its own value regardless of server start order.
    //
    // On the adopt path (`-A` onto a session that already exists), `-e` is
    // simply ignored by tmux — which is fine here, because the id is the
    // second half of the session name and never changes, so a session
    // created by a previous run already holds the correct value.
    for (const [key, value] of Object.entries(this.options.env ?? {})) {
      if (value === undefined) continue
      args.push('-e', `${key}=${value}`)
    }
    if (this.options.command) args.push(this.options.command)

    // Chained into the same invocation rather than issued afterwards: a
    // separate call would race the session actually existing. `;` is tmux's
    // own command separator and reaches it intact because node-pty spawns
    // without a shell.
    // The app draws its own chrome, so tmux's status line is redundant here.
    // A session attached from a plain terminal will also have it off.
    args.push(';', 'set-option', 'status', 'off')

    // This is the tmux *client* process's own env, not the session's — that
    // is what the `-e` args above are for. Spreading `this.options.env` in
    // here too would be dead weight at best (it does not reach the session)
    // and misleading at worst.
    const env = { ...process.env }
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
