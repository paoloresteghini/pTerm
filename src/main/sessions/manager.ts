import type { TmuxAdapter, WindowLookup } from '../tmux/adapter'
import { PtySession } from '../pty/session'
import { deathHookCommand } from '../pty/deathHook'
import { decodeSessionName, encodeSessionName, newSessionId, tabIdFromGroupName } from '../tmux/names'
// Declared with the other wire types: the renderer needs to tell a
// deliberate `killed` apart from a genuine exit too (see `ExitEvent.reason`
// in shared/ipc.ts), so a second, main-only definition here would only
// invite drift. Re-exported so existing importers keep working unchanged.
import type { ExitReason, TabType } from '../../shared/ipc'

export type { ExitReason }

export interface PaneRecord {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  tmuxSession: string
  type: TabType
}

export interface OpenInput {
  projectSlug: string
  cwd: string
  command?: string
  /** Supply to reattach an existing tab; omit to create a new one. */
  id?: string
  /** Saved tmux name, checked against the one this input encodes to. */
  tmuxSession?: string
  cols?: number
  rows?: number
  type?: TabType
}

interface Entry {
  record: PaneRecord
  session: PtySession
  /**
   * The client's live geometry, kept current by `resize`. A reattach has to
   * spawn at this size: the reattached client is usually the session's only
   * one, so tmux resizes the window to match it and SIGWINCHes whatever is
   * running inside. Attaching at the 80×24 default therefore reflows the
   * user's scrollback, permanently.
   */
  cols: number
  rows: number
  /**
   * The window this pane's process lives in, once anything has had to name it.
   *
   * Known up front for a split pane (`splitTab` made the window itself) and
   * looked up lazily for a founder, whose window does not exist yet when its
   * entry is created. A pane's window does not change for the entry's
   * lifetime — a move disposes the entry and makes a new one — so this is
   * cached rather than asked for on every resize.
   */
  windowId?: string
  /**
   * Set before we deliberately tear a client down, so the PTY's exit callback
   * can tell a detach or a kill apart from the child genuinely exiting.
   */
  intent?: 'detached' | 'killed'
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/**
 * How long to wait for `open()`'s tmux session to exist, and how often to ask.
 *
 * The ceiling matches what the death tests already treat as the outside time
 * for a session to appear. It is a wait for an object to be created, not a
 * retry of something that failed: `lookupWindow` answers `gone` for a session
 * tmux has never heard of, and `PtySession.start()` returns before the client
 * it spawned has created one.
 */
const WINDOW_ID_TIMEOUT_MS = 10_000
const WINDOW_ID_POLL_MS = 20

export class SessionManager {
  private readonly entries = new Map<string, Entry>()
  private readonly dataListeners = new Set<(id: string, data: string) => void>()
  private readonly exitListeners = new Set<
    (record: PaneRecord, code: number, reason: ExitReason) => void
  >()

  constructor(
    private readonly adapter: TmuxAdapter,
    private readonly options: { deathReporter?: string } = {},
  ) {}

  open(input: OpenInput): PaneRecord {
    const id = input.id ?? newSessionId()
    if (this.entries.has(id)) throw new Error(`session ${id} is already open`)

    const tmuxSession = encodeSessionName({ projectSlug: input.projectSlug, id })
    // A saved name that disagrees with what this input encodes to means the
    // record is corrupt. Attaching anyway would silently create an empty
    // session under the encoded name and strand the real one.
    if (input.tmuxSession !== undefined && input.tmuxSession !== tmuxSession) {
      throw new Error(
        `open: saved tmux session ${JSON.stringify(input.tmuxSession)} ` +
          `does not match ${JSON.stringify(tmuxSession)}`,
      )
    }

    const record: PaneRecord = {
      id,
      projectSlug: input.projectSlug,
      cwd: input.cwd,
      command: input.command,
      tmuxSession,
      type: input.type ?? 'shell',
    }

    const cols = input.cols ?? DEFAULT_COLS
    const rows = input.rows ?? DEFAULT_ROWS

    return this.attach(record, { cols, rows })
  }

  /**
   * Wire a PTY session for `record` and register it as the live entry.
   *
   * Pulled out of `open()` so `splitTab()` can share the same data/exit
   * listener wiring. `windowId` is the only thing that differs between the
   * two callers: `open()` leaves it unset and creates its session with
   * `new-session -A`; `splitTab()` already knows the window `newWindow`
   * created and passes it through, so `PtySession` attaches to the existing
   * member instead. It is also what says whether the pane's death hook still
   * has to be installed, or was installed before its command started.
   */
  private attach(
    record: PaneRecord,
    { cols, rows, windowId }: { cols: number; rows: number; windowId?: string },
  ): PaneRecord {
    const id = record.id

    const session = new PtySession(this.adapter, {
      tmuxSession: record.tmuxSession,
      cwd: record.cwd,
      cols,
      rows,
      command: record.command,
      // What the hook script reads to say which tab an event came from.
      //
      // tmux gives a session the client environment it was *created* with, and
      // a reattach does not update it. That is right rather than a limitation:
      // the id is the second half of the session name and never changes, so a
      // session created by a previous run already holds the correct value.
      //
      // Every tab gets this, not only `claude` tabs. The way this app is used
      // is to open a tab and type `claude` into it, and a type field that
      // decided who got an id would leave exactly those sessions dark.
      env: { PRCLI_TAB_ID: id },
      // The reporter is reached by absolute path rather than through the
      // session's environment: tmux runs a hook's command with the server's
      // environment, not the session's, so `$PRCLI_TAB_ID` is not set there —
      // which is why the id is baked into the command instead of read from it.
      deathReporter: this.options.deathReporter,
      tabId: id,
      windowId,
    })

    const entry: Entry = { record, session, cols, rows, windowId }

    session.onData((data) => {
      for (const listener of this.dataListeners) listener(id, data)
    })
    session.onExit((code) => {
      // Compare identity, not just the id: a detached tab can be reopened
      // before its old client's exit lands, and that late event must not
      // evict the new entry.
      if (this.entries.get(id) === entry) this.entries.delete(id)
      const reason: ExitReason = entry.intent ?? 'exited'
      // The record travels with the event: by the time a listener runs the
      // entry is gone, and a listener that has to check whether the tmux
      // session survived needs its name.
      for (const listener of this.exitListeners) listener(record, code, reason)
    })

    this.entries.set(id, entry)
    session.start()
    // A tab that has never been split is a group of one, and its single pane's
    // window is only knowable after `new-session` has made it — so its hook is
    // installed here, asynchronously, rather than chained into the spawn. It
    // needs the window id as a literal.
    //
    // `splitTab` is not in this branch because it has already wired its own
    // window, before the command in it was started; there is nothing left to
    // race there.
    if (!windowId) {
      // Swallowed deliberately. Everything expected is already tolerated
      // inside the adapter, so what reaches here is a tmux this app cannot
      // talk to at all, and that is not worth taking the main process down
      // for. The cost is a tab whose death shows grey instead of red —
      // `wireDeathHook` has already taken `remain-on-exit` back off by the
      // time anything reaches here, on every path where it can name the
      // window, so it is not also a stray session.
      void this.wireDeathHook(record, null).catch(() => {})
    }
    // Every attach sizes the window its client is about to see — not only a
    // founder's, and not gated on `options.deathReporter` the way the hook
    // above is (a manager built without one still owes its client the right
    // size). `resize-window` flips a window straight to `window-size manual`
    // the moment it is first called — measured on tmux 3.7b: a window whose
    // `window-size` was unset reads back `manual` immediately after one
    // `resize-window -x 140 -y 45` — so `latest` cannot be trusted to carry a
    // reattaching client's geometry onto the window past that point. This is
    // the third disguise of a geometry defect that has already shipped twice
    // (a bare 80x24 `new-session -A`, then `window-size manual` reverting to
    // the size recorded at window creation); without an explicit resize on
    // every attach, the first caller to attach to a window it did not itself
    // just size — restore, primarily — inherits whatever size that window
    // last happened to have.
    //
    // Routed through the private `resizeWindow`, not `adapter.resizeWindow`
    // directly: this lookup cannot land synchronously with `attach`, so by
    // the time it resolves a renderer `resize()` may already have moved the
    // window on to a newer size. `resizeWindow` re-checks the entry's current
    // `cols`/`rows` against what was requested here before its own call
    // lands, which is what stops that late resize from being the one that
    // wins.
    void this.sizeWindowOnAttach(entry, windowId ?? null, cols, rows).catch(() => {})
    return record
  }

  /**
   * Resolve the window a freshly attached client's pane lives in, and size it
   * to that client. See the comment at the call site in `attach` for why this
   * exists at all.
   *
   * `windowId` is already known for `splitTab`, which made the window itself
   * before any client attached to it. For `open()` it is not: the window does
   * not exist until tmux has created it, so it is polled for the same way
   * `wireDeathHook` polls for its own — and a `gone` or `unreachable` answer
   * is skipped rather than guessed at, for the same reason `wireDeathHook`
   * skips them.
   */
  private async sizeWindowOnAttach(
    entry: Entry,
    windowId: string | null,
    cols: number,
    rows: number,
  ): Promise<void> {
    const lookup: WindowLookup = windowId
      ? { kind: 'found', id: windowId }
      : await this.awaitWindowId(entry.record.tmuxSession)
    if (lookup.kind !== 'found') return
    entry.windowId = lookup.id
    await this.resizeWindow(entry, cols, rows)
  }

  /**
   * Put the `pane-died` hook on the window a pane lives in, so its death reaps
   * that window and its own member session and nothing else.
   *
   * `windowId` is null for `open()`, which has to wait for tmux to make the
   * window before it can name it, and set for `splitTab()`, which made the
   * window itself and knows it before anything is running in it. That
   * difference is also why `remain-on-exit` is set in two different places:
   * `open()`'s is chained into `new-session` because a fast command would
   * otherwise be reaped before a second tmux call could land, while a split's
   * window is empty until this has finished with it.
   *
   * That asymmetry is what makes every early return below load-bearing. On the
   * split path a hook that does not go on leaves the window as tmux made it,
   * and nothing is owed. On the `open()` path the option is ALREADY ON before
   * this function runs, so the same early return would leave the together-or-
   * not-at-all rule broken — every ordinary `exit` preserved as a dead pane in
   * a window and a session nothing reaps, which the next restore then adopts
   * as a live tab. So each one takes the option back off first.
   */
  private async wireDeathHook(record: PaneRecord, windowId: string | null): Promise<void> {
    const reporter = this.options.deathReporter
    if (!reporter) return

    const lookup: WindowLookup = windowId
      ? { kind: 'found', id: windowId }
      : await this.awaitWindowId(record.tmuxSession)

    if (lookup.kind === 'gone') {
      // A session tmux has never heard of. `remain-on-exit` is a WINDOW
      // option, chained into the very `new-session` that would have created
      // this one (`PtySession.start()`) — so a session tmux has never heard
      // of either never ran that chain to completion, or the window it set
      // the option on has since died and been reaped along with the session
      // itself (a kill racing this wait). Either way there is no window left
      // here to take the option back off of, and nothing left to leak.
      return
    }

    if (lookup.kind === 'unreachable') {
      // Honest degradation, not a repair: naming a window is exactly what
      // tmux has just declined to do, so there is no window to take
      // `remain-on-exit` back off of either. If the session is actually fine
      // its pane is left preserved on exit with nothing to reap it, and only
      // the next restore's reconcile will notice — logged here because
      // nothing else will report it.
      console.error(
        `PRCLI: tmux was unreachable while wiring the death hook for ${record.tmuxSession}; ` +
          'this pane will show grey instead of red when it exits',
      )
      return
    }

    const window = lookup.id

    const command = deathHookCommand({
      reporter,
      tabId: record.id,
      tmuxSession: record.tmuxSession,
      windowId: window,
    })
    if (!command) {
      // Refused, so no hook is coming. Cannot happen while `lookupWindow`
      // reports `found` with tmux's own `@<n>` — `PtySession` asks
      // `canBuildDeathHook`, which tests everything this does bar the window
      // id — but the rule is held here rather than inferred from that.
      await this.disableRemainOnExit(window)
      return
    }

    // Split path only. `open()`'s window already carries this, chained into
    // the command that created it. Window-scoped either way, so a sibling
    // pane's window is untouched — measured: it reads the option unset.
    if (windowId) await this.adapter.setWindowOption(windowId, 'remain-on-exit', 'on')

    try {
      await this.adapter.setDeathHook(window, command)
    } catch (error) {
      // The same rule reached from the other side: the option is on — set at
      // spawn on the `open()` path, one line above on the split path — and the
      // hook is not. Everything tmux is expected to say here is already
      // tolerated inside `setDeathHook`, so what lands in this catch is a real
      // failure worth propagating; the option still has to come off first.
      await this.disableRemainOnExit(window)
      throw error
    }
  }

  /**
   * Take `remain-on-exit` off a window whose `pane-died` hook did not go on.
   *
   * Best effort, and swallowed on purpose. Every caller is already on a path
   * where tmux has refused something, so this may be refused too — and it
   * cannot make matters worse: afterwards the option is either off, or it was
   * never reachable to begin with. The caller's own error is the one worth
   * raising.
   */
  private async disableRemainOnExit(windowId: string): Promise<void> {
    try {
      await this.adapter.setWindowOption(windowId, 'remain-on-exit', 'off')
    } catch {
      // Nothing further to try. See above.
    }
  }

  /**
   * The window a session's pane is in, waited for rather than asked once.
   *
   * `PtySession.start()` spawns a tmux client and returns; the session that
   * client creates does not exist for some milliseconds after that, and
   * `lookupWindow` answers `gone` for a session tmux has never heard of, not
   * only for one that will never exist. Asking once would leave most tabs
   * with no hook at all.
   *
   * Polls only while the answer is `gone` **and** the deadline has not
   * passed. `found` and `unreachable` both return immediately: the first
   * because there is nothing left to wait for, the second because polling
   * would not turn a tmux this app cannot talk to into one it can.
   */
  private async awaitWindowId(tmuxSession: string): Promise<WindowLookup> {
    const deadline = Date.now() + WINDOW_ID_TIMEOUT_MS
    for (;;) {
      const lookup = await this.adapter.lookupWindow(tmuxSession)
      if (lookup.kind !== 'gone') return lookup
      if (Date.now() >= deadline) return lookup
      await new Promise((resolve) => setTimeout(resolve, WINDOW_ID_POLL_MS))
    }
  }

  /**
   * The tmux group this pane's tab is, or the pane's own session name when the
   * tab is still a group of one.
   *
   * An ungrouped session reports an empty `session_group` (measured), which is
   * the ordinary state of every tab that has never been split — not an error.
   * `new-session -t <name>` accepts a session name or a group name, so the
   * founder's own name is the right thing to hand it either way.
   */
  async groupNameOf(paneId: string): Promise<string> {
    const record = this.entries.get(paneId)?.record
    if (!record) throw new Error(`groupNameOf: no pane ${paneId}`)
    const rows = await this.adapter.listSessionsWithGroups()
    const row = rows.find((candidate) => candidate.name === record.tmuxSession)
    return row?.group || record.tmuxSession
  }

  /**
   * Add a pane to the tab that already holds `paneId`.
   *
   * Three tmux objects, in this order and no other:
   *   1. `new-window -e PRCLI_TAB_ID=<new id>` in the group — holds the process.
   *   2. `new-session -t <group> -s <new name>` — the view the xterm attaches to.
   *   3. `select-window` binding 2 to 1, BEFORE any client attaches.
   *
   * Step 3 before the attach is not stylistic. A newly joined member's current
   * window is arbitrary, so a client attaching first lands on a sibling's window
   * and resizes it.
   */
  async splitTab(input: {
    paneId: string
    cwd?: string
    command?: string
    type?: TabType
    cols?: number
    rows?: number
  }): Promise<PaneRecord> {
    const sibling = this.entries.get(input.paneId)
    if (!sibling) throw new Error(`splitTab: no pane ${input.paneId}`)

    const group = await this.groupNameOf(input.paneId)
    const id = newSessionId()
    const cwd = input.cwd ?? sibling.record.cwd
    const cols = input.cols ?? DEFAULT_COLS
    const rows = input.rows ?? DEFAULT_ROWS
    const tmuxSession = encodeSessionName({
      projectSlug: sibling.record.projectSlug,
      id,
    })

    // Sizing is explicit rather than left to `window-size latest`, which fixes
    // a window's size when a client BEGINS viewing it and did not re-size on a
    // later select-window.
    //
    // Set with `-w` against a WINDOW ID, never through a session target.
    // `window-size` is a window option, not a session one — measured:
    // `show-options -g` has no `window-size` in it and `show-options -gw` does.
    // `set-option -t '=<name>:'` on a window option therefore resolves to
    // whatever window that session is *currently showing*, which is a real
    // target and a wrong one: a freshly joined group member's current window is
    // a SIBLING's (measured, `@0` every time), so the option lands on the
    // founder's window and the pane it was meant for stays on `latest`.
    // The window id is unambiguous and needs no ordering to be correct.
    //
    // `window-size manual` does not merely stop tracking the client — it
    // reverts the window to the size recorded at window CREATION, discarding
    // whatever it grew to afterward. Measured on two sequences:
    //   detached `new-session` (no `-x`/`-y`, no client), client attaches
    //     later: recorded size is tmux's `default-size`, 80x24; manual mode
    //     reverts straight to it, discarding the 100x30-ish client entirely.
    //   `new-session -A` with a client attaching in the SAME chained command
    //     `open()` actually uses (`; set-option status off` runs after, not
    //     before): the window is negotiated against the client with the
    //     status line still on — one row short of what's visible once it's
    //     turned off — and THAT is what gets recorded. A founder opened at
    //     100x30 records 100x29, and manual mode reverts to that: measured,
    //     repeatably, on this exact chain.
    // Either way the founder's own client is silently overridden, which is
    // the 80x24 geometry defect class again, just reached through
    // `window-size manual` instead of a bare reattach. The fix is the same
    // shape: force the window back explicitly, to the founder's own tracked
    // size, right after. This resize is load-bearing — removing it silently
    // reintroduces a founder pane wrapped one row short of its real size.
    const founderWindow = await this.adapter.windowIdOf(sibling.record.tmuxSession)
    if (founderWindow) {
      await this.adapter.setWindowOption(founderWindow, 'window-size', 'manual')
      await this.adapter.resizeWindow(founderWindow, sibling.cols, sibling.rows)
    }

    // The new window is created through a LIVE member, not the group name, and
    // EMPTY — the command follows at the end, once the window can survive it.
    //
    // Everything from here on is guarded. The window is the first object this
    // makes that the app cannot see and tmux can: it goes into the tab's
    // SHARED window list holding a running shell, where only `list-windows`
    // would ever find it again. The member session that follows is worse — it
    // is a name `findOrphans` reports as a real pane, so the next restore
    // resurrects a pane the user never created, attached to a window nothing
    // has a record of. See `rollbackSplit`.
    const window = await this.adapter.newWindow({
      member: sibling.record.tmuxSession,
      cwd,
      env: { PRCLI_TAB_ID: id },
    })

    const record: PaneRecord = {
      id,
      projectSlug: sibling.record.projectSlug,
      cwd,
      command: input.command,
      tmuxSession,
      type: input.type ?? 'shell',
    }

    try {
      // The new pane's own window is sized by window id, and before any client
      // has attached to it — so there is no ordering here that has to hold for
      // the geometry rule to be in force. Without the explicit resize,
      // `manual` would revert this window to the size tmux recorded when
      // `newWindow` made it, which is the founder's, not this pane's.
      await this.adapter.setWindowOption(window.id, 'window-size', 'manual')
      await this.adapter.resizeWindow(window.id, cols, rows)
      // The env goes here too, not only on `newWindow`: `-e` on `new-window`
      // reaches the spawned pane's own process (confirmed: a child inside it
      // sees it) but never the session's environment table — `show-environment`
      // on the new member reports nothing. `-e` on `new-session -t <group>`
      // does reach that table, which is where a reattach and any
      // `show-environment` caller both go looking, so both calls carry it.
      await this.adapter.newGroupMember(group, tmuxSession, { PRCLI_TAB_ID: id })
      // By index, with the member named. See the adapter method's comment.
      await this.adapter.selectWindow(tmuxSession, window.index)
      return await this.finishSplit(record, window, cols, rows)
    } catch (error) {
      await this.rollbackSplit(record, window.id)
      throw error
    }
  }

  /**
   * The last three steps of a split, kept together so `splitTab`'s try block
   * reads as one guarded sequence rather than a wall of awaits.
   */
  private async finishSplit(
    record: PaneRecord,
    window: { id: string; index: string },
    cols: number,
    rows: number,
  ): Promise<PaneRecord> {
    // Wired before the command runs, and after the member session exists.
    //
    // Before, because a command given to `new-window` starts immediately:
    // measured, `sh -c "exit 3"` was gone before `select-window` could run and
    // took its window and index with it ("can't find window: 1"), because
    // nothing had set `remain-on-exit` yet. There is no status left to read
    // once tmux has reaped the pane.
    //
    // After, because the hook's first act is to kill this pane's member
    // session by name. Wiring before `newGroupMember` would leave a hook that
    // fires against a session that does not exist yet, and the reap would take
    // the window while `selectWindow` was still trying to bind to it.
    await this.wireDeathHook(record, window.id)
    if (record.command) {
      await this.adapter.respawnPane(window.id, {
        command: record.command,
        cwd: record.cwd,
        env: { PRCLI_TAB_ID: record.id },
      })
    }

    return this.attach(record, { cols, rows, windowId: window.id })
  }

  /**
   * Undo a half-built split.
   *
   * Without this, a throw anywhere after `newWindow` leaves two things behind
   * that nothing will ever collect: an orphan window running a shell inside
   * the tab's shared window list, and — once `newGroupMember` has run — a
   * member session that `findOrphans` cannot tell from a real pane.
   *
   * The failure that reaches here is not hypothetical. The placeholder shell
   * `newWindow` creates can die on its own before `respawnPane` replaces it (a
   * login shell failing on a bad rc file, a `cwd` removed under it); the hook
   * wired a moment earlier then fires, reports an `Exit` for an id the
   * renderer has never seen, and reaps the window — after which `respawn-pane`
   * fails with "can't find window" and lands here.
   *
   * Which is why both adapter calls being tolerant of an absent target
   * matters: by the time this runs, the objects it is undoing may already be
   * gone. Session before window, the same order the death hook uses and for
   * the same measured reason — a member whose bound window dies first falls
   * back to a sibling's, and briefly renders that sibling's pane twice.
   */
  private async rollbackSplit(record: PaneRecord, windowId: string): Promise<void> {
    const entry = this.entries.get(record.id)
    if (entry?.record === record) {
      // `attach` got as far as registering it. Mark the intent before tearing
      // the client down, so the exit this raises is not reported as a crash of
      // a pane the caller has not been given yet.
      entry.intent = 'killed'
      this.entries.delete(record.id)
      entry.session.detach()
    }
    // Best effort, both of them: this runs because something has already
    // failed, and the original error is the one worth propagating. Leaving a
    // window behind is bad; replacing the caller's error with a second one
    // about the cleanup is worse — that is finding 6 on this same branch.
    try {
      await this.adapter.killSession(record.tmuxSession)
    } catch {
      // Nothing further to try.
    }
    try {
      await this.adapter.killWindow(windowId)
    } catch {
      // Nothing further to try.
    }
  }

  get(id: string): PaneRecord | undefined {
    return this.entries.get(id)?.record
  }

  list(): PaneRecord[] {
    return [...this.entries.values()].map((entry) => entry.record)
  }

  write(id: string, data: string): void {
    this.entries.get(id)?.session.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id)
    // Same guard PtySession applies, hoisted so a rejected size is never
    // recorded as the geometry a reattach should use.
    if (!entry || cols < 1 || rows < 1) return
    entry.cols = cols
    entry.rows = rows
    entry.session.resize(cols, rows)
    // Resizing the client is not enough once a tab has been split. `splitTab`
    // puts `window-size manual` on every pane's window, and a manual window
    // ignores its client's size outright — measured: a 200x50 client attached
    // to a manual 100x30 window left it at 100x30. So without this the founder
    // pane freezes at whatever geometry it had when the split happened, and
    // the two halves of one tab behave differently.
    //
    // Detached rather than awaited, because `resize` is called from the
    // renderer's resize path and has always been synchronous. Failures are
    // swallowed for the same reason the death hook's are: a tmux this app
    // cannot talk to is not worth taking the main process down for, and the
    // next resize tries again.
    void this.resizeWindow(entry, cols, rows).catch(() => {})
  }

  /**
   * Push a pane's size onto the tmux window its process lives in.
   *
   * Ordered against itself rather than against the clock: a drag emits resizes
   * faster than tmux answers them, so the size is re-checked against the
   * entry's current one before the call lands. Without that, a slow early
   * resize could arrive last and leave the window at a size the renderer has
   * already moved on from — the same "last writer wins by accident" that the
   * geometry rule exists to remove.
   */
  private async resizeWindow(entry: Entry, cols: number, rows: number): Promise<void> {
    const windowId = entry.windowId ?? (await this.adapter.windowIdOf(entry.record.tmuxSession))
    if (!windowId) return
    entry.windowId = windowId
    if (entry.cols !== cols || entry.rows !== rows) return
    await this.adapter.resizeWindow(windowId, cols, rows)
  }

  /** Detach the client. The tmux session keeps running. */
  detach(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.intent = 'detached'
    this.entries.delete(id)
    entry.session.detach()
  }

  detachAll(): void {
    for (const id of [...this.entries.keys()]) this.detach(id)
  }

  /**
   * Destroy the tmux session and everything running in it. Works whether or
   * not this app is attached — a tab detached earlier is still killable.
   *
   * `killSession` only ever destroys the MEMBER session. For a one-pane tab
   * that has always been enough — the window dies with the last member in
   * its group, and there is no group to leave it in. For a split it is not:
   * the window and the process inside it belong to the group, not to any one
   * member, so killing just the session leaks both, reachable afterwards
   * only through `list-windows`. Resolved before the kill because there is no
   * session left to ask the window of afterwards; killed session-then-window,
   * the same order the death hook uses and for the same reason — a member
   * whose window dies first falls back to a sibling's. `killWindow` already
   * tolerates an already-gone window, which is what covers the one-pane case
   * where the session's own death took the window with it.
   *
   * `windowIdOf`, not `lookupWindow`: this only ever needs a bare id to hand
   * `killWindow`, and every way tmux can decline to give one — session gone,
   * tmux unreachable — comes to the same thing here, nothing left to kill.
   */
  async kill(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry) {
      const windowId = entry.windowId ?? (await this.adapter.windowIdOf(entry.record.tmuxSession))
      entry.intent = 'killed'
      this.entries.delete(id)
      entry.session.detach()
      await this.adapter.killSession(entry.record.tmuxSession)
      if (windowId) await this.adapter.killWindow(windowId)
      return
    }

    const orphan = (await this.findOrphans()).find((record) => record.id === id)
    // Resolving here would report success without killing anything.
    if (!orphan) throw new Error(`kill: no tmux session found for tab ${id}`)
    const windowId = await this.adapter.windowIdOf(orphan.tmuxSession)
    await this.adapter.killSession(orphan.tmuxSession)
    if (windowId) await this.adapter.killWindow(windowId)
  }

  /**
   * Move a tab into another project by renaming its tmux session.
   *
   * The tab id is the second half of the name and does not change, so the
   * session keeps its scrollback and everything running inside it — only the
   * slug moves, and with it which project the tab matches.
   *
   * The rename goes first, before our own client is touched. tmux renames a
   * session out from under an attached client quite happily (the client follows
   * the session, not the name), and it refuses a rename onto a name already in
   * use — leaving the source exactly as it was. Detaching first would turn that
   * refusal into a tab with no client and a live session behind it, recoverable
   * only by relaunching. This way a refused rename changes nothing at all and
   * simply throws. The client is then cycled anyway, which reattaches under the
   * new name and makes tmux redraw the pane into the waiting xterm.
   *
   * `known` carries the tab's real cwd and command when the caller has them on
   * record. A tab whose client has already gone — detached, and still perfectly
   * movable — is found through `findOrphans`, which synthesises a cwd and knows
   * no command, so moving one without this would return $HOME as its directory
   * for the caller to save over the truth. Restore does the same fix-up when it
   * reattaches a saved row over an orphan.
   *
   * The reattach carries the client's geometry forward. Nothing in the renderer
   * changes size across a move — the container's box is identical and the tab
   * stays visible — so no refit follows to correct a default-sized attach, and
   * the pane would simply stay wrapped at 80 columns.
   *
   * The single-pane path through `moveTabToProject`, kept as its own method
   * because most callers only have one pane's `known` to offer and a `Pick`
   * is a plainer thing to pass than a one-entry `Map`.
   */
  async moveToProject(
    id: string,
    projectSlug: string,
    known?: Pick<PaneRecord, 'cwd' | 'command'>,
  ): Promise<PaneRecord> {
    const [moved] = await this.moveTabToProject(
      id,
      projectSlug,
      known && new Map([[id, known]]),
    )
    return moved
  }

  /**
   * Move every pane of a tab into another project, or none of them.
   *
   * A split tab's project membership lives in each member session's own name,
   * so a rename of one pane and not the rest would leave the tab split across
   * two projects — the one outcome this must never produce. tmux refuses a
   * rename onto a name already in use and leaves the source untouched, so a
   * refusal part-way through a naive loop would do exactly that. The fix:
   * rename every member first, and if any rename throws, rename the ones that
   * already succeeded back before rethrowing. Only once every rename has gone
   * through does any client get cycled — same ordering as `moveToProject`,
   * and for the same reason: a client survives a rename out from under it, so
   * touching clients only after every rename has succeeded means a refusal
   * changes nothing at all rather than leaving some panes detached.
   *
   * `panesOfTab`, not `findOrphanTabs`, resolves the tab's members: this is
   * routinely called on a tab this app has open, and `findOrphanTabs`
   * deliberately excludes exactly those panes.
   *
   * `known` carries each pane's real cwd/command, keyed by pane id, for the
   * same reason `moveToProject` takes one — a pane found through
   * `panesOfTab` rather than an open entry has a tmux-synthesised cwd and no
   * command.
   *
   * Each reattach carries that pane's own live geometry forward, same as
   * `moveToProject` — nothing in the renderer changes size across a move, so
   * no refit follows to correct a default-sized attach.
   */
  async moveTabToProject(
    tabId: string,
    projectSlug: string,
    known?: Map<string, Pick<PaneRecord, 'cwd' | 'command'>>,
  ): Promise<PaneRecord[]> {
    const panes = await this.panesOfTab(tabId)
    if (panes.length === 0) throw new Error(`moveTabToProject: no session for tab ${tabId}`)

    const targets = panes.map((pane) => ({
      pane,
      to: encodeSessionName({ projectSlug, id: pane.id }),
    }))

    // Rename every member before any client is touched, and reinstall each
    // one's death hook immediately after ITS OWN rename lands — not once,
    // in bulk, after the whole loop. Undo, in reverse order, whatever
    // succeeded before the failure — that is what keeps a refused rename
    // from leaving the tab split across two projects.
    //
    // The hook bakes the member session's name in as a literal, so a rename
    // makes the hook installed for it stale the instant the rename lands. That
    // is not a cosmetic staleness: a tmux command list ABORTS AT THE FIRST
    // FAILURE, measured —
    //
    //   $ tmux kill-session -t '=prcli-gone-0000000000000000' ';' kill-window -t @1
    //   can't find session: prcli-gone-0000000000000000
    //   windows after: @0 @1        # @1 survived
    //
    // — and `kill-session` comes first in the hook, because spec finding 2
    // requires the member's client to be gone before its window is. So a pane
    // dying while its hook names the old session reports its status correctly
    // (`run-shell` runs first, and the red dot is right) and then reaps
    // NOTHING: the dead pane preserved by `remain-on-exit`, its window and its
    // session both left behind.
    //
    // Reinstalling in a second loop, after every rename has already landed,
    // narrows that gap from "the whole of a move" to only nothing for the
    // last pane renamed — every earlier pane still has a hook naming a
    // session that pane's own rename has already made stop existing, for as
    // long as the rest of the loop takes to run. Reinstalling right here,
    // inside the same iteration as the rename that just made it stale, is
    // what closes that: the gap for any one pane is now only what one more
    // tmux round trip takes, not the whole remainder of the loop.
    //
    // Swallowed for the same reason `attach`'s hook install is: a tab whose
    // death shows grey is not worth failing an otherwise-successful rename
    // over, and the reattach later tries again regardless.
    const renamed: { pane: PaneRecord; from: string; to: string }[] = []
    try {
      for (const { pane, to } of targets) {
        if (to === pane.tmuxSession) continue
        await this.adapter.renameSession(pane.tmuxSession, to)
        renamed.push({ pane, from: pane.tmuxSession, to })
        await this.wireDeathHook({ ...pane, tmuxSession: to }, null).catch(() => {})
      }
    } catch (error) {
      // Every undo is attempted, and one that is refused does not stop the
      // rest. A rename back can genuinely fail — something took the source
      // name in the meantime, tmux is transiently unavailable — and abandoning
      // the loop there would leave the already-moved panes in the destination
      // project: the tab split across two projects, which is the single
      // outcome this method exists to prevent, arrived at silently.
      //
      // Each undone rename gets its hook put back too — a pane renamed back to
      // its old name while its hook still names the new one is the same
      // defect mirrored, and the next thing to touch this session is the
      // caller, not a client cycle that would otherwise paper over it.
      const undoFailures: unknown[] = []
      for (const { pane, from, to } of [...renamed].reverse()) {
        try {
          await this.adapter.renameSession(to, from)
          // `pane.tmuxSession` is already `from` — this is the pane as
          // `panesOfTab` reported it, before any rename touched it — so
          // nothing needs overriding here the way the forward loop overrides
          // `to` above.
          await this.wireDeathHook(pane, null).catch(() => {})
        } catch (undoError) {
          undoFailures.push(undoError)
        }
      }
      // When the undo worked, the caller hears about what actually went
      // wrong. Replacing it with an undo's error — which is what happened
      // before — describes the recovery instead of the cause, and describes
      // it for a tab that is in fact intact.
      if (undoFailures.length === 0) throw error
      // When it did not, that is the more serious condition and has to be
      // said outright rather than inferred from a rename error. The original
      // rides along first, so nothing is lost.
      throw new AggregateError(
        [error, ...undoFailures],
        `moveTabToProject: tab ${tabId} may now be split across projects — ` +
          `${undoFailures.length} of ${renamed.length} renames could not be undone`,
      )
    }

    const moved: PaneRecord[] = []
    for (const { pane, to } of targets) {
      const overrides = known?.get(pane.id)
      const cwd = overrides?.cwd ?? pane.cwd
      const command = overrides?.command ?? pane.command
      // Already there: nothing was renamed, and nothing worth tearing a
      // working client down for.
      if (to === pane.tmuxSession) {
        moved.push({ ...pane, cwd, command })
        continue
      }

      // Read before the detach disposes the entry. A detached pane has none,
      // and no client to take a size from either, so the default is all
      // there is — no worse than today, and the renderer refits it when it
      // is next shown.
      const entry = this.entries.get(pane.id)
      const size = entry ? { cols: entry.cols, rows: entry.rows } : {}
      if (entry) this.detach(pane.id)
      moved.push(
        this.open({
          id: pane.id,
          projectSlug,
          cwd,
          command,
          tmuxSession: to,
          type: pane.type,
          ...size,
        }),
      )
    }
    return moved
  }

  /**
   * prcli-owned tmux sessions with no client in this app — left behind by a
   * previous run or a crash. Callers decide whether to reopen them.
   */
  async findOrphans(): Promise<PaneRecord[]> {
    const open = new Set(this.list().map((record) => record.tmuxSession))
    const names = await this.adapter.listPrcliSessions()
    const orphans: PaneRecord[] = []
    for (const name of names) {
      if (open.has(name)) continue
      const parts = decodeSessionName(name)
      if (!parts) continue
      orphans.push({
        id: parts.id,
        projectSlug: parts.projectSlug,
        // Asked of tmux rather than synthesised. `$HOME` used to stand in here
        // on the reasoning that reattaching does not change a session's own
        // directory — true, but the value is not inert: it is what a restart
        // re-creates the session with, and what a move would save over the
        // truth. Callers that already hold the real cwd still pass it in
        // (`moveToProject`'s `known`, restore's fix-up); this is for the ones
        // that have nothing else, like a session started outside the app.
        //
        // `$HOME` remains the fallback for a pane tmux will not describe: a
        // directory that certainly exists beats a record that cannot be made.
        cwd: (await this.adapter.paneCurrentPath(name)) || process.env.HOME || '/',
        tmuxSession: name,
        // An adopted session's launch intent is not recoverable from its
        // name, and 'shell' is the type that claims least.
        type: 'shell',
      })
    }
    return orphans
  }

  /**
   * Orphaned panes assembled back into the tabs they belong to.
   *
   * Live tmux decides what exists, grouping included: the tab a pane belongs to
   * is its `session_group`, and an empty group means a tab that has never been
   * split. Nothing stored is consulted.
   *
   * The tab id comes from the group name's id half only. Its slug is whatever
   * the founder was called when the group was made and may be several projects
   * out of date — see `tabIdFromGroupName`.
   */
  async findOrphanTabs(): Promise<{ tabId: string; panes: PaneRecord[] }[]> {
    const panes = await this.findOrphans()
    const rows = await this.adapter.listSessionsWithGroups()
    const groupOf = new Map(rows.map((row) => [row.name, row.group]))

    const tabs = new Map<string, PaneRecord[]>()
    for (const pane of panes) {
      const group = groupOf.get(pane.tmuxSession) || pane.tmuxSession
      const tabId = tabIdFromGroupName(group) ?? pane.id
      const existing = tabs.get(tabId)
      if (existing) existing.push(pane)
      else tabs.set(tabId, [pane])
    }
    return [...tabs].map(([tabId, grouped]) => ({ tabId, panes: grouped }))
  }

  /**
   * Every pane of a tab, including ones this app currently holds a client
   * for.
   *
   * `findOrphanTabs` looks like the tool for this and is not: it is built
   * from `findOrphans`, which deliberately excludes any session this app has
   * open, so for a live tab — the ordinary case a move is called on — it
   * returns nothing at all. This instead starts from live tmux and folds in
   * the manager's own open entries, so an open pane's record is its own
   * entry (real cwd, real command) rather than one synthesised from tmux the
   * way an orphan's is.
   *
   * Each pane's `projectSlug` comes from decoding that pane's OWN session
   * name, never the group's: a group name is frozen at group-creation time
   * and does not follow a rename (see `tabIdFromGroupName`), so reading a
   * slug off it would report a moved pane under its old project.
   *
   * The founder — the pane whose own id is `tabId` — comes first in the
   * returned array when it is still alive, and every other member follows in
   * whatever order tmux gave them. `list-sessions` (and so
   * `listSessionsWithGroups`) orders sessions alphabetically by name, not by
   * creation order (measured: a session named `aaa-*` sorts before one named
   * `zzz-*` regardless of which was created first), and a pane's name carries
   * a random hex id — so leaving tmux's order in place would make
   * founder-vs-sibling position a coin flip on every call. `moveTabToProject`
   * renames in this order; its rollback undoes whatever succeeded regardless
   * of position, so nothing downstream of this depends on it today, but a
   * caller has no way to name "the founder's pane" out of the result at all
   * without a fixed position to look at, so this fixes one.
   *
   * A tab can outlive its founder, and then there is no such position: see
   * the fallback below.
   */
  async panesOfTab(tabId: string): Promise<PaneRecord[]> {
    const rows = await this.adapter.listSessionsWithGroups()
    const founder = rows.find((row) => decodeSessionName(row.name)?.id === tabId)

    // An empty group means a tab that has never been split — just the
    // founder's own row. A non-empty one is shared by every member,
    // including the founder itself (see `groupNameOf`) — filtered back out
    // here so it can be put first explicitly instead of wherever tmux's
    // alphabetical order happens to put it.
    let members: { name: string; group: string }[]
    if (founder) {
      members = founder.group
        ? [founder, ...rows.filter((row) => row.group === founder.group && row !== founder)]
        : [founder]
    } else {
      // No session's OWN id is the tab id, and the tab may still exist: a
      // group outlives its founder (measured — the group name and its windows
      // survive, only `group_size` drops), which is precisely the case this
      // milestone is built around, a founder pane crashed with its sibling
      // still running.
      //
      // `findOrphanTabs` handles it already because it takes the tab id from
      // the frozen group name. Reading nothing but that same id here is what
      // stops the two tab-resolution paths disagreeing about whether a tab
      // exists — the disagreement cost `moveTabToProject` a "no session for
      // tab" throw and left such a tab stuck in its project for as long as it
      // lived. The group name's SLUG is still never read; it is several
      // renames out of date by definition.
      const group = rows.find((row) => tabIdFromGroupName(row.group) === tabId)?.group
      if (!group) return []
      // Nothing to put first: the pane whose id names this tab has gone, so
      // the order is tmux's and no caller may read a founder out of it.
      members = rows.filter((row) => row.group === group)
    }

    const panes: PaneRecord[] = []
    for (const row of members) {
      const parts = decodeSessionName(row.name)
      if (!parts) continue
      const open = this.entries.get(parts.id)
      if (open) {
        // `id`, `projectSlug` and `tmuxSession` come from `row.name` — the
        // name tmux has right now — not from the cached entry, which can be
        // one rename behind: `moveTabToProject` renames every member before
        // it cycles any client, so a caller asking mid-move, or after a
        // rollback, would otherwise be told the pre-rename name even though
        // tmux itself already disagrees. `cwd`/`command`/`type` still come
        // from the entry: tmux does not remember a command at all, and a
        // shell's current directory can have moved on from where it opened.
        panes.push({ ...open.record, id: parts.id, projectSlug: parts.projectSlug, tmuxSession: row.name })
        continue
      }
      panes.push({
        id: parts.id,
        projectSlug: parts.projectSlug,
        cwd: (await this.adapter.paneCurrentPath(row.name)) || process.env.HOME || '/',
        tmuxSession: row.name,
        type: 'shell',
      })
    }
    return panes
  }

  onData(listener: (id: string, data: string) => void): void {
    this.dataListeners.add(listener)
  }

  /** Whether the tmux session behind a tab is still running. */
  async hasSession(tmuxSession: string): Promise<boolean> {
    return this.adapter.hasSession(tmuxSession)
  }

  onExit(listener: (record: PaneRecord, code: number, reason: ExitReason) => void): void {
    this.exitListeners.add(listener)
  }
}
