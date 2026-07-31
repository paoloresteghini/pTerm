import type { TmuxAdapter } from '../tmux/adapter'
import { PtySession } from '../pty/session'
import { deathHookCommand } from '../pty/deathHook'
import { decodeSessionName, encodeSessionName, newSessionId } from '../tmux/names'
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

    const entry: Entry = { record, session, cols, rows }

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
      // talk to at all — and the cost of that is a tab whose death shows grey
      // instead of red, which is not worth taking the main process down for.
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
   */
  private async wireDeathHook(record: PaneRecord, windowId: string | null): Promise<void> {
    const reporter = this.options.deathReporter
    if (!reporter) return

    const window = windowId ?? (await this.awaitWindowId(record.tmuxSession))
    // Nothing to hook and nothing to leak: a session tmux will not name has
    // gone, taking its window with it.
    if (!window) return

    const command = deathHookCommand({
      reporter,
      tabId: record.id,
      tmuxSession: record.tmuxSession,
      windowId: window,
    })
    // The two go on together or not at all: `remain-on-exit` with no hook to
    // reap turns every ordinary `exit` into a window nothing removes. So the
    // command is built BEFORE the option is set, and a refused one leaves the
    // window exactly as tmux made it — the cost is a red dot, never a stray.
    if (!command) return

    // Split path only. `open()`'s window already carries this, chained into
    // the command that created it. Window-scoped either way, so a sibling
    // pane's window is untouched — measured: it reads the option unset.
    if (windowId) await this.adapter.setWindowOption(windowId, 'remain-on-exit', 'on')

    await this.adapter.setDeathHook(window, command)
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
    const tmuxSession = encodeSessionName({
      projectSlug: sibling.record.projectSlug,
      id,
    })

    // Sizing is explicit rather than left to `window-size latest`, which fixes
    // a window's size when a client BEGINS viewing it and did not re-size on a
    // later select-window.
    //
    // Set on each member by name, never once on the group: two probes disagreed
    // about whether this option propagates between members, and a setting that
    // happens to propagate is not a setting that was made. The group name is
    // also not a valid option target once the founder has gone.
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
    await this.adapter.setSessionOption(sibling.record.tmuxSession, 'window-size', 'manual')
    if (founderWindow) {
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
    await this.adapter.newGroupMember(group, tmuxSession, { PRCLI_TAB_ID: id })
    await this.adapter.setSessionOption(tmuxSession, 'window-size', 'manual')
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

    return this.attach(record, {
      cols: input.cols ?? DEFAULT_COLS,
      rows: input.rows ?? DEFAULT_ROWS,
      windowId: window.id,
    })
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
   */
  async moveToProject(
    id: string,
    projectSlug: string,
    known?: Pick<PaneRecord, 'cwd' | 'command'>,
  ): Promise<PaneRecord> {
    const entry = this.entries.get(id)
    const current = entry?.record ?? (await this.findOrphans()).find((row) => row.id === id)
    if (!current) throw new Error(`moveToProject: no session for tab ${id}`)

    const cwd = known?.cwd ?? current.cwd
    const command = known?.command ?? current.command
    const tmuxSession = encodeSessionName({ projectSlug, id })
    // Already there: nothing to rename, and nothing worth tearing a working
    // client down for.
    if (tmuxSession === current.tmuxSession) return { ...current, cwd, command }

    // Read before the detach disposes the entry. A detached tab has none, and
    // no client to take a size from either, so the default is all there is —
    // no worse than today, and the renderer refits it when it is next shown.
    const size = entry ? { cols: entry.cols, rows: entry.rows } : {}
    await this.adapter.renameSession(current.tmuxSession, tmuxSession)
    if (entry) this.detach(id)
    return this.open({
      id,
      projectSlug,
      cwd,
      command,
      tmuxSession,
      type: current.type,
      ...size,
    })
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
