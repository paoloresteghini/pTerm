import type { TmuxAdapter } from '../tmux/adapter'
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
 * retry of something that failed: `windowIdOf` answers '' for a session tmux
 * has never heard of, and `PtySession.start()` returns before the client it
 * spawned has created one.
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
    return record
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

    const window = windowId ?? (await this.awaitWindowId(record.tmuxSession))
    if (!window) {
      // This is NOT proof the session has gone. `windowIdOf` swallows every
      // failure and answers '' for all of them, so a session tmux has never
      // heard of and a tmux that would not answer are indistinguishable here.
      //
      // It is also the one path this function cannot repair, because taking a
      // window option off requires naming a window and tmux has just declined
      // to name one. If the session really has gone there is nothing to leak;
      // if it has not, the pane is left preserved on exit with nothing to reap
      // it, and only the next restore's reconcile will notice. Recorded rather
      // than asserted away — the alternative would be a second target form for
      // the same option, guessing at the window through the session, which is
      // the mistake `window-size` already made once on this branch.
      return
    }

    const command = deathHookCommand({
      reporter,
      tabId: record.id,
      tmuxSession: record.tmuxSession,
      windowId: window,
    })
    if (!command) {
      // Refused, so no hook is coming. Unreachable while `windowIdOf` answers
      // tmux's own `@<n>` — `PtySession` asks `canBuildDeathHook`, which tests
      // everything this does bar the window id — but the rule is held here
      // rather than inferred from that.
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
   * `windowIdOf` answers '' for a session tmux has never heard of. Asking once
   * would leave most tabs with no hook at all.
   */
  private async awaitWindowId(tmuxSession: string): Promise<string> {
    const deadline = Date.now() + WINDOW_ID_TIMEOUT_MS
    for (;;) {
      const windowId = await this.adapter.windowIdOf(tmuxSession)
      if (windowId) return windowId
      if (Date.now() >= deadline) return ''
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
    const window = await this.adapter.newWindow({
      member: sibling.record.tmuxSession,
      cwd,
      env: { PRCLI_TAB_ID: id },
    })
    // The env also goes here, not only on `newWindow`: `-e` on `new-window`
    // reaches the spawned pane's own process (confirmed: a child inside it
    // sees it) but never the session's environment table — `show-environment`
    // on the new member reports nothing. `-e` on `new-session -t <group>`
    // does reach that table, which is where a reattach and any `show-environment`
    // caller both go looking, so both calls carry it.
    // The new pane's own window gets the same treatment, by window id, and
    // before any client has attached to it — so there is no ordering here that
    // has to hold for the geometry rule to be in force. Without the explicit
    // resize, `manual` would revert this window to the size tmux recorded when
    // `newWindow` made it, which is the founder's, not this pane's.
    await this.adapter.setWindowOption(window.id, 'window-size', 'manual')
    await this.adapter.resizeWindow(window.id, cols, rows)
    await this.adapter.newGroupMember(group, tmuxSession, { PRCLI_TAB_ID: id })
    // By index, with the member named. See the adapter method's comment.
    await this.adapter.selectWindow(tmuxSession, window.index)

    const record: PaneRecord = {
      id,
      projectSlug: sibling.record.projectSlug,
      cwd,
      command: input.command,
      tmuxSession,
      type: input.type ?? 'shell',
    }

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
    if (input.command) {
      await this.adapter.respawnPane(window.id, {
        command: input.command,
        cwd,
        env: { PRCLI_TAB_ID: id },
      })
    }

    return this.attach(record, { cols, rows, windowId: window.id })
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
   */
  async kill(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry) {
      entry.intent = 'killed'
      this.entries.delete(id)
      entry.session.detach()
      await this.adapter.killSession(entry.record.tmuxSession)
      return
    }

    const orphan = (await this.findOrphans()).find((record) => record.id === id)
    // Resolving here would report success without killing anything.
    if (!orphan) throw new Error(`kill: no tmux session found for tab ${id}`)
    await this.adapter.killSession(orphan.tmuxSession)
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

    // Rename every member before any client is touched. Undo, in reverse
    // order, whatever succeeded before the failure — that is what keeps a
    // refused rename from leaving the tab split across two projects.
    const renamed: { from: string; to: string }[] = []
    try {
      for (const { pane, to } of targets) {
        if (to === pane.tmuxSession) continue
        await this.adapter.renameSession(pane.tmuxSession, to)
        renamed.push({ from: pane.tmuxSession, to })
      }
    } catch (error) {
      for (const { from, to } of renamed.reverse()) {
        await this.adapter.renameSession(to, from)
      }
      throw error
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
   * The founder — the pane whose own id is `tabId` — always comes first in
   * the returned array, and every other member follows in whatever order
   * tmux gave them. `list-sessions` (and so `listSessionsWithGroups`) orders
   * sessions alphabetically by name, not by creation order (measured: a
   * session named `aaa-*` sorts before one named `zzz-*` regardless of which
   * was created first), and a pane's name carries a random hex id — so
   * leaving tmux's order in place would make founder-vs-sibling position a
   * coin flip on every call. `moveTabToProject` renames in this order; its
   * rollback undoes whatever succeeded regardless of position, so nothing
   * downstream of this depends on it today, but a caller has no way to name
   * "the founder's pane" out of the result at all without a fixed position
   * to look at, so this fixes one.
   */
  async panesOfTab(tabId: string): Promise<PaneRecord[]> {
    const rows = await this.adapter.listSessionsWithGroups()
    const founder = rows.find((row) => decodeSessionName(row.name)?.id === tabId)
    if (!founder) return []

    // An empty group means a tab that has never been split — just the
    // founder's own row. A non-empty one is shared by every member,
    // including the founder itself (see `groupNameOf`) — filtered back out
    // here so it can be put first explicitly instead of wherever tmux's
    // alphabetical order happens to put it.
    const members = founder.group
      ? [founder, ...rows.filter((row) => row.group === founder.group && row !== founder)]
      : [founder]

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
