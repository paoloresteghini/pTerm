import { spawn, type IPty } from 'node-pty'
import type { TmuxAdapter } from '../tmux/adapter'
import { canBuildDeathHook } from './deathHook'

export interface PtySessionOptions {
  tmuxSession: string
  cwd: string
  cols: number
  rows: number
  /** Command to run when the session is created. Ignored when reattaching. */
  command?: string
  env?: NodeJS.ProcessEnv
  /**
   * Path to the reporter script tmux runs when this session's pane dies.
   *
   * Not used here to build anything — `SessionManager` installs the hook — but
   * this is what says a hook is coming, and so whether `remain-on-exit` should
   * be chained onto the session as it is created. Omit and the session gets no
   * `pane-died` wiring at all, which is how every test that does not care about
   * death keeps its tmux commands unchanged.
   */
  deathReporter?: string
  /** The tab id the reporter announces. Required alongside `deathReporter`. */
  tabId?: string
  /**
   * The window this session's pane already lives in. Set only when the
   * session was created ahead of time by `newGroupMember` — a split pane,
   * never the founder of a tab — so `start()` attaches to it instead of
   * creating a session. Such a window has already been wired for death by
   * `SessionManager.splitTab`, before anything was started in it.
   */
  windowId?: string
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

    const args = [...this.adapter.baseArgs()]

    if (this.options.windowId) {
      // The member session already exists — `newGroupMember` created it
      // before this runs, and `selectWindow` has already bound it to its own
      // window — so this attaches to it rather than creating one. `-c` and
      // `-e` are `new-session` arguments; there is no session left to create
      // them onto.
      args.push('attach-session', '-t', `=${this.options.tmuxSession}`)
    } else {
      // `new-session -A` attaches if the session exists and creates it otherwise,
      // which is exactly the open-or-adopt behaviour we want in one call.
      args.push('new-session', '-A', '-s', this.options.tmuxSession, '-c', this.options.cwd)

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
    }

    // Chained into the same invocation rather than issued afterwards: a
    // separate call would race the session actually existing. `;` is tmux's
    // own command separator and reaches it intact because node-pty spawns
    // without a shell.
    // The app draws its own chrome, so tmux's status line is redundant here.
    // A session attached from a plain terminal will also have it off.
    args.push(';', 'set-option', 'status', 'off')

    // Half of how a dead tab gets a red dot instead of a grey one. The other
    // half — the `pane-died` hook — is installed by `SessionManager`, and the
    // split is forced rather than chosen.
    //
    // An attached tmux client exits 0 whether its session was killed, its
    // command crashed, or the user typed `exit` — measured three times. The
    // only place the truth survives is `#{pane_dead_status}` on the pane
    // itself, and reading that requires `remain-on-exit`, which also stops
    // tmux reaping the pane, its window and (for a group of one) its session.
    //
    // The hook cannot be chained here any more, because it names the window it
    // reaps as a literal `@<n>` and `new-session` does not say which window it
    // just made. Asking takes a second tmux invocation, and measured, a
    // command like `exit 3` is long gone before one can complete. So this
    // option goes on ATOMICALLY with the pane instead: the pane dies but is
    // preserved, its status still readable, and the hook that arrives a moment
    // later is fired against it by `TmuxAdapter.setDeathHook`.
    //
    // Window-scoped (`-w`, no `-t`, so: the window `new-session` just made).
    // Measured: a window created in this session afterwards reads the option
    // unset, so a sibling pane added by `splitTab` is untouched by this.
    //
    // Unlike `-e` above, this is a chained command rather than an argument to
    // `new-session`, so it runs on the adopt path too. That is what gives a
    // session created by an older build the wiring the moment it is reattached.
    //
    // Only on the `new-session` path: a split pane's window is created empty
    // and wired by `SessionManager.splitTab` BEFORE its command is respawned
    // into it, so by the time this attaches, both are already on.
    //
    // The two still go on together or not at all — `remain-on-exit` with no
    // hook to reap turns every ordinary `exit` into a session that never goes
    // away, the stray this project has already had once. `canBuildDeathHook`
    // asks exactly what `deathHookCommand` will, minus the window id, which
    // tmux supplies and which is never the reason it refuses.
    if (
      !this.options.windowId &&
      this.options.deathReporter &&
      this.options.tabId &&
      canBuildDeathHook({
        reporter: this.options.deathReporter,
        tabId: this.options.tabId,
        tmuxSession: this.tmuxSession,
      })
    ) {
      args.push(';', 'set-option', '-w', 'remain-on-exit', 'on')
    }

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
