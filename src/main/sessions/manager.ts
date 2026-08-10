import type { TmuxAdapter, WindowLookup } from '../tmux/adapter'
import { PtySession } from '../pty/session'
import { deathHookCommand } from '../pty/deathHook'
import { decodeSessionName, encodeSessionName, newSessionId, tabIdFromGroupName } from '../tmux/names'
// Declared with the other wire types: the renderer needs to tell a
// deliberate `killed` apart from a genuine exit too (see `ExitEvent.reason`
// in shared/ipc.ts), so a second, main-only definition here would only
// invite drift. Re-exported so existing importers keep working unchanged.
import type { DiffSide, ExitReason, TabType } from '../../shared/ipc'
import type { PaneColor } from '../../shared/paneColors'

export type { ExitReason }

export interface PaneRecord {
  id: string
  projectSlug: string
  cwd: string
  command?: string
  /**
   * Absent on an editor pane, which has no tmux session at all. Present on
   * every terminal pane, which is what `isPane` still enforces per kind.
   */
  tmuxSession?: string
  type: TabType
  /**
   * What the user called this pane, absent until they name one.
   *
   * Display text only. It is on this record because config is where it is
   * persisted, and nothing in this file reads it: a pane's tmux session is
   * named `pterm-${slug}-${id}` and restore matches saved rows against live
   * sessions by that name, so a title has no more to do with tmux than a
   * window's colour does.
   */
  title?: string
  /**
   * The pane's background, one of `PANE_COLORS`, absent until they pick one.
   *
   * Display only, and here for the same reason `title` is: config persists it
   * and nothing in this file reads it. The sentence above turns out to have
   * been literal.
   */
  color?: PaneColor
  /**
   * The file an editor or diff pane is showing, absolute. Absent on every
   * terminal pane, and absent on an editor pane whose file could not be read.
   *
   * Display data only, same as `title` and `color`: nothing in this file
   * reads it, since this file deals in tmux and an editor pane has none.
   */
  filePath?: string
  /**
   * Which side of the index a `diff` pane is showing. Absent on every other
   * kind, and on a `diff` row that predates the field, where the working tree
   * is the sensible reading.
   */
  diffSide?: DiffSide
  /**
   * The repo-relative path a `diff` pane's `gitDiff` calls need. See the
   * field of the same name on `TabDescriptor` in `shared/ipc.ts` for why it
   * exists alongside `filePath` rather than being re-derived from it.
   */
  diffRelPath?: string
}

/**
 * A pane `SessionManager` owns. Always a terminal, so always has a session:
 * an editor pane has none and never enters this file. Every record this
 * class constructs, reattaches or reports is one of these; the wider
 * `PaneRecord` is what a pane looks like once config and an editor pane are
 * both in the picture, neither of which this file deals in.
 */
export interface TerminalPaneRecord extends PaneRecord {
  tmuxSession: string
}

export interface OpenInput {
  projectSlug: string
  cwd: string
  command?: string
  /** Supply to reattach an existing tab; omit to create a new one. */
  id?: string
  /**
   * The tab this pane belongs to — the tab's permanent id, which equals the
   * pane's own id only for a one-pane tab and for the founder of a split.
   *
   * Not the tmux group's id, and the difference only shows once a tab whose
   * panes all died has re-founded under a new group: the tab keeps this id and
   * the group has another. `groupIdOf` answers the other question.
   *
   * Omitted means "this pane founds its own tab", which is what the renderer's
   * `CHANNELS.open` always is. Every other caller opens a pane into a tab that
   * already exists and must say which: `restoreWorkspace` adopting a member of
   * a live group, and `moveTabToProject` reopening a pane it detached. Getting
   * it wrong is invisible until that pane dies and is restarted, at which
   * point it comes back outside its tab (finding I4).
   *
   * Not read by tmux and not persisted: it is what the manager remembers for
   * this pane, so a restart after its death can find the group again. See
   * `Entry.tabId` and `tabWasIn`.
   */
  tabId?: string
  /** Saved tmux name, checked against the one this input encodes to. */
  tmuxSession?: string
  cols?: number
  rows?: number
  type?: TabType
}

interface Entry {
  record: TerminalPaneRecord
  session: PtySession
  /**
   * The tab this pane is in, decided by whoever created the pane and never
   * asked of tmux afterwards.
   *
   * Held on the entry so it can outlive it: `session.onExit` copies it into
   * `tabWasIn` on the way out, and a dead pane has no other source for it —
   * its membership lived in its tmux session's group and the death hook kills
   * that session; `register.ts`'s `forgetTab` deletes its config row; and
   * `store.read()`'s `normaliseLayout` then drops it from the tab row's kids.
   *
   * Written once, at creation, and there is no setter — which is an obligation
   * on anything added later, not a property of the field. Every producer today
   * sets it from the tab the pane is in **at the moment the entry is made**,
   * which is why the two cannot disagree, and each gets there differently:
   * `CHANNELS.open` founds a tab, so the pane's own id is the answer;
   * `splitTab` copies the sibling's, which is the tab they will share;
   * `restoreWorkspace` reads live tmux (`restore.ts:261-267`) — usually a run
   * later than the pane joined that tab, so the entry is new and the
   * membership is not — under the tab's own id, not the group's, which is what
   * keeps a re-founded tab's panes agreeing about which tab they are in; and
   * `moveTabToProject` does not change tab membership
   * at all — it carries the old entry's value onto the one it makes, or, for a
   * pane already under the target name, makes no new entry (`continue`) and
   * leaves the old one standing. **An operation that moves a pane between
   * tabs without recreating its entry — an unsplit, a drag of a pane into
   * another tab — must write this field too.** Leaving it is invisible: nothing reads it
   * while the pane lives, so the tab bar, the layout and tmux all stay
   * correct, and the stale value first has an effect when that pane dies and
   * is restarted, at which point it silently rejoins the tab it used to be in.
   * That is the failure this whole field exists to remove, reintroduced from
   * inside.
   */
  tabId: string
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
   * Set once `ownsWindow` has said this pane may NOT write to the window tmux
   * reports for it — the fallen-back state, where its own window has died and
   * the id it reports is a sibling's.
   *
   * The negative has to be cached as well as the positive, and for the same
   * reason: `windowId` is only ever filled in with a window this pane is
   * entitled to, so without this a denied pane re-asks on every call and a
   * drag puts a `list-sessions` plus one `windowIdOf` per sibling between
   * every frame — the subprocess storm M3 exists to remove, in the one case
   * where nothing will ever come of it. Permanent for the entry's lifetime,
   * which is correct: the window this pane owned is gone and does not come
   * back, and a detach or a move disposes the entry.
   */
  windowDenied?: boolean
  /**
   * Set before we deliberately tear a client down, so the PTY's exit callback
   * can tell a detach or a kill apart from the child genuinely exiting.
   */
  intent?: 'detached' | 'killed'
  /**
   * Set when this entry is disposed, so a window lookup still polling for it
   * stops at its next answer instead of running out its ten-second deadline
   * against a session nothing is waiting for any more. See `awaitWindowId`.
   */
  abandoned?: boolean
  /**
   * Whether a `resize-window` for this pane is already in flight, and whether
   * a newer size arrived while it was.
   *
   * A drag emits sizes faster than tmux answers them. Spawning one `execFile`
   * per frame is the subprocess storm this milestone has now met twice; the
   * loop below sends the CURRENT size once the in-flight call settles, so at
   * most one tmux process exists per pane at a time and the last frame is
   * always the one that lands.
   */
  resizing?: boolean
  resizeDirty?: boolean
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
  /**
   * Which tab each pane that has DIED was in. `reopenInTab` is its only
   * reader; `session.onExit` its only writer.
   *
   * This is main owning a fact rather than asking for it. The renderer is the
   * only other holder — it still draws the dead pane inside its tab — but a
   * request field for it cannot be made safe: the cheapest thing in scope at
   * every call site is the pane's own id, which type-checks, is right for a
   * one-pane tab and for a split's founder, and is wrong for every other pane
   * of a split. Arriving here it is indistinguishable from a legitimate
   * one-pane restart, so no check could catch it.
   *
   * A process-lifetime map covers exactly the interval in which a restart can
   * be asked for: the affordance is a renderer-side tombstone, and a relaunch
   * produces none — restore rebuilds from live tmux, which has nothing to say
   * about a pane that is gone. That is the same lifetime contract
   * `register.ts`'s `lastGeometry` has, down to being dropped by the same two
   * handlers; see `forgetPane`.
   */
  private readonly tabWasIn = new Map<string, string>()
  private readonly dataListeners = new Set<(id: string, data: string) => void>()
  private readonly exitListeners = new Set<
    (record: TerminalPaneRecord, code: number, reason: ExitReason) => void
  >()

  constructor(
    private readonly adapter: TmuxAdapter,
    private readonly options: { deathReporter?: string } = {},
  ) {}

  open(input: OpenInput): TerminalPaneRecord {
    const record = this.recordFor(input)
    return this.attach(record, {
      ...this.geometryOf(input),
      // The pane's own id when the caller says nothing, because that is what a
      // new tab is: a group of one, whose founder's id IS the tab's. A caller
      // putting a pane into a tab that already exists says so — see
      // `OpenInput.tabId`.
      tabId: input.tabId ?? record.id,
    })
  }

  /**
   * Drop what a restart of this pane would have used to find its tab again.
   *
   * Called from where `register.ts` drops `lastGeometry`, and for the same
   * reason: a kill and a dismissal are the two ways a dead pane stops being
   * restartable at all. Nothing is recorded for a pane killed while it was
   * still open — `kill()` disposes the entry before the client goes, so the
   * exit that follows records nothing (see `attach`) — so what this is for is
   * the other order: a pane that died, was tombstoned, and is then dismissed
   * or killed from the tab bar.
   */
  forgetPane(id: string): void {
    this.tabWasIn.delete(id)
  }

  /**
   * The tab a LIVE pane is in, or undefined when this manager has no entry.
   *
   * `tabWasIn`'s counterpart for a pane that has not died yet: it reads
   * `Entry.tabId`, the value whoever created the pane decided, rather than
   * asking tmux. `register.ts` needs it twice — to name the row it writes for a
   * pane it has just split, and to find the row of a pane it is about to kill,
   * the latter necessarily BEFORE `kill()` disposes the entry.
   *
   * Deliberately not `tabIdFromGroupName(await groupNameOf(id))`. That is a
   * second derivation of the same fact and the two can disagree: a group name
   * goes out of date after a move (see `tabIdFromGroupName`), and it is what
   * `splitTab` already reduced to this field. A caller writing a tab row under
   * an id nothing else matches loses the tab's layout at the next restore.
   */
  tabIdOf(paneId: string): string | undefined {
    return this.entries.get(paneId)?.tabId
  }

  /**
   * The record a pane is opened under, with the two inputs that make one
   * unusable refused before anything is created.
   *
   * Split out of `open()` so `reopenInTab()` can name the same session and
   * apply the same guards while choosing a different way to create it, rather
   * than keeping a second copy of them. Synchronous, and called before either
   * caller's first `await`, so "already open" is still refused before anything
   * can race it.
   */
  private recordFor(input: OpenInput): TerminalPaneRecord {
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

    return {
      id,
      projectSlug: input.projectSlug,
      cwd: input.cwd,
      command: input.command,
      tmuxSession,
      type: input.type ?? 'shell',
    }
  }

  /**
   * The size to spawn a client at, and whether the caller actually knows it.
   *
   * `sized` is whether the caller supplied this pane's geometry, or whether
   * this invented it. The client has to be spawned at some size either way,
   * and 80x24 is what a tmux client defaults to — but a WINDOW must never be
   * driven to a size nobody measured. Both, not either: a caller supplying one
   * and not the other is supplying a default for the other half, and half a
   * measurement is not one.
   */
  private geometryOf(input: OpenInput): { cols: number; rows: number; sized: boolean } {
    return {
      cols: input.cols ?? DEFAULT_COLS,
      rows: input.rows ?? DEFAULT_ROWS,
      sized: input.cols !== undefined && input.rows !== undefined,
    }
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
   *
   * `tabId` is decided by each caller too, and is the one thing here that is
   * not recoverable later: see `Entry.tabId`.
   */
  private attach(
    record: TerminalPaneRecord,
    {
      cols,
      rows,
      windowId,
      sized,
      tabId,
    }: { cols: number; rows: number; windowId?: string; sized: boolean; tabId: string },
  ): TerminalPaneRecord {
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
      env: { PTERM_TAB_ID: id },
      // The reporter is reached by absolute path rather than through the
      // session's environment: tmux runs a hook's command with the server's
      // environment, not the session's, so `$PTERM_TAB_ID` is not set there —
      // which is why the id is baked into the command instead of read from it.
      deathReporter: this.options.deathReporter,
      tabId: id,
      windowId,
    })

    const entry: Entry = { record, session, cols, rows, windowId, tabId }

    session.onData((data) => {
      for (const listener of this.dataListeners) listener(id, data)
    })
    session.onExit((code) => {
      // Compare identity, not just the id: a detached tab can be reopened
      // before its old client's exit lands, and that late event must not
      // evict the new entry.
      if (this.entries.get(id) === entry) {
        this.entries.delete(id)
        // Copied out before the entry is unreachable, and only from the entry
        // that is still the live one — a late exit from a superseded entry
        // must not overwrite what its replacement recorded.
        //
        // A deliberate `detach()`, `kill()` or `rollbackSplit()` never gets
        // here: all three delete the entry BEFORE tearing the client down, so
        // this branch is exactly the pane that died on its own, which is
        // exactly the pane a restart can be asked for. See `tabWasIn`.
        this.tabWasIn.set(id, entry.tabId)
      }
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
    //
    // One lookup for both of the things that want it, and only if something
    // does. Before this branch the poll ran only when a death reporter was
    // set; Task 5 gave it a second, ungated caller, so an ordinary attach
    // could have two independent polls of the same session in flight — and a
    // poll whose session never appears costs ~370 `tmux display-message`
    // spawns before it gives up. Memoised rather than started eagerly so a
    // manager with no reporter and an unsized attach starts none at all.
    let pending: Promise<WindowLookup> | undefined
    const find = (): Promise<WindowLookup> =>
      (pending ??= this.awaitWindowId(record.tmuxSession, entry))
    const window: WindowLookup | (() => Promise<WindowLookup>) = windowId
      ? { kind: 'found', id: windowId }
      : find

    if (!windowId) {
      // Swallowed deliberately. Everything expected is already tolerated
      // inside the adapter, so what reaches here is a tmux this app cannot
      // talk to at all, and that is not worth taking the main process down
      // for. The cost is a tab whose death shows grey instead of red —
      // `wireDeathHook` has already taken `remain-on-exit` back off by the
      // time anything reaches here, on every path where it can name the
      // window, so it is not also a stray session.
      void this.wireDeathHook(record, window).catch(() => {})
    }
    // Every attach that was GIVEN a size sizes the window its client is about
    // to see — not only a founder's, and not gated on `options.deathReporter`
    // the way the hook above is (a manager built without one still owes its
    // client the right size).
    //
    // Gated on `sized`, though, and that gate is the whole of finding I1. An
    // attach with no size of its own spawns its client at 80x24 because a
    // client needs some size; driving the WINDOW there as well takes a pane
    // that was 120x40 and re-wraps a `claude` session's scrollback
    // permanently.
    //
    // Three callers arrive unsized, not one. Restore is the one the gate was
    // written for: nothing persists a per-pane `cols`/`rows` (neither
    // `PaneRecord` nor `TabRow` has them), so it reattaches every pane at the
    // default and the renderer fits it afterwards. The renderer's own
    // `CHANNELS.open` is a second — `App.tsx` sends `projectSlug`, `cwd`,
    // `command` and `type` and no geometry — and `moveTabToProject`'s
    // detached branch is a third. The behaviour is right for all three: a
    // window `new-session` has just made is on `window-size latest` and
    // follows its client until the renderer's first `resize()`, so nothing is
    // owed at attach time; only restore is attaching to a window that already
    // existed at a size it must not disturb.
    //
    // Measured on this branch before the gate went in: a tab opened 120x40 and
    // split at 100x30 came back from a v5 file as 80x24 and 80x24, and the
    // restore test that guards it is RED on exactly that pair once it settles
    // before asserting. Leaving such a window alone is what it inherited
    // before Task 5 and is what the spec's "no pane wrapped at 80 columns"
    // requires; persisting the real size is 2b's, and would let this gate go.
    //
    // `resize-window` flips a window straight to `window-size manual`
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
    if (sized) void this.sizeWindowOnAttach(entry, window, cols, rows).catch(() => {})
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
    window: WindowLookup | (() => Promise<WindowLookup>),
    cols: number,
    rows: number,
  ): Promise<void> {
    const own = typeof window !== 'function'
    const lookup: WindowLookup = own ? window : await window()
    if (lookup.kind !== 'found') return
    // A window this member only appears to be in is not one to resize — and
    // not one to cache on the entry either, since `kill()` and every later
    // `resize()` would then take the cached id for this pane's own. A split
    // pane's window is `window-size manual`, so the sibling would simply stay
    // at whatever size this pane's client happens to be.
    //
    // Not asked on the split path: that window was made for this pane, by
    // this manager, moments ago — there is nobody it could belong to instead.
    if (!own && !(await this.ownsWindow(entry.record.tmuxSession, lookup.id))) {
      // Remembered, so the renderer's first `resize()` does not ask the same
      // question again — and every frame of the drag after it. See `Entry`.
      entry.windowDenied = true
      return
    }
    entry.windowId = lookup.id
    await this.resizeWindow(entry, cols, rows)
  }

  /**
   * Put the `pane-died` hook on the window a pane lives in, so its death reaps
   * that window and its own member session and nothing else.
   *
   * `window` is a lookup to *run* for `open()`, which has to wait for tmux to
   * make the window before it can name it, and a window already *found* for
   * `splitTab()`, which made the window itself and knows it before anything is
   * running in it. A function rather than a promise so nothing is asked of
   * tmux when there is no reporter and no hook to install; on the `open()`
   * path it is the same memoised lookup `sizeWindowOnAttach` calls, so the two
   * share one poll rather than racing two.
   *
   * That difference is also why `remain-on-exit` is set in two different places:
   * `open()`'s is chained into `new-session` because a fast command would
   * otherwise be reaped before a second tmux call could land, while a split's
   * window is empty until this has finished with it.
   *
   * That asymmetry is what makes every early return below load-bearing. On the
   * split path a hook that does not go on leaves the window as tmux made it,
   * and nothing is owed. On the `open()` path the option is ALREADY ON before
   * this function runs, so an early return that simply leaves it there breaks
   * the together-or-not-at-all rule — every ordinary `exit` preserved as a
   * dead pane in a window and a session nothing reaps, which the next restore
   * then adopts as a live tab.
   *
   * So each early return below has to account for the option, and each one
   * does — but not all of them by turning it off, and the differences are the
   * point. `gone` and `unreachable` have no window to turn it off ON. The
   * `!command` return and the `setDeathHook` catch do call
   * `disableRemainOnExit`. The fallen-back return does NOT, deliberately and
   * uniquely: the option on that window is the SIBLING's, paired with the
   * sibling's hook, and taking it off would cost the sibling the very reaping
   * the rule exists to guarantee. Read that return's own comment before
   * changing it; it is the exception, not an oversight.
   */
  private async wireDeathHook(
    record: TerminalPaneRecord,
    where: WindowLookup | (() => Promise<WindowLookup>),
  ): Promise<void> {
    const reporter = this.options.deathReporter
    if (!reporter) return

    // A window handed in was made for this pane by `splitTab`; one that has to
    // be looked up is whatever tmux currently says, which is not the same
    // thing (see `ownsWindow`).
    const ours = typeof where !== 'function'
    const lookup: WindowLookup = ours ? where : await where()

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
        `pTerm: tmux was unreachable while wiring the death hook for ${record.tmuxSession}; ` +
          'this pane will show grey instead of red when it exits',
      )
      return
    }

    const window = lookup.id

    // A window this member has only fallen back onto belongs to a sibling,
    // whose own hook is already on it — naming the sibling's tab id and
    // reaping the sibling's session. Overwriting it sends the red dot to the
    // wrong pane and reaps the wrong session, leaving this window's real
    // owner behind as a stray.
    //
    // Nothing is taken back off on this path, deliberately, and it is the one
    // early return here that does not: `remain-on-exit` on this window is the
    // SIBLING's — set for the sibling's pane, and paired with the sibling's
    // hook. Turning it off to satisfy the together-or-not-at-all rule would
    // break that pairing and cost the sibling the very reaping the rule
    // exists to guarantee. This member has no window of its own, so it has
    // nothing of its own left here to leak.
    if (!ours && !(await this.ownsWindow(record.tmuxSession, window))) {
      console.error(
        `pTerm: ${record.tmuxSession} reports window ${window}, which a sibling pane of the ` +
          'same tab already owns — its own window has died. Leaving that window alone; ' +
          'this pane will show grey instead of red when it exits',
      )
      return
    }

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
    if (ours) await this.adapter.setWindowOption(window, 'remain-on-exit', 'on')

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
   * Whether `tmuxSession` is the member entitled to write to `windowId` — the
   * window it has just reported as its own.
   *
   * `display-message -t '=member:' '#{window_id}'` answers "the window this
   * session is currently showing", which is not the same question as "the
   * window this pane's process is in". When a member's OWN window dies, tmux
   * silently falls it back onto a sibling's (measured, in both directions) and
   * its session survives — so for exactly that member the answer names its
   * sibling's window and its sibling's process. `restoreWorkspace` was taught
   * to detect this state on this branch; everything here — the death hook, the
   * attach-time resize, the kill — trusted the lookup, and each one wrote to
   * the sibling's window because of it.
   *
   * The tie is broken the same way `withoutSharedWindows` breaks it, and must
   * stay that way: the FOUNDER wins, the pane whose own id is the tab's, which
   * is the direction pre-flight measured (a joined member falling back onto the
   * founder's window). Which member truly owns a shared window is not
   * recoverable from tmux, so a rule that answered "neither" would leave the
   * founder unable to size or reap its own window; one that answered "both"
   * would restore the clobbering this exists to stop. When the founder itself
   * has gone — a group outlives it — the first claimant in tmux's own order
   * takes it, so the answer is at least stable across calls.
   *
   * One `list-sessions` for a tab that has never been split, which is the
   * ordinary case: an ungrouped session has no sibling that could shadow it and
   * returns before asking tmux anything else.
   *
   * **Fails open.** `listSessionsWithGroups` returns `[]` only for "no server"
   * and rethrows everything else — a failed `spawn` under load, most
   * realistically, which this branch already measured happening at 111 tmux
   * spawns in three seconds from one abandoned poll. A throw escaping here
   * would not be an unanswered question, it would be a broken caller: in
   * `wireDeathHook` it escapes PAST `disableRemainOnExit` and leaves
   * `remain-on-exit` on with no hook, and in `kill()` it runs before
   * `killSession` and leaves a live session still listed as a tab. So the
   * question is answered rather than propagated, and it is answered `true`.
   *
   * `true` rather than `false` for two reasons, and they point the same way.
   * The likelihood: a pane that has fallen back onto a sibling's window is
   * rare (it needs its own window to have died without its hook running),
   * while a tmux hiccup is uncorrelated with that and can land on any attach,
   * so "yes, this pane owns its window" is simply the far likelier answer.
   * And the cost: `true` degrades to exactly the pre-branch behaviour for one
   * call — this pane writes to the window tmux named, which is its own unless
   * it is that rare fallen-back member — whereas `false` re-creates the
   * stray-session class on the ordinary path, leaving the option on with no
   * hook and skipping a window kill for a pane that almost certainly did own
   * its window. The failure `true` accepts is the narrow one: if the throw and
   * the fallback coincide, this pane resizes, re-hooks or kills a sibling's
   * window, which is the harm the check exists to stop. `false` would accept
   * the broad one.
   */
  private async ownsWindow(tmuxSession: string, windowId: string): Promise<boolean> {
    try {
      return await this.claimsWindow(tmuxSession, windowId)
    } catch (error) {
      // Logged rather than swallowed silently: nothing else reports it, and a
      // fail-open answer is a guess this app should be able to see it made.
      // Not a log storm — every caller caches the answer on the entry, so this
      // is once per entry, not once per drag frame.
      console.error(
        `pTerm: tmux would not say who owns window ${windowId} for ${tmuxSession} ` +
          `(${String(error)}); assuming it is this pane's own`,
      )
      return true
    }
  }

  /** `ownsWindow`'s question, before it is made unable to fail. See there. */
  private async claimsWindow(tmuxSession: string, windowId: string): Promise<boolean> {
    const rows = await this.adapter.listSessionsWithGroups()
    const group = rows.find((row) => row.name === tmuxSession)?.group
    if (!group) return true

    // In tmux's order, with this member in its own place — `claimants[0]` is
    // then the fallback owner rather than whoever happened to ask.
    const claimants: string[] = []
    for (const row of rows) {
      if (row.group !== group) continue
      if (row.name === tmuxSession) claimants.push(row.name)
      else if ((await this.adapter.windowIdOf(row.name)) === windowId) claimants.push(row.name)
    }
    if (claimants.length < 2) return true

    const tabId = tabIdFromGroupName(group)
    const founder = claimants.find((name) => decodeSessionName(name)?.id === tabId)
    return (founder ?? claimants[0]) === tmuxSession
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
   *
   * `entry` is what cancels it. A poll for a session that never appears runs
   * the full ten seconds at 20ms — measured on this branch at 111 `tmux
   * display-message` spawns in three seconds, so ~370 for one abandoned
   * attach — and nothing ended it early: not a detach, not a kill, not the
   * test that started it. It stops at the next answer once the client it was
   * started for has been torn down, because there is nothing left that wanted
   * the answer. It takes whatever tmux says at that moment rather than
   * returning a fourth kind: a session that does exist still gets its hook,
   * which is what keeps `remain-on-exit` from being left on with nothing to
   * reap it.
   */
  private async awaitWindowId(tmuxSession: string, entry?: Entry): Promise<WindowLookup> {
    const deadline = Date.now() + WINDOW_ID_TIMEOUT_MS
    for (;;) {
      const lookup = await this.adapter.lookupWindow(tmuxSession)
      if (lookup.kind !== 'gone') return lookup
      if (entry?.abandoned) return lookup
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
   * What is decided here is the new pane's identity, the group to put it in,
   * and both windows' sizes. The three tmux objects a member is made of, and
   * the order they have to be made in, are `addMember`'s — shared with
   * `reopenInTab`, which brings a dead pane back into the same tab.
   */
  async splitTab(input: {
    paneId: string
    cwd?: string
    command?: string
    type?: TabType
    cols?: number
    rows?: number
  }): Promise<TerminalPaneRecord> {
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

    const record: TerminalPaneRecord = {
      id,
      projectSlug: sibling.record.projectSlug,
      cwd,
      command: input.command,
      tmuxSession,
      type: input.type ?? 'shell',
    }

    // `sized: true` regardless of what the caller passed, and this is where
    // that is earned: `addMember` resizes the new window to exactly these
    // numbers, before any client attaches to it. Defaulted or not, they are
    // the window's own size by the time it is attached to, so that attach
    // confirms a size rather than inventing one — which is the one thing the
    // I1 gate exists to stop.
    return this.addMember({
      group,
      through: sibling.record.tmuxSession,
      record,
      cols,
      rows,
      sized: true,
      // The sibling's own recorded tab — never this new pane's id, which is
      // the one thing it certainly is not: a pane added to a tab is not its
      // founder.
      //
      // Read off the entry rather than off `group`, and the two are not the
      // same answer: a group's name is the founder's session name frozen at
      // creation, so for a tab that has re-founded it decodes to the pane that
      // came back first, not to the tab. Taking the tab id from there would
      // hand this new pane a different tab from its own sibling's, and rows
      // written under it would be a second tab in the bar. The entry is where
      // the tab's permanent identity lives; see `Entry.tabId`.
      tabId: sibling.tabId,
    })
  }

  /**
   * Move a live pane out of its own tab and into another tab's group,
   * keeping the shell running inside it alive throughout.
   *
   * The destination session is created FIRST, before the moving pane's own
   * session is touched at all: `newGroupMember` is the one step in here tmux
   * can refuse, and creating it before anything has moved means a refusal
   * leaves the moving pane exactly where it started, not stranded mid-move
   * with nothing left to undo it into. An earlier version of this method
   * moved first and tried to recreate the source session afterward on
   * failure; that cannot work; measured directly, `move-window -t <name>`
   * refuses outright when `<name>` is not a live session and never creates
   * one, and a standalone source session is destroyed by tmux the instant
   * its one window leaves, so by the time a rollback ran there was nothing
   * left to move the window back into.
   *
   * The staging session joins `group` through `newGroupMember` rather than
   * founding anything of its own, so it starts life owning no window and no
   * shell. There is nothing here for `newGroupMember`'s own leaked-shell
   * comment to apply to.
   *
   * Every tmux call below that changes which window a session shows names
   * `staging`, or `record.tmuxSession` once it has been renamed onto
   * `staging`'s identity, never an existing member of `group` directly.
   * Measured on a throwaway socket: joining a new session through a live one
   * leaves the session joined THROUGH exactly where it was, and `move-window
   * -t <name>` only ever re-points the session `-t` names. So no other
   * member of `group` is read or written here at all, and none needs its
   * window snapshotted beforehand or restored after. "Leaves every member
   * of the target group on a window of its own" is what holds this, and it
   * goes red the moment this method is changed to move a window into an
   * existing member instead of into `staging` (checked by making exactly
   * that change and watching the test fail).
   */
  async joinTab(input: {
    paneId: string
    targetPaneId: string
  }): Promise<{ record: TerminalPaneRecord; tabId: string }> {
    const moving = this.entries.get(input.paneId)
    const target = this.entries.get(input.targetPaneId)
    if (!moving) throw new Error(`joinTab: no pane ${input.paneId}`)
    if (!target) throw new Error(`joinTab: no pane ${input.targetPaneId}`)
    if (moving.tabId === target.tabId) {
      throw new Error(`joinTab: pane ${input.paneId} is already in that tab`)
    }

    const targetTabId = target.tabId
    const group = await this.groupNameOf(input.targetPaneId)
    const record = moving.record
    // Read off the entry before `detach` below deletes it.
    const { cols, rows } = moving

    const movedWindow = await this.adapter.windowIdOf(record.tmuxSession)
    if (!movedWindow) {
      throw new Error(`joinTab: tmux would not name ${record.tmuxSession}'s window`)
    }

    // Read before anything below mutates tmux. `hasSession` after the move
    // only answers whether the source session survived losing its window,
    // and it survives whenever its group's window list is still non-empty
    // afterward: a lone session holding two windows survives losing one of
    // them the same way a session with a live sibling does (measured), so
    // "survived" does not by itself mean "safe to kill". What makes it safe
    // is captured here instead: whether another live session already shares
    // the source's group. If one does, that session's own view keeps
    // whatever windows remain reachable, and killing this one takes nothing
    // down with it. If none does, this may be the group's only live session,
    // and killing it would destroy every window the group still holds,
    // including one whose own member session already died and has no other
    // view onto it: a live shell nobody asked to close.
    const sourceRows = await this.adapter.listSessionsWithGroups()
    const sourceGroup =
      sourceRows.find((row) => row.name === record.tmuxSession)?.group || record.tmuxSession
    const sourceHasOtherLiveMember = sourceRows.some(
      (row) => row.group === sourceGroup && row.name !== record.tmuxSession,
    )

    const staging = `${record.tmuxSession}-joining`
    await this.adapter.newGroupMember(group, staging, { PTERM_TAB_ID: record.id })

    this.detach(input.paneId)
    try {
      await this.adapter.moveWindow(record.tmuxSession, staging)
      // Skipped rather than killed when no other live session shares the
      // source's group: see the comment above `sourceHasOtherLiveMember`.
      // Left alone, the worst case is an extra session lingering under a
      // name `renameSession` below then refuses to reuse, which fails the
      // join (the `catch` handles that the same as any other failure here)
      // rather than destroying a window nothing else has a view onto.
      if ((await this.adapter.hasSession(record.tmuxSession)) && sourceHasOtherLiveMember) {
        await this.adapter.killSession(record.tmuxSession)
      }
      await this.adapter.renameSession(staging, record.tmuxSession)
    } catch (error) {
      // Nothing has moved if `newGroupMember` above is what threw, so there
      // is nothing to undo there. If the move itself failed after staging
      // was created, the moved window and its shell are wherever they were
      // before this call ran; the one thing left over worth cleaning up is
      // the empty staging session, before it becomes a session nothing in
      // this app can reach again.
      await this.adapter.killSession(staging).catch(() => undefined)
      throw error
    }

    const windows = await this.adapter.windowsOf(record.tmuxSession)
    const indexOf = new Map(windows.map((window) => [window.id, window.index]))
    const movedIndex = indexOf.get(movedWindow)
    if (!movedIndex) {
      throw new Error(`joinTab: ${movedWindow} is not in ${group} after the move`)
    }
    await this.adapter.selectWindow(record.tmuxSession, movedIndex)

    return {
      record: this.open({
        id: record.id,
        projectSlug: record.projectSlug,
        cwd: record.cwd,
        command: record.command,
        tmuxSession: record.tmuxSession,
        type: record.type,
        cols,
        rows,
        tabId: targetTabId,
      }),
      tabId: targetTabId,
    }
  }

  /**
   * Bring a pane that has died back into the tab it belonged to.
   *
   * Three cases, and the tab this manager RECORDED for the pane — the founder
   * pane's id, not this pane's own, whenever the two differ — is what tells
   * the middle one from the last:
   *
   *   1. The pane's own session is still running: a client died, not the
   *      session. `new-session -A` reattaches to it and its group membership
   *      was never lost, so `open()` is right — and joining anything here
   *      would not merely be redundant, it would fail: `new-session -t <group>
   *      -s <name>` with a name tmux already has is refused outright
   *      ("duplicate session", exit 1 — measured).
   *   2. The session has gone and the tab still has a live member — in a
   *      group, or reduced to one and so ungrouped, which `liveGroupOf` treats
   *      alike: the pane has to JOIN it. A bare `new-session -A` would create
   *      an UNGROUPED session under the same name — a pane sitting beside its
   *      tab rather than in it, which the next restore reads as a tab of its
   *      own, since restore groups panes by their `session_group` and nothing
   *      else. That is finding I4, and it is the only case here that is new.
   *   3. The session has gone and tmux has nothing left of the tab at all: an
   *      ordinary one-pane tab, or the first pane back of a split that died
   *      whole. There is nothing to join and `new-session -A` is right for it.
   *      Case 2 then covers the panes that follow it back — see `liveGroupOf`,
   *      which is what stops the tab un-splitting between the two restarts.
   *
   * Case 2 is reachable only while the recorded tab id names something tmux
   * still has. A dead pane leaves no trace of its own membership — it lived in
   * the member session, and the death hook kills that session — which is why
   * the fact is remembered from when the pane was created rather than looked
   * up here or taken from the caller. See `tabWasIn`.
   *
   * The input deliberately has no `tabId`: there is nothing a caller could put
   * there that this does not already know better, and an omission would be
   * indistinguishable from a one-pane tab.
   */
  async reopenInTab(
    input: Omit<OpenInput, 'tabId'> & { id: string },
  ): Promise<{ record: TerminalPaneRecord; groupId: string }> {
    // Before either await, so "already open" is still refused before anything
    // can race it — see `recordFor`.
    const record = this.recordFor(input)
    const geometry = this.geometryOf(input)
    // The pane's own id when nothing was recorded for it, which is right for
    // the two cases that produce no memory: a one-pane tab (its founder's id
    // IS the tab's) and a pane this process never held — no restart is offered
    // for one of those, since a tombstone does not survive a relaunch.
    const tabId = this.tabWasIn.get(record.id) ?? record.id

    if (await this.adapter.hasSession(record.tmuxSession)) {
      const reattached = this.attach(record, { ...geometry, tabId })
      // Its own session never left the group it was created in, so the tab's
      // group is whatever it already was. Read off the now-live entry rather
      // than assumed to be `tabId`: this is also the path a pane of a tab that
      // re-founded some time ago takes, and that group is not named after the
      // tab.
      return { record: reattached, groupId: await this.currentGroupId(record.id, tabId) }
    }

    const rejoin = await this.liveGroupOf(tabId)
    if (!rejoin) {
      // Case 3, and the half of it this app can still be wrong about. There is
      // nothing to join, so `new-session -A` makes an UNGROUPED session — and
      // for a tab that had more than one pane, that session is what the next
      // pane back will be joined to, which names the group after it. So the
      // tab re-founds here, around this pane, and the group id it reports is
      // this pane's own. Its `tabId` is untouched: `TabRow.id` is the tab's
      // permanent identity and the renderer's key for it.
      return { record: this.attach(record, { ...geometry, tabId }), groupId: record.id }
    }

    const joined = await this.addMember({
      group: rejoin.group,
      through: rejoin.member,
      record,
      cols: geometry.cols,
      rows: geometry.rows,
      // Whatever the caller knew, unchanged. A restart that was given no size
      // must not drive this pane's new window to one, which is why `addMember`
      // takes this rather than assuming a split's `true`.
      sized: geometry.sized,
      tabId,
    })
    // The group actually joined, which for a tab that re-founded before this
    // pane came back is named after whichever pane did come back first.
    return { record: joined, groupId: tabIdFromGroupName(rejoin.group) ?? tabId }
  }

  /**
   * The group id of a pane this manager holds an entry for, or `fallback` when
   * its group name is one this app did not create and cannot read.
   *
   * Answered from the pane rather than from the tab, which is what makes it
   * safe to ask immediately after an attach: `groupIdOf` looks for a live
   * session of the tab, and a client spawned moments ago may not have run its
   * `new-session` yet — a race that reads as "this tab has no group", which is
   * a plausible, wrong answer.
   */
  private async currentGroupId(paneId: string, fallback: string): Promise<string> {
    return tabIdFromGroupName(await this.groupNameOf(paneId)) ?? fallback
  }

  /**
   * What a pane of tab `tabId` must be joined to, and a live session to work
   * through — or undefined when tmux has nothing left of that tab.
   *
   * Two ways a tab can be present, and both are needed. This is the same rule
   * `groupNameOf` applies to a live pane (`row?.group || record.tmuxSession`),
   * asked of a tab whose pane is dead:
   *
   *   - A live member's `session_group`, matched on the group NAME's id half
   *     and nothing else: the slug in it is frozen at group creation and is
   *     out of date after any move (see `tabIdFromGroupName`). The group
   *     outlives the pane that named it — measured, after a founder's session
   *     and window are killed its sibling still reports the same
   *     `session_group`.
   *   - Failing that, a live session whose OWN name carries this tab's id.
   *     A tab reduced to one member is UNGROUPED — it reports an empty
   *     `session_group`, and `tabIdFromGroupName('')` is null — so the match
   *     above cannot see it. Without this second half, a split whose panes all
   *     died and were then restarted one at a time comes back as two separate
   *     tabs: the first pane back is ungrouped by definition (there was
   *     nothing to rejoin), and every pane after it then finds nothing to
   *     match. That is I4's harm again, reached with a perfectly good `tabId`.
   *   - Failing THAT, a live session belonging to any pane this manager places
   *     in this tab. The second match only ever finds the founder — a session
   *     whose own name decodes to the tab id is the founder's by definition —
   *     so with every pane of the tab dead and the SIBLING restarted first,
   *     neither match above can see anything: there is no group, and the only
   *     name they look for is the founder's, which is the one still dead. The
   *     tab then re-founds under the sibling, and this is what the panes that
   *     follow it back find. Which panes are in the tab is main's own record
   *     (`Entry.tabId` for a live one, `tabWasIn` for a dead one) — the same
   *     fact `reopenInTab` starts from, read the other way round.
   *
   * Joining by that name is what re-forms the tab, not merely some group:
   * `new-session -t <a session name>` creates a group named after that session
   * — measured, and it is how this tab's group was named in the first place
   * (`splitTab` hands `groupNameOf`'s fallback to `newGroupMember`). Through
   * the first two matches the tab regains the group name it had, whose id half
   * still decodes to `tabId`. Through the third it cannot: the session that
   * named the group is gone, and tmux has no way to name a group after a
   * session it does not have, so the group comes back named after the pane
   * that came back first and the tab's group id changes. Its `TabRow.id` does
   * not — see `TabRow.groupId` for the other half of that, and `groupIdOf`,
   * which is how a caller holding a tab id learns the new one.
   *
   * The second match cannot pick up the pane being restarted: `reopenInTab`
   * has already returned whenever a session by that pane's name is live, so by
   * here there is none, and a tab of one is the only thing it can find. (A
   * live session carrying this pane's id under a DIFFERENT project slug would
   * match — but that is a caller holding a name tmux has renamed out from
   * under it, which no path through `reopenInTab` can detect and none of them
   * created.)
   *
   * Neither of the two existing tab lookups answers this. `panesOfTab` returns
   * `PaneRecord`s, which carry no group name at all — it can name a member but
   * not the group to join one to. `findOrphanTabs` is built on `findOrphans`,
   * which excludes every session this app holds a client for, and a live
   * sibling is exactly that.
   *
   * Any member will do: members of a group share one window list, so
   * `new-window` through any of them puts the window in the same place. The
   * one picked is first in tmux's alphabetical order and means nothing.
   */
  private async liveGroupOf(
    tabId: string,
  ): Promise<{ group: string; member: string } | undefined> {
    const member = this.memberOfTab(await this.adapter.listSessionsWithGroups(), tabId)
    // `groupNameOf`'s rule, applied to a session found rather than named: a
    // member reports the group it is in, and a session in no group IS the
    // group any join would create — which is what makes a re-founding possible
    // at all, and what names the new group after this member.
    return member ? { group: member.group || member.name, member: member.name } : undefined
  }

  /**
   * A live session of tab `tabId`, or undefined when tmux has nothing left of
   * that tab. The three matches are `liveGroupOf`'s; see it for why each is
   * needed and in this order.
   *
   * Split out because `panesOfTab` needs the same question answered against
   * rows it has already fetched, and two resolutions of "which tmux group is
   * this tab" is exactly how the two of them came to disagree about whether a
   * tab exists at all — see `panesOfTab`'s own note on that.
   */
  private memberOfTab(
    rows: readonly { name: string; group: string }[],
    tabId: string,
  ): { name: string; group: string } | undefined {
    const grouped = rows.find((candidate) => tabIdFromGroupName(candidate.group) === tabId)
    if (grouped) return grouped

    const founder = rows.find((candidate) => decodeSessionName(candidate.name)?.id === tabId)
    if (founder) return founder

    // Only reachable for a tab that has re-founded: any pane of a tab still in
    // its original group is found by one of the two matches above.
    const members = new Set<string>()
    for (const [id, entry] of this.entries) if (entry.tabId === tabId) members.add(id)
    for (const [id, was] of this.tabWasIn) if (was === tabId) members.add(id)
    return rows.find((candidate) => {
      const id = decodeSessionName(candidate.name)?.id
      return id !== undefined && members.has(id)
    })
  }

  /**
   * The id half of the tmux group tab `tabId` is in now.
   *
   * `tabId` itself for every tab that still has the group it was founded with,
   * and for one tmux has nothing left of — a tab with no live members is about
   * to re-found under whichever pane comes back first, and until one does
   * there is nothing truer to say. After a re-founding it is that pane's id.
   *
   * This is the only way a caller holding a tab id can learn the group id to
   * write on that tab's row, and it has to be asked of tmux rather than
   * remembered: the group a tab re-founds into is decided by a restart, and
   * the panes that follow it back join whatever they find.
   */
  async groupIdOf(tabId: string): Promise<string> {
    const found = await this.liveGroupOf(tabId)
    return (found && tabIdFromGroupName(found.group)) ?? tabId
  }

  /**
   * Put a pane into a tab that already exists in tmux.
   *
   * Three tmux objects, in this order and no other:
   *   1. `new-window -e PTERM_TAB_ID=<id>` in the group — holds the process.
   *   2. `new-session -t <group> -s <name>` — the view the xterm attaches to.
   *   3. `select-window` binding 2 to 1, BEFORE any client attaches.
   *
   * Step 3 before the attach is not stylistic. A newly joined member's current
   * window is arbitrary — measured, a sibling's `@0` every time — so a client
   * attaching first lands on a sibling's window and resizes it, and two xterms
   * then render one pane.
   *
   * The middle of both callers, kept as one copy. `splitTab` adds a pane the
   * user has just asked for; `reopenInTab` puts a pane that died back where it
   * was. What differs between them is decided before this runs — which id and
   * record, which live member to work through, and whether anyone has measured
   * the geometry — and none of it changes the three objects or their order.
   *
   * `through` is a LIVE member session, never the group name: `new-window`
   * takes a window target, and a group name is not one.
   *
   * Everything here is guarded. The window is the first object this makes that
   * the app cannot see and tmux can: it goes into the tab's SHARED window list
   * holding a running shell, where only `list-windows` would ever find it
   * again. The member session that follows is worse — it is a name
   * `findOrphans` reports as a real pane, so the next restore resurrects a pane
   * the user never created, attached to a window nothing has a record of. See
   * `rollbackSplit`.
   */
  private async addMember(input: {
    group: string
    through: string
    record: TerminalPaneRecord
    cols: number
    rows: number
    sized: boolean
    /** The tab this member joins — see `Entry.tabId`. Both callers know it. */
    tabId: string
  }): Promise<TerminalPaneRecord> {
    const { group, record, cols, rows, sized, tabId } = input
    // Created EMPTY — the command follows at the end, once the window can
    // survive it.
    const window = await this.adapter.newWindow({
      member: input.through,
      cwd: record.cwd,
      env: { PTERM_TAB_ID: record.id },
    })

    try {
      // The new pane's own window is sized by window id, and before any client
      // has attached to it — so there is no ordering here that has to hold for
      // the geometry rule to be in force. Without the explicit resize,
      // `manual` would revert this window to the size tmux recorded when
      // `newWindow` made it, which is the founder's, not this pane's.
      //
      // Skipped entirely when nobody has measured this pane, which is the I1
      // gate again: a window is never driven to an invented size. Nothing is
      // owed in that case, and nothing is at risk either — this window was
      // created moments ago and has no scrollback to re-wrap, and it is left
      // on the `window-size latest` it inherits (measured: a window
      // `new-window` makes reads the option unset, and the global is `latest`),
      // so it follows the client this pane is about to attach. That client is
      // the only one that will ever have this window active: every other member
      // of the group is bound to a window of its own.
      if (sized) {
        await this.adapter.setWindowOption(window.id, 'window-size', 'manual')
        await this.adapter.resizeWindow(window.id, cols, rows)
      }
      // The env goes here too, not only on `newWindow`: `-e` on `new-window`
      // reaches the spawned pane's own process (confirmed: a child inside it
      // sees it) but never the session's environment table — `show-environment`
      // on the new member reports nothing. `-e` on `new-session -t <group>`
      // does reach that table, which is where a reattach and any
      // `show-environment` caller both go looking, so both calls carry it.
      await this.adapter.newGroupMember(group, record.tmuxSession, { PTERM_TAB_ID: record.id })
      // By index, with the member named. See the adapter method's comment.
      await this.adapter.selectWindow(record.tmuxSession, window.index)
      return await this.finishSplit(record, window, cols, rows, sized, tabId)
    } catch (error) {
      await this.rollbackSplit(record, window.id)
      throw error
    }
  }

  /**
   * The last three steps of adding a member, kept together so `addMember`'s
   * try block reads as one guarded sequence rather than a wall of awaits.
   */
  private async finishSplit(
    record: TerminalPaneRecord,
    window: { id: string; index: string },
    cols: number,
    rows: number,
    sized: boolean,
    tabId: string,
  ): Promise<TerminalPaneRecord> {
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
    await this.wireDeathHook(record, { kind: 'found', id: window.id })
    if (record.command) {
      await this.adapter.respawnPane(window.id, {
        command: record.command,
        cwd: record.cwd,
        env: { PTERM_TAB_ID: record.id },
      })
    }

    return this.attach(record, { cols, rows, windowId: window.id, sized, tabId })
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
  private async rollbackSplit(record: TerminalPaneRecord, windowId: string): Promise<void> {
    const entry = this.entries.get(record.id)
    if (entry?.record === record) {
      // `attach` got as far as registering it. Mark the intent before tearing
      // the client down, so the exit this raises is not reported as a crash of
      // a pane the caller has not been given yet.
      entry.intent = 'killed'
      entry.abandoned = true
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

  get(id: string): TerminalPaneRecord | undefined {
    return this.entries.get(id)?.record
  }

  list(): TerminalPaneRecord[] {
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
   * At most one `resize-window` is in flight for a pane at a time. A drag
   * emits resizes faster than tmux answers any of them — roughly 120 a second
   * through `ResizeObserver` — and spawning one `execFile` per frame is the
   * subprocess storm this milestone has now met twice. So a call that finds
   * one already in flight does not spawn a second: it sets `entry.resizeDirty`
   * and returns, and the loop below picks the newer size up itself once the
   * in-flight call settles, spawning nothing until then.
   *
   * Staleness used to be handled by comparison: `if (entry.cols !== cols ||
   * entry.rows !== rows) return` dropped a call whose `cols`/`rows` arguments
   * the renderer had since superseded, so a slow early resize could not land
   * last. That guard cannot simply stay — the loop makes it not merely
   * redundant but wrong. Every pass sends `entry.cols`/`entry.rows`, not the
   * `cols`/`rows` this call started with, and `entry.cols`/`entry.rows` are
   * kept current by `resize` — so they are the newest size by definition, on
   * every pass, with nothing left to compare them against. Reinstating the
   * old guard would compare the newest size to itself and always pass, or,
   * worse, compare it to the stale arguments a superseded call woke the loop
   * with and drop the very call carrying the final frame — staleness handled
   * by construction rather than by a check that no longer has anything to
   * check.
   *
   * The identity guard is a different check and stays, re-checked on every
   * pass rather than once: it catches an entry the MANAGER has superseded — a
   * pane detached and reopened (`moveTabToProject` does this on every move)
   * gets a new entry with new geometry, and this loop, closed over the OLD
   * one, would otherwise keep sending that old entry's `cols`/`rows` to a
   * window nothing renders into any more. Same identity comparison
   * `session.onExit` makes, and for the same reason: a loop that outlives its
   * entry must not go on issuing tmux calls on its behalf.
   *
   * `cols`/`rows` are unused for exactly the reason above — the loop reads
   * `entry.cols`/`entry.rows` instead — and are kept, underscored, rather than
   * dropped: this task is `resizeWindow`'s internals only, and both call
   * sites (`resize`, `sizeWindowOnAttach`) still have a size in hand and
   * passing it costs nothing.
   */
  private async resizeWindow(entry: Entry, _cols: number, _rows: number): Promise<void> {
    let windowId = entry.windowId
    if (!windowId) {
      // Already asked, and already told no. A drag would otherwise put a
      // `list-sessions` plus one `windowIdOf` per sibling between every frame,
      // for a pane whose answer cannot change.
      if (entry.windowDenied) return
      const found = await this.adapter.windowIdOf(entry.record.tmuxSession)
      // Not cached, and not resized, when a sibling owns it: see `ownsWindow`.
      // Asked at most once per entry rather than once per resize — a "yes" is
      // cached as `windowId`, which takes this whole branch out of the way for
      // good, and a "no" as `windowDenied`, which does the same.
      if (!found) return
      if (!(await this.ownsWindow(entry.record.tmuxSession, found))) {
        entry.windowDenied = true
        return
      }
      entry.windowId = found
      windowId = found
    }
    if (this.entries.get(entry.record.id) !== entry) return
    // Already sending. Record that a newer size exists and let the in-flight
    // call pick it up when it settles — the loop below always reads the
    // entry's CURRENT size, so the newest frame wins without a timer and
    // without a queue.
    if (entry.resizing) {
      entry.resizeDirty = true
      return
    }
    entry.resizing = true
    try {
      do {
        entry.resizeDirty = false
        // Re-checked every pass, not once: `moveTabToProject` disposes an
        // entry and makes a new one, and this loop can outlive that.
        if (this.entries.get(entry.record.id) !== entry) return
        await this.adapter.resizeWindow(windowId, entry.cols, entry.rows)
      } while (entry.resizeDirty)
    } finally {
      entry.resizing = false
    }
  }

  /** Detach the client. The tmux session keeps running. */
  detach(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.intent = 'detached'
    entry.abandoned = true
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
   *
   * The window is killed only when this pane is the one entitled to it. A
   * member whose own window died reports its SIBLING's, so killing what it
   * reports would destroy the other pane's window and the process inside it —
   * the user closes one pane and the other one's shell dies. Its session is
   * still killed either way; that is the only object it still has.
   *
   * That question is only put to tmux when the window had to be LOOKED UP. A
   * window id already on the entry is this pane's own by construction —
   * `splitTab` made that window for this pane, and the only other writers of
   * the field set it after `ownsWindow` has already said yes — and asking
   * again is not a second opinion but a worse one. `ownsWindow` can only see
   * what tmux reports now, and in the mirror-image fallback (the FOUNDER's
   * window dies and the founder falls back onto THIS pane's) the founder-first
   * tie-break hands this pane's own window to the founder and vetoes the kill,
   * leaving a live window and the shell inside it behind — measured. The
   * tie-break itself is unchanged, and has to be: which member truly owns a
   * shared window is not recoverable from tmux. This narrows it to the case
   * where tmux's report is the only evidence there is, which is the same
   * `ours`/looked-up distinction `wireDeathHook` and `sizeWindowOnAttach`
   * already make. A pane whose entry was reopened after its own window died
   * still has no cached id, so the case the check exists for is untouched.
   */
  async kill(id: string): Promise<void> {
    const entry = this.entries.get(id)
    if (entry) {
      const cached = entry.windowId
      const windowId = cached ?? (await this.adapter.windowIdOf(entry.record.tmuxSession))
      // Asked before the session is killed, and it has to be: the check reads
      // this session's group out of `list-sessions`, and there is no row left
      // to read once it has gone.
      const own =
        cached !== undefined ||
        (!entry.windowDenied &&
          windowId !== '' &&
          (await this.ownsWindow(entry.record.tmuxSession, windowId)))
      entry.intent = 'killed'
      entry.abandoned = true
      this.entries.delete(id)
      entry.session.detach()
      await this.adapter.killSession(entry.record.tmuxSession)
      if (own) await this.adapter.killWindow(windowId)
      return
    }

    const orphan = (await this.findOrphans()).find((record) => record.id === id)
    // Resolving here would report success without killing anything.
    if (!orphan) throw new Error(`kill: no tmux session found for tab ${id}`)
    const windowId = await this.adapter.windowIdOf(orphan.tmuxSession)
    const own = windowId !== '' && (await this.ownsWindow(orphan.tmuxSession, windowId))
    await this.adapter.killSession(orphan.tmuxSession)
    if (own) await this.adapter.killWindow(windowId)
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
   * `known` carries the tab's real cwd, command and type when the caller has
   * them on record. A tab whose client has already gone — detached, and still perfectly
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
   * The single-pane path through `moveTabToProject`, for a caller holding
   * exactly one pane's `known` that would otherwise wrap it in a one-entry
   * `Map`. No production caller does: the IPC move passes the whole tab's map
   * as of 2026-08-01, because writing back one pane's row is what left a split
   * tab's sibling on disk under the project it came from. Only
   * `manager.test.ts`'s two geometry regressions still come through here.
   */
  async moveToProject(
    id: string,
    projectSlug: string,
    known?: Pick<PaneRecord, 'cwd' | 'command' | 'type'>,
  ): Promise<TerminalPaneRecord> {
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
   * `known` carries each pane's real cwd, command and type, keyed by pane id,
   * for the same reason `moveToProject` takes one — a pane found through
   * `panesOfTab` rather than an open entry has a tmux-synthesised cwd, no
   * command, and a type of `'shell'` whatever it really is.
   *
   * Each reattach carries that pane's own live geometry forward, same as
   * `moveToProject` — nothing in the renderer changes size across a move, so
   * no refit follows to correct a default-sized attach.
   */
  async moveTabToProject(
    tabId: string,
    projectSlug: string,
    known?: Map<string, Pick<PaneRecord, 'cwd' | 'command' | 'type'>>,
  ): Promise<TerminalPaneRecord[]> {
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
    //   $ tmux kill-session -t '=pterm-gone-0000000000000000' ';' kill-window -t @1
    //   can't find session: pterm-gone-0000000000000000
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
    const renamed: { pane: TerminalPaneRecord; from: string; to: string }[] = []
    try {
      for (const { pane, to } of targets) {
        if (to === pane.tmuxSession) continue
        await this.adapter.renameSession(pane.tmuxSession, to)
        renamed.push({ pane, from: pane.tmuxSession, to })
        // A single lookup, never the polling wrapper: the rename it follows
        // has just succeeded, so the session provably exists and there is
        // nothing to wait for. `awaitWindowId` would answer `gone` for a pane
        // that died in the gap and keep asking for ten seconds — with this
        // `await` inside the rename loop, and the IPC handler holding the
        // config queue, that stalled a tab genuinely split across two
        // projects for the whole of it.
        await this.wireDeathHook(
          { ...pane, tmuxSession: to },
          () => this.adapter.lookupWindow(to),
        ).catch(() => {})
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
          await this.wireDeathHook(pane, () => this.adapter.lookupWindow(pane.tmuxSession)).catch(
            () => {},
          )
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

    const moved: TerminalPaneRecord[] = []
    for (const { pane, to } of targets) {
      const overrides = known?.get(pane.id)
      const cwd = overrides?.cwd ?? pane.cwd
      const command = overrides?.command ?? pane.command
      // `type` comes from the caller's row for the same reason `cwd` and
      // `command` do, and is the easiest of the three to lose: `panesOfTab`
      // synthesises `'shell'` for a pane with no open entry — a launch intent
      // is not recoverable from a session name — so moving a DETACHED claude
      // or preset pane used to write it back as a shell, and the next restore
      // opened it as one. `restore.ts` already restores `type: row.type` from
      // the saved row for exactly this reason.
      const type = overrides?.type ?? pane.type
      // Already there: nothing was renamed, and nothing worth tearing a
      // working client down for.
      if (to === pane.tmuxSession) {
        moved.push({ ...pane, cwd, command, type })
        continue
      }

      // Read before the detach disposes the entry. A detached pane has none,
      // and no client to take a size from either, so no size is passed at
      // all — deliberately, not merely for want of one: `open()` reads an
      // absent size as "leave this pane's window alone" (see `sized` there),
      // so the window keeps the geometry it already had and only the new
      // client starts at the default. Passing `DEFAULT_COLS`/`DEFAULT_ROWS`
      // here explicitly would instead drive a split pane's `manual` window
      // down to 80x24, which is finding I1 reached through the move path.
      // The renderer refits the pane when it is next shown.
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
          type,
          // Carried across the detach and reopen. Without it `open()` reads
          // every pane of a moved tab as the founder of a tab of its own, and
          // a restart after a later death brings a sibling back outside the
          // group — I4, reached through the move path. The entry's own answer
          // first (recorded when the pane was created or adopted); for a
          // DETACHED pane, which has no entry, the tab it was found in.
          tabId: entry?.tabId ?? tabId,
          ...size,
        }),
      )
    }
    return moved
  }

  /**
   * pterm-owned tmux sessions with no client in this app — left behind by a
   * previous run or a crash. Callers decide whether to reopen them.
   */
  async findOrphans(): Promise<TerminalPaneRecord[]> {
    const open = new Set(this.list().map((record) => record.tmuxSession))
    const names = await this.adapter.listPTermSessions()
    const orphans: TerminalPaneRecord[] = []
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
  async findOrphanTabs(): Promise<{ tabId: string; panes: TerminalPaneRecord[] }[]> {
    const panes = await this.findOrphans()
    const rows = await this.adapter.listSessionsWithGroups()
    const groupOf = new Map(rows.map((row) => [row.name, row.group]))

    const tabs = new Map<string, TerminalPaneRecord[]>()
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
  async panesOfTab(tabId: string): Promise<TerminalPaneRecord[]> {
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
      //
      // Resolved through `memberOfTab`, which is that same group-name match
      // plus the one a re-founded tab needs: once every pane of a tab has died
      // the group is named after whichever pane came back first, so a tab id
      // matches no group name at all and reading only that would report a live
      // split tab as having no panes.
      const member = this.memberOfTab(rows, tabId)
      if (!member) return []
      // Nothing to put first: the pane whose id names this tab has gone, so
      // the order is tmux's and no caller may read a founder out of it.
      //
      // An ungrouped member is the whole tab — a tab down to one pane reports
      // no group, and filtering on `''` would collect every other lone session
      // on the socket into this tab.
      members = member.group ? rows.filter((row) => row.group === member.group) : [member]
    }

    const panes: TerminalPaneRecord[] = []
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

  /**
   * The window a pane's member session is currently showing, or `''` when tmux
   * will not say.
   *
   * `windowIdOf`, not `lookupWindow`: the one caller — restore, comparing one
   * member's window against its siblings' — has nothing better to do with
   * "gone" than with "tmux would not answer". Both mean it cannot tell whether
   * this pane is looking at a sibling's window, and neither is grounds for
   * pruning a live session.
   */
  async windowOfMember(tmuxSession: string): Promise<string> {
    return this.adapter.windowIdOf(tmuxSession)
  }

  /**
   * Destroy a member session and NOTHING else — no window, no group.
   *
   * The one caller is restore, dropping a member that has fallen back onto a
   * sibling's window. Dropping it from the tab is not enough on its own: the
   * session stays alive with no config row and no tab-bar entry, so nothing
   * in the app can ever see it or kill it again and every future restore
   * prunes it afresh. It is exactly the "live session the app has lost track
   * of" this milestone's architecture note is written against.
   *
   * Deliberately not `kill()`. That resolves a window id and kills it too,
   * and the only window this pane reports is its SIBLING's — killing it would
   * take the sibling's process with it. Here there is no window to leak:
   * this member has none of its own, which is the very condition that
   * identified it.
   *
   * Best effort. A refused kill leaves exactly the strays that existed
   * before, and failing the whole restore over one of them would cost the
   * user every other pane; it is logged instead, because silence is what made
   * the pruned member permanent.
   */
  async killShadowMember(tmuxSession: string): Promise<void> {
    try {
      await this.adapter.killSession(tmuxSession)
    } catch (error) {
      console.error(
        `pTerm: could not kill the shadowing member session ${tmuxSession}; ` +
          'it is running with no window of its own and no entry in the UI',
        error,
      )
    }
  }

  onExit(listener: (record: TerminalPaneRecord, code: number, reason: ExitReason) => void): void {
    this.exitListeners.add(listener)
  }
}
