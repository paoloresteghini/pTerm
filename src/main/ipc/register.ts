import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { appendFile } from 'node:fs/promises'
import {
  CHANNELS,
  canHaveSession,
  type Candidate,
  type DataEvent,
  type DiffSide,
  type ExitEvent,
  type FsResult,
  type HistoryEntry,
  type HistoryScope,
  type IssueStateFilter,
  type JoinShape,
  type NotificationConfig,
  type OpenRequest,
  type Preset,
  type ProjectFileList,
  type ProjectDescriptor,
  regionOf,
  type RestartRequest,
  type RestoreResult,
  type SplitRequest,
  type StatusEvent,
  type TabDescriptor,
  type TabRow,
  type TabShape,
  type TodoDraft,
  type TodoPatch,
} from '../../shared/ipc'
import type { ExitReason, SessionManager, PaneRecord, TerminalPaneRecord } from '../sessions/manager'
import { normaliseUrl } from '../../shared/browserUrl'
import { ConfigStore, type PTermConfig } from '../state/store'
import { StatusRegistry } from '../status/registry'
import {
  describeProjects,
  restoreWorkspace,
  tabRowFor,
  withUnsorted,
} from './restore'
import {
  sharesAroundClaims,
  tombstonesOf,
  claimFor,
  inLiveFrame,
  layoutWrite,
  rescaledClaims,
  type Claim,
} from './shares'
import {
  commentIssue,
  createIssue,
  editIssue,
  getIssue,
  listIssues,
  NO_PROJECT,
  setIssueState,
} from '../gh/issues'
import { attachSavedFields } from './savedFields'
import { isDirectory } from '../fsutil'
import { scanCandidates } from '../projects/discovery'
import { hookPaths, installHooks, readHooksState, uninstallHooks } from '../hooks/install'
import { drainSpool } from '../hooks/spool'
import { readHistory, selectHistory } from '../shell/history'
import {
  installShellHistory,
  readShellHistoryState,
  uninstallShellHistory,
} from '../shell/install'
import { listSkills } from '../skills/scan'
import { readNote, writeNote } from '../notes/store'
import { createTodo, deleteTodo, readTodos, setTodoDone, updateTodo } from '../todos/store'
import { broadcastTodos } from '../todos/broadcast'
import { realUpdateService } from '../update/service'
import { readSkipped, writeSkipped } from '../update/store'
import { isOpenable } from '../update/openable'
import { addPrompt, readPrompts, removePrompt } from '../prompts/store'
import { listDir, readFileInside, resolveInside, writeFileInside } from '../files/tree'
import { createEntry, pathsFor, renameEntry } from '../files/ops'
import { projectFiles } from '../files/projectFiles'
import { readBranch } from '../git/branch'
import { readCounts, syncBranch } from '../git/sync'
import { readChanges, repoRoot } from '../git/status'
import { commit, diffOf, discard, stage, stashAll, unstage } from '../git/ops'
import { newSessionId } from '../tmux/names'
import {
  addProject,
  projectForSlug,
  removeProject,
  reorderProjects,
  updateProject,
} from '../projects/projects'
import { isPaneColor, PANE_COLOR_DEFAULT, type PaneColor } from '../../shared/paneColors'
import { isThemeId, type ThemeId } from '../../shared/themes'

/**
 * The new pane's ratio, carved out of the pane it split from.
 *
 * `sourcePaneId` keeps half its own share and `newPaneId` takes the other
 * half. Every OTHER kid the saved row already knew about keeps the share
 * that row had for it, relative to the other kids that row knew — that part
 * genuinely is untouched, and does not need a normalisation to make it true.
 * Its ABSOLUTE width is a different claim and a weaker one; the paragraphs
 * below say exactly when it moves and why that is not this carve failing.
 *
 * The part that is easy to miss is `siblings`, not `savedKids`: `siblings`
 * is the saved row's kids UNIONED with any live pane that row does not
 * mention — an "unclaimed" sibling, which today means exactly one thing: a
 * pane that died and was restarted, whose row entry `forgetTab` dropped at
 * its death and nothing has put back (`shareOf`'s `at === -1` branch, below,
 * is where that is felt). Such a pane comes with a share only when main
 * REMEMBERS the one it died at — this function's own `tombstones` parameter,
 * which both call sites hand this file's outer map of the same name. Then
 * that share is a `claim` on the whole tab and every saved-derived share
 * scales into what is left, so nothing is invented and the pane comes back
 * the size it was.
 *
 * Remembered is not guaranteed, though: the map is process-lifetime, so a
 * pane adopted from a previous run, or one whose entry a dismiss dropped,
 * arrives here unclaimed and unremembered. It is then handed a SYNTHETIC
 * share — an even split of the axis — landed on top of shares that, for the
 * OTHER kids, already summed to 1, and `sharesAroundClaims` normalises the
 * lot. That dilution moves every OTHER kid's share too — including a pane
 * the user did not touch at all, which sounds like the very thing this carve
 * exists to prevent.
 *
 * It is not, and the distinction is the point: what a carve preserves is not
 * the ABSOLUTE width of an untouched pane — it cannot, once a pane with no
 * accounted-for share is back in the room, somebody has to make space for it
 * — but the RELATIVE proportion among the kids whose shares were already
 * known. Two panes at a saved 0.6:0.4 stay at 0.6:0.4 relative to each other
 * once an unclaimed sibling dilutes both by the same factor, because the
 * dilution is a single scalar applied to every known share alike, and that
 * scalar cancels out of a ratio taken between two known kids. `sum ≈ 1`
 * cannot tell a correct dilution from an unclaimed sibling that was ignored
 * outright — the normalisation forces the sum to 1 either way.
 *
 * Neither, for the same reason, can the relative-proportion check above: two
 * known kids' ratio to each other is the SAME whether the unclaimed
 * sibling's share was computed correctly, computed wrong, or dropped to zero
 * — the common total the ratio divides through by cancels regardless of what
 * put it there. Proving the unclaimed sibling was actually accounted for
 * needs a THIRD kind of check: that pane's own final share is positive. Both
 * checks are real and both are necessary; neither is sufficient alone. Both
 * are in `tests/unit/carveRatio.test.ts`'s "dilutes every known share evenly
 * ..." test, which also carries the A/B that found this — the
 * relative-proportion assertion alone did not fail when the unclaimed
 * sibling's share was zeroed, which is the reason the third check exists.
 *
 * This overturns plan 2b's even split, whose stated reason was that "ratios
 * are the one thing the user can drag straight back" — drag did not exist
 * then, and recoverable is not the same as not destroyed. 2b's objection to
 * carving was that repeated splits hand each new pane a sliver of a sliver;
 * that is answered by the floor, which makes `splitActive` refuse such a
 * split before it is sent.
 *
 * The `tombstones` half of that is Paolo's ruling, and it lands on `shareOf`'s
 * `at === -1` branch — the fallback is made correct, not removed, which is why
 * the unremembered paragraph above still describes real behaviour. With a
 * remembered kid in play the WHOLE-TAB vector this builds sums to 1 by
 * construction rather than by a rescale: `sharesAroundClaims` divides the
 * bases among themselves and scales them into `1 - held`. Not in every case,
 * though — when the claims themselves reach 1 that function falls back to
 * normalising the lot, and there the normalisation is load-bearing again.
 * Whether `forgetTab`'s own arithmetic keeps one tab's claims strictly below 1
 * is not proved anywhere in this file — see `claimForDeath`'s own doc for
 * where that induction breaks, at the step where a share is exactly 1, the
 * sole survivor of its row dying. The guard is what makes this function safe
 * regardless, without depending on that bound.
 *
 * That whole-tab vector is not what this function returns, though not for the
 * reason a first read suggests: `kids` here is the row about to be WRITTEN,
 * which may hold back a tombstone this carve does not name at all — see
 * `inLiveFrame`, which projects the vector above onto the panes `kids` names
 * before it comes back.
 *
 * Exported and pure — no `store`, no `manager`, nothing captured from
 * `registerIpc`'s closure — so the case above can be pinned in
 * `tests/unit/carveRatio.test.ts` without a real tmux session anywhere near
 * it, the way the integration test that exercises the real "which sibling is
 * unclaimed" detection cannot afford to for every case.
 */
export function carveRatio(params: {
  /** The tab this carve is happening in — what a claim is a fraction OF. */
  tabId: string
  kids: string[]
  sourcePaneId: string
  newPaneId: string
  siblings: string[]
  savedKids: string[]
  savedRatio: number[]
  /**
   * Every claim recorded so far, across every tab — this file's outer
   * `tombstones` map, read here through `claimFor` (for a sibling the saved
   * row does not know) and `tombstonesOf` (for a pane of THIS tab that `kids`
   * does not name at all, a tombstone still on screen). Both filter on
   * `tabId` before ever reading `share` — see `shares.ts`'s `Claim`.
   */
  tombstones?: ReadonlyMap<string, Claim>
}): number[] {
  const { tabId, kids, sourcePaneId, newPaneId, siblings, savedKids, savedRatio, tombstones } = params
  const claims = tombstones ?? new Map()
  const sourceAt = siblings.indexOf(sourcePaneId)
  // A `base` is a share relative to the other saved-derived shares; a `claim`
  // is a share of the whole tab. `sharesAroundClaims` is what makes the
  // difference count — see its doc comment for the ruling and for why, with no
  // claim in play, it is arithmetically the rescale this used to do inline.
  const shareOf = (id: string): { claim?: number; base: number } => {
    const at = savedKids.indexOf(id)
    if (at !== -1) return { base: savedRatio[at] ?? 1 / siblings.length }
    const claim = claimFor(tabId, id, claims)
    return claim === undefined ? { base: 1 / siblings.length } : { claim, base: claim }
  }
  const source = sourceAt === -1 ? { base: 1 / kids.length } : shareOf(sourcePaneId)
  // The halving carries the claim with it rather than demoting both halves to
  // bases. Splitting a restarted pane divides the share IT is remembered at
  // between it and the pane carved out of it — which is what a carve means —
  // and leaves the panes the user did not touch scaling into the rest. Demoted
  // instead, the two halves would be renormalised against the saved kids and
  // the pair would come out narrower than the one pane it replaced, which is
  // the same collapse this task exists to stop, one split later.
  const halved = {
    claim: source.claim === undefined ? undefined : source.claim / 2,
    base: source.base / 2,
  }
  // The whole tab: the kids this row will name, plus every pane of this tab
  // that a claim is still owed to and that this row does NOT name. The second
  // group is what `sharesAroundClaims` was never given before, which is why
  // the vector it produced described a tab larger than the row it went into.
  const dead = tombstonesOf(tabId, kids, claims)
  const whole = sharesAroundClaims([
    ...kids.map((kid) => (kid === newPaneId || kid === sourcePaneId ? halved : shareOf(kid))),
    ...dead.map((entry) => ({ claim: entry.share, base: entry.share })),
  ])
  // Appended above, selected by id here: see `inLiveFrame`.
  return inLiveFrame(whole, [...kids, ...dead.map((entry) => entry.id)], kids)
}

/**
 * What a pane's death is worth, as a fraction of the WHOLE tab — never of
 * what the row already reads it as, which after any earlier death in the same
 * tab is smaller than the pane's true share. Exported and pure, mirroring
 * `carveRatio` and `sharesAroundClaims` — this file's established shape for
 * main-side arithmetic that has no business needing a real tmux session to
 * test, and the reason this was pulled out of `forgetTab`'s closure.
 *
 * `store.read()` rescales every ratio by its own total on the way in, and a
 * dead pane's kid entry is dropped on the way in too — so after one death the
 * row describes the tab AS IF that pane does not exist, and its shares are
 * fractions of `1 - that pane's claim`, not of the whole tab. Measured, three
 * panes at 0.5/0.3/0.2: kill the 0.2 and the row reads 0.625/0.375, so the
 * pane that truly holds 0.3 of the tab would be recorded at 0.375 and come
 * back a quarter wider than it died, out of panes the user never touched.
 * Silent, too — the vector still sums to 1.
 *
 * Scaling by the room the other claims have already taken converts back:
 * 0.375 x (1 - 0.2) = 0.3, exactly what it died at. A claim is defined as a
 * fraction of the whole tab (see `sharesAroundClaims`), and this is what
 * makes the recorded value one — for a SECOND death, once the first one's
 * claim is still unspent. The two-death case is what `taken` exists for.
 *
 * **`taken` here and `sharesAroundClaims`'s `held`, as `carveRatio`/`tabRowFor`
 * now feed it, read the same PREDICATE — `tombstonesOf` — and, as of this
 * task, the same INPUT too.** Both ask which claims recorded for a tab are
 * unspent, given a row: `taken` asks it of `kids`, the row as it stood the
 * instant this pane died, so a pane that is STILL a tombstone counts, because
 * nothing has rebuilt the row since it died. `held` is asked the same
 * question of the row a split or a close is about to WRITE — a different
 * moment, but no longer a different question, because `carveRatio`/`tabRowFor`
 * now call `tombstonesOf` themselves before they ever call `sharesAroundClaims`,
 * and append an entry for every tombstone it names to the row's own kids.
 * Concrete case: tab A/B/C dies in order B then C, B never restarted, C
 * restarted before the next split. This function correctly discounts B's
 * claim out of C's (see the two-death test in `claimForDeath.test.ts`), and
 * the row a later split rebuilds now holds B's share back too, rather than
 * dividing the WHOLE tab among A/C/the new pane and leaving B's share for
 * nobody to reserve — see `inLiveFrame` in `shares.ts` for the conversion
 * that makes the row actually WRITTEN describe only the panes it names. The
 * renderer's own `withKeptPanes` still reserves a tombstone's share
 * independently of this file — the two sides are known to agree on the
 * arithmetic and not yet on the input they give it (see `sharesAroundClaims`'s
 * doc in `shares.ts`) — but that is the renderer's half of a gap this task
 * closes only on main's side, between this function and the two row builders.
 *
 * `!kids.includes` skips a claim that has been SPENT: once a split or a close
 * has written a restarted pane back into the row, the row accounts for it
 * again and `sharesAroundClaims` never reads its claim.
 *
 * Guarded, but not because the arithmetic proves the guard can never fire —
 * that argument does not hold. Each claim is `share x (1 - taken)` with
 * `share <= 1`; after `n` claims the cumulative total is
 * `1 - product(1 - share_i)`, which reaches exactly 1, not merely approaches
 * it, the moment any single `share_i` is exactly 1 — the sole survivor of its
 * row dying. What actually keeps a LATER read safe is not this function: it
 * is `sharesAroundClaims`'s own `room > 0` guard, which falls back to
 * renormalising the lot whenever the claims it is handed already reach 1, so
 * every share it returns stays positive and the row it builds still sums to
 * 1. The `room <= 0` branch below is the same fallback, for the same reason:
 * there is no whole tab left to take a fraction of, so recording the row's
 * own share is the honest answer.
 */
export function claimForDeath(params: {
  /** The dying pane's own share, as the row it died in describes it. */
  share: number
  /** The tab id `share` was recorded against — `row.id` at the call site. */
  tabId: string
  /** The row's current kids, so a spent claim is excluded from `taken`. */
  kids: string[]
  /** Every claim recorded so far, across every tab. */
  tombstones: ReadonlyMap<string, Claim>
}): number {
  const { share, tabId, kids, tombstones } = params
  // The same reader the row builders use, so "what this death must be
  // discounted by" and "what a rebuilt row does not account for" cannot drift
  // into two predicates again. See `tombstonesOf`.
  const taken = tombstonesOf(tabId, kids, tombstones).reduce((sum, entry) => sum + entry.share, 0)
  const room = 1 - taken
  return room > 0 ? share * room : share
}

/**
 * Every browser pane `sessionPaneId` owned, released, mutating `agentSessions`
 * in place.
 *
 * Pulled out of `registerIpc`'s closure so it is testable on its own, the same
 * reason `carveRatio` and `claimForDeath` are above it: this file's own two
 * call sites hand it their outer `agentSessions` map, exactly as they hand
 * `tombstones` to those two.
 *
 * Only the map entry goes. No browser pane is closed, moved, or written to
 * `store` by this call — that is the whole point of it: the agent's own pane
 * can disappear without taking its confined browser pane along, because
 * nothing here reaches the pane itself, only the association with the
 * session that is gone.
 */
export function releaseAgentSession(agentSessions: Map<string, string>, sessionPaneId: string): void {
  for (const [browserPaneId, owner] of agentSessions) {
    if (owner === sessionPaneId) agentSessions.delete(browserPaneId)
  }
}

export function registerIpc(
  manager: SessionManager,
  getWindow: () => BrowserWindow | null,
  registry: StatusRegistry,
  store: ConfigStore = new ConfigStore(ConfigStore.defaultPath()),
  // Told rather than asked: `register.ts` is constructed by `index.ts`, and an
  // import back the other way to reach `setAttendedTab` directly would be a
  // cycle. A no-op default keeps every existing caller — and every test —
  // working unchanged.
  onActiveTabChanged: (id: string | null) => void = () => undefined,
  // Same reasoning as `onActiveTabChanged`: `NotificationRouter` lives in
  // `index.ts`, and this is only ever called after a spool replay (silent by
  // design — see `CHANNELS.restore` below) so the dock badge does not sit
  // stale until some unrelated tab's next transition happens to refresh it.
  refreshBadge: () => void = () => undefined,
): void {
  // The saved pane list means "reattach these next launch", which is not the
  // same set as "clients attached right now" — a detached pane must stay in it.
  // So every mutation reads, edits and rewrites rather than dumping the
  // manager's registry. The file is tiny; serialising the edits is enough to
  // keep concurrent read-modify-writes from losing one another.
  //
  // Existence lives in `config.panes` and layout in `config.tabs`, and the two
  // are not interchangeable: since v5 a tab row is an axis and its ratios and
  // holds none of the fields a session is reattached from. A handler that
  // reaches for the wrong one type-checks perfectly — a `TabRow` has an `id`
  // too — which is why that is written down here rather than left to be
  // noticed. Every handler that only opens or forgets a pane therefore works in
  // `config.panes` alone. Two below do not: `splitPane` and `closePane` change
  // what a tab HOLDS, and write both arrays in one `store.write` so no reader
  // ever sees a pane no tab lists or a kid naming no pane. `CHANNELS.restore`
  // is the third writer of `config.tabs` and the one that is easy to miss —
  // it does not write the file itself, it hands `serialise` to
  // `restoreWorkspace`, which rebuilds every row from live tmux and writes them
  // with the panes inside this same queue.
  let tail: Promise<unknown> = Promise.resolve()
  const serialise = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation)
    tail = result.catch(() => undefined)
    return result
  }

  const rememberTab = (tab: TabDescriptor): Promise<void> =>
    serialise(async () => {
      const config = await store.read()
      const panes = config.panes.filter((saved) => saved.id !== tab.id)
      panes.push(tab)
      await store.write({ ...config, panes })
    })

  const forgetTab = (id: string): Promise<void> =>
    serialise(async () => {
      const config = await store.read()
      // Captured here, before the row goes and inside this same pass, so there
      // is no window in which the share is gone but unrecorded — and no second
      // read, since this one is already open. The kid is still in the row at
      // this moment: `normaliseLayout` drops a kid only once its pane row has
      // gone, and this pane's row is still in the config that was just read —
      // the `filter` below is what takes it out.
      const row = config.tabs.find((candidate) => candidate.layout.kids.includes(id))
      const at = row ? row.layout.kids.indexOf(id) : -1
      const share = row && at !== -1 ? row.layout.ratio[at] : undefined
      if (row && share !== undefined) {
        // `claimForDeath` owns the taken/room/claim arithmetic — see its own
        // doc for what `taken` actually is, the known gap between it and
        // `sharesAroundClaims`'s `held`, and why the `room <= 0` fallback is
        // not provable unreachable by induction.
        //
        // This call excludes `id`'s own entry from an earlier death — which
        // the `set` below is about to replace — without a `paneId !== id` of
        // its own: `row` was FOUND by `row.layout.kids.includes(id)`, so `id`
        // is always a member of `kids` here, and `claimForDeath`'s own
        // `!kids.includes` skips it for free. A second condition here would
        // read like a guard and never decide anything.
        const claim = claimForDeath({ share, tabId: row.id, kids: row.layout.kids, tombstones })
        // Positive, always — `normaliseLayout` refuses any share that is not,
        // and `sharesAroundClaims` reads a claim of 0 as a claim, not as an
        // absence, which would be a 0%-wide box. Asserted here, at the only
        // writer, rather than defended for a second time at the reader.
        if (claim > 0) tombstones.set(id, { tabId: row.id, share: claim })
      }
      // The pane row, not the tab row. Removing the tab row instead would
      // leave the pane on disk for good — and would type-check, because a
      // `TabRow` has an `id` too. Any layout entry left pointing at this pane
      // is collected by the next `read()`; see `normaliseLayout`.
      const panes = config.panes.filter((saved) => saved.id !== id)
      if (panes.length === config.panes.length) return
      await store.write({ ...config, panes })
    })

  /**
   * `tabs` with the row for `tabId` replaced by `next`, or dropped when `next`
   * is null.
   *
   * Keyed by `TabRow.id` — the tab's permanent identity, and the id every
   * caller here holds, since that is what `SessionManager` records per pane.
   * Never by `groupId`: a re-founding changes which group a tab is in and
   * changes nothing about which row is that tab's, and this is the helper the
   * new group id is written through.
   *
   * Both callers rewrite exactly one row and must leave every other one
   * untouched, and a tab whose last pane has closed has to lose its row rather
   * than keep an empty one — `store.read()` would drop such a row on the way
   * back in anyway, but only after it had been written, which is precisely
   * where an assertion could no longer see it.
   *
   * Replaced in place, never removed-and-appended: array order is the order the
   * tab bar draws, so splitting a pane in the third tab must not move that tab
   * to the end. A row that is not there yet is appended, which is the ordinary
   * case for the first split of a tab opened this run — `CHANNELS.open` writes
   * a pane row and no tab row.
   *
   * Free of `serialise`, `store` and the manager on purpose: the caller is
   * already inside one pass holding one `config`, and this only rearranges what
   * it holds.
   */
  const withTabRow = (tabs: TabRow[], tabId: string, next: TabRow | null): TabRow[] => {
    const at = tabs.findIndex((row) => row.id === tabId)
    if (at === -1) return next ? [...tabs, next] : tabs
    if (!next) return tabs.filter((_, index) => index !== at)
    return tabs.map((row, index) => (index === at ? next : row))
  }

  /** This tab's panes, in the order its row lays them out. */
  const held = (panes: PaneRecord[], kids: string[]): PaneRecord[] => {
    const byId = new Map(panes.map((pane) => [pane.id, pane]))
    // Filtered rather than mapped: every caller builds `kids` from ids that
    // are in `panes` by construction, so nothing is dropped here today. A
    // `map` would answer a future mismatch with an `undefined` in the array
    // that type-checks as a `PaneRecord` and reaches the renderer as one.
    return kids.flatMap((kid) => {
      const pane = byId.get(kid)
      return pane ? [pane] : []
    })
  }

  // Keyed to the three channels this file actually pushes unprompted, rather
  // than left as `(channel: string, payload: unknown)`: `unknown` is exactly
  // what let `CHANNELS.exit`'s payload go out missing `reason` for as long as
  // it did — `tsc` has no payload shape to check an omission against. A
  // per-channel map turns dropping a field back into a compile error.
  type SentPayloads = {
    [CHANNELS.data]: DataEvent
    [CHANNELS.exit]: ExitEvent
    [CHANNELS.statusChanged]: StatusEvent
  }

  const send = <C extends keyof SentPayloads>(channel: C, payload: SentPayloads[C]): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
  }

  // `SessionManager.kill()` detaches the local client — which fires the exit
  // event below — before it even knows whether `TmuxAdapter.killSession()`
  // will succeed, and killing the local client is quicker than spawning tmux
  // to destroy the session. So the exit event routinely arrives while the
  // kill is still in flight, and asking tmux fresh at that moment mostly asks
  // a question that hasn't been answered yet: a kill that would go on to
  // succeed can just as well be caught still looking alive. Recording the
  // in-flight kill here lets the exit event wait on the one query that
  // actually settles the question, instead of racing a second one against it.
  const pendingKills = new Map<string, Promise<void>>()

  // The size each tab's client last reported.
  //
  // Restart is a new attach path, and every new attach path in this codebase
  // has shipped with the same defect: attach at the 80×24 default and tmux,
  // seeing its only client, resizes the window down and SIGWINCHes whatever is
  // inside — permanently reflowing the user's scrollback. The manager keeps
  // geometry on its `Entry`, but the entry is deleted when the session dies,
  // which is precisely when Restart needs it. So it is remembered here too.
  const lastGeometry = new Map<string, { cols: number; rows: number }>()

  /**
   * The share each pane held when it died, as a fraction of the WHOLE tab,
   * with the tab it died in — and is still owed, until a rebuild spends it.
   *
   * The tab id is not bookkeeping: it is what makes the share a whole-tab
   * fraction in the first place. See `forgetTab`, which is the only writer.
   *
   * The third map of a shape that is already here twice — `lastGeometry`
   * above is process-lifetime, keyed by pane id, written at death, read at
   * restart, and dropped by the same two handlers; this inherits that
   * contract rather than inventing one, which is also why it is not
   * persisted: restore prunes dead panes at launch, so a saved share would
   * never have a pane to apply to. `SessionManager.tabWasIn` is the other
   * half of this same concept — see `shares.ts`'s `Claim`, which is where
   * that pairing is written down.
   *
   * One difference, stated rather than glossed: the other two are read by the
   * restart itself, and this one is not read until main next REBUILDS the
   * tab's row — a split or a close, which may be minutes later or never.
   *
   * The renderer keeps a tombstone's share on screen by itself (see
   * `withKeptPanes`), so this is not what the user is looking at. It is what
   * main needs the moment it rebuilds the tab's row — at which point the
   * restarted pane is a kid the saved row never knew, and the even fallback
   * would flatten a ratio that survived both the death and the restart.
   *
   * Never consulted for a kid the saved row DOES know: once a split or a close
   * has written the restarted pane back into the row, the row is the authority
   * again and this entry is simply never read. That is why nothing deletes it
   * at restart — a stale entry cannot outvote a live row, and deleting it there
   * would break the contract the two maps above keep.
   */
  const tombstones = new Map<string, Claim>()

  /**
   * Which agent session, if any, owns a browser pane right now: browser pane
   * id to the id of the `claude` pane whose MCP tool call created it. This is
   * `agentSessionId` on `TabDescriptor` (`shared/ipc.ts`) — the field
   * `browserPaneFor` (`mcp/route.ts`) reads to keep an agent confined to its
   * own browser pane and out of one the user opened by hand.
   *
   * Deliberately never reaches `store.write`: every `PaneRecord` this file
   * builds for a browser pane is written to config with no `agentSessionId`
   * field at all, so this map is the field's only home. That is on purpose,
   * not an oversight to fix later. The flag means "an agent can act on this
   * pane right now", and after a relaunch no agent can — the session is gone
   * and the MCP bridge's socket is new — so persisting it would restore a
   * confined, stripped browser pane owned by nobody. Process-lifetime, like
   * `pendingKills` and `lastGeometry` above: empty at every launch, and a
   * browser pane an agent owned in a previous run comes back as an ordinary
   * one.
   *
   * Released by `releaseAgentSession`, called below wherever a pane leaves
   * the workspace for good — the same two call sites that already call
   * `registry.forget` for the same reason. Nothing sets an entry yet: the
   * tool call that creates an agent-owned browser pane is later work, and
   * this map is the association it will populate.
   */
  const agentSessions = new Map<string, string>()

  registry.onTransition(({ tabId, to }) => {
    // `sinceOf` read here rather than carried on the transition: the registry
    // has already written it by the time listeners run, and reading it keeps
    // one source for the clock instead of two that could disagree.
    const payload: StatusEvent = { tabId, state: to, since: registry.sinceOf(tabId) }
    send(CHANNELS.statusChanged, payload)
  })

  ipcMain.handle(CHANNELS.status, () => registry.snapshot())
  ipcMain.handle(CHANNELS.statusSince, () => registry.sinceSnapshot())

  /**
   * Whether the tmux session outlived the client that just stopped.
   *
   * `detached` is how a session survives on purpose, so that one answers
   * itself. `killed` is answered by the kill already in flight for it, via
   * `pendingKills`, when there is one to ask. `exited` — and a `killed` with
   * no pending kill on record, which should not happen but must still get a
   * real answer rather than an assumed one — asks tmux directly.
   *
   * `record` is always a `TerminalPaneRecord`: the only caller is
   * `manager.onExit`, and an exit event only ever fires for a pane
   * `SessionManager` itself holds, which is always a terminal.
   */
  const sessionSurvived = async (record: TerminalPaneRecord, reason: ExitReason): Promise<boolean> => {
    if (reason === 'detached') return true
    const pending = reason === 'killed' ? pendingKills.get(record.id) : undefined
    if (pending) {
      // `manager.kill()` resolving means `killSession()` succeeded: dead.
      // `killSession()` only throws once it has verified the session is
      // still there (or the verification itself failed, which the shared
      // catch below already treats as "alive" — the safe default).
      try {
        await pending
        return false
      } catch {
        return true
      }
    }
    try {
      return await manager.hasSession(record.tmuxSession)
    } catch {
      // Could not find out. Answering "alive" keeps a stale row and a stale
      // tab, which costs a line of config and a click; answering "dead" for a
      // live session loses it.
      return true
    }
  }

  manager.onData((id, data) => send(CHANNELS.data, { id, data }))
  manager.onExit((record, code, reason) => {
    // The renderer needs the answer to travel with the event: it draws the
    // tabs, and a tab whose session is still running must stay in the bar.
    // That makes the send wait on the kill (or on tmux) in the `killed` and
    // `exited` cases — a genuine death still reaches the renderer, one round
    // trip later.
    void (async () => {
      const sessionAlive = await sessionSurvived(record, reason)
      send(CHANNELS.exit, { id: record.id, code, sessionAlive, reason })
      if (!sessionAlive) {
        // Stamped ahead of `forgetTab` below, and carrying `record` with it.
        // `forgetTab` deletes the saved config row, and by the time a
        // listener as far away as the notification router tries to
        // rediscover this tab from its id alone, both the live manager entry
        // (already gone — `manager.ts` deleted it before this callback even
        // ran) and the saved row can be gone too, resolving to nothing and
        // leaving `crashed`/`ended` the only two states that could never
        // toast. Passing `record` sidesteps that race outright rather than
        // betting on read/write ordering across two independent config-file
        // operations. `killed` is exempted for the same reason it always
        // was: the CHANNELS.closePane handler below calls `registry.forget`
        // once its own await on the very same `manager.kill()` promise
        // settles, and recording a tombstone here too would race that forget
        // with no ordering guarantee — whichever runs last wins, and a losing
        // `forget` would leak a `crashed`/`ended` entry nothing would ever
        // clean up. A kill the user asked for does not need a tombstone —
        // they already know it is gone.
        if (reason !== 'killed') registry.applyExit(record.id, code, record)
        // `killed` is never pruned here either, for the same reason: the
        // CHANNELS.closePane handler already owns that, and drops the pane's
        // config row inside the same pass that rewrites its tab, once the
        // `manager.kill()` this resolved against has succeeded — pruning here
        // too would only be a redundant second write of the same outcome.
        if (reason === 'exited') await forgetTab(record.id)
      }
    })()
  })

  ipcMain.handle(CHANNELS.open, async (_event, request: OpenRequest): Promise<TabDescriptor> => {
    // node-pty does not throw on a missing cwd — it yields a live process that
    // produces nothing, so the tab renders permanently blank while its tmux
    // session is perfectly fine. Say what is actually wrong instead.
    if (!(await isDirectory(request.cwd))) {
      throw new Error(`Cannot open a terminal: ${request.cwd} is not a directory`)
    }
    const record = manager.open(request)
    await rememberTab(record)
    registry.applyOpen(record.id, record.type)
    return record
  })

  ipcMain.handle(CHANNELS.list, (): TabDescriptor[] => manager.list())

  // The reconcile reads and then writes, so it has to hold the queue for the
  // whole operation rather than racing an `open` or an exit between the two.
  ipcMain.handle(CHANNELS.restore, async (): Promise<RestoreResult> => {
    const result = await restoreWorkspace(manager, store, serialise)
    // restoreWorkspace reattaches every tab through `manager.open` directly,
    // never through the CHANNELS.open handler above — so nothing else ever
    // gives a restored tab an initial state. Left alone, a relaunched
    // `claude` tab would show no dot at all rather than the hollow `unknown`
    // one deserves, indistinguishable from a shell nothing has run in.
    //
    // Restore is also how a mid-session renderer reload (⌘R) re-fetches the
    // workspace, and by then the registry already knows real states from
    // hook events main never stopped receiving. Only a tab the registry has
    // never seen gets initialised here — that is what keeps ⌘R from
    // stamping a live `waiting`/`thinking` tab back to `unknown`.
    //
    // Per pane, not per tab row: status is tracked by tab id, which since v5
    // is a pane's own id (a group's founder id for a split tab, but every
    // pane still has one), and `result.tabs` holds layout — axis and ratios —
    // not the ids this loop needs.
    for (const pane of result.panes) {
      if (registry.get(pane.id) === null) registry.applyOpen(pane.id, pane.type)
    }

    // Whatever the hook script spooled while nothing was listening — a
    // socket write that failed because the app was down. Run only now,
    // after the reconcile above has decided which tabs actually survived:
    // an event for a tab tmux no longer has must not resurrect a dot for a
    // session that is gone. A second `restore` in one run (⌘R) costs
    // nothing extra — the spool file drainSpool already took is gone.
    //
    // Applied silently: replaying describes a past, and routing each one to
    // the notification router the way a live transition is would toast the
    // whole weekend back at the user in a tight loop the moment the app
    // opens. `refreshBadge` below still catches the badge up in one shot
    // once the final state is in, rather than leaving it stale until some
    // unrelated tab's next live transition happens to correct it.
    //
    // Per pane again: a spooled hook message names the pane's own
    // `PTERM_TAB_ID`, never a tab row's group id.
    const live = new Set(result.panes.map((pane) => pane.id))
    const spooled = await drainSpool(hookPaths().spool, Date.now())
    for (const message of spooled) {
      if (!live.has(message.tabId)) continue
      // A spooled death is never replayed. A tab that died while the app was
      // down has no session left, so reconcile has already pruned its row and
      // the membership check above drops the line anyway — which makes this
      // branch unreachable in every case that can actually happen, and the
      // only cases it *could* reach are ones where replaying would be wrong:
      // an id reopened since would be painted red for a life that already
      // ended, and `applyDead`'s verdict would then outrank how the new one
      // really ends. Silence is the same answer in the reachable case and the
      // safe one in the rest.
      if (message.event === 'Exit') continue
      registry.applyHook(message, { silent: true })
    }
    refreshBadge()

    // Folded into the same response rather than left for the renderer's own,
    // separate `status()` call: that call raced this whole reconcile — which
    // takes seconds at twelve tabs — with no ordering guarantee, and the
    // renderer's `restored` case resets `status` to `{}`, so the direction
    // that loses blanks the board at every launch. One response has nothing
    // left to race against.
    return { ...result, status: registry.snapshot() }
  })

  /**
   * The project list a mutation answers with — Unsorted included.
   *
   * Restore is the only other place that builds this, and it builds it the same
   * way, so a mutation and a relaunch cannot disagree. Skipping the Unsorted row
   * here would mean a removed project's still-running sessions dropped off the
   * screen until the next launch, which is the opposite of leaving them alive
   * and reachable.
   *
   * The pane set is config's, not the manager's. A detached tab stays in the tab
   * bar — its session is running and only its client is gone — so describing
   * against live clients alone would drop the Unsorted row such a tab needs.
   * Every caller below runs inside the write queue, where config's pane list is a
   * superset of the manager's: an `open` records its pane through the same queue
   * before anything else can read it.
   *
   * Panes, because `describeProjects` resolves each project's `activeTabId`
   * against the rows it is given and has always been given pane rows — see the
   * ambiguity recorded on `ProjectRecord.activeTabId`.
   */
  const described = async (config: PTermConfig): Promise<ProjectDescriptor[]> =>
    withUnsorted(await describeProjects(config.projects, config.panes), config.panes)

  ipcMain.on(CHANNELS.setActive, (_event, id: string | null) => {
    // Read directly, never through `serialise`: the queue has no reentrancy
    // protection, and this callback is what the router's `isAttended` reads
    // on every transition. Anything downstream of it calling back into
    // `serialise` would deadlock the queue silently.
    onActiveTabChanged(id)
    void serialise(async () => {
      if (id === null) return
      const config = await store.read()
      // A pane row: this writes the id back to `ProjectRecord.activeTabId`,
      // which `describeProjects` resolves against pane rows. v5 leaves that
      // pairing exactly as it was rather than moving one end of it — see the
      // ambiguity recorded on `ProjectRecord.activeTabId`.
      const tab = config.panes.find((saved) => saved.id === id)
      if (!tab) return
      const owner = projectForSlug(config, tab.projectSlug)
      // A tab under Unsorted has no row to record this on, by design.
      if (!owner) return
      await store.write({
        ...config,
        projects: config.projects.map((project) =>
          project.id === owner.id ? { ...project, activeTabId: id } : project,
        ),
      })
    })
  })

  ipcMain.on(CHANNELS.setActiveBrowser, (_event, id: string | null) => {
    // Persistence only: unlike `setActive` above, this never calls
    // `onActiveTabChanged`. That callback is what the status router reads to
    // decide whether a pane is attended, and a browser pane sitting beside a
    // terminal is on screen whenever the terminal is, whether or not it is
    // this project's selected browser tab, so its selection carries no
    // attended/unattended meaning for the router to read.
    void serialise(async () => {
      if (id === null) return
      const config = await store.read()
      const tab = config.panes.find((saved) => saved.id === id)
      if (!tab || regionOf(tab) !== 'browser') return
      const owner = projectForSlug(config, tab.projectSlug)
      if (!owner) return
      await store.write({
        ...config,
        projects: config.projects.map((project) =>
          project.id === owner.id ? { ...project, activeBrowserTabId: id } : project,
        ),
      })
    })
  })

  ipcMain.on(CHANNELS.setActiveProject, (_event, id: string | null) => {
    void serialise(async () => {
      const config = await store.read()
      await store.write({ ...config, activeProjectId: id })
    })
  })

  /**
   * Write a dragged ratio down, once, when the pointer comes up.
   *
   * `ipcMain.on`, not `handle`: the renderer already has the layout on
   * screen — it dispatched `resized` into `state.tabs` on every frame of the
   * gesture, and `paneGroups` has been drawing from that the whole time. This
   * handler exists only so the NEXT launch agrees, so there is nothing here
   * worth a round trip or a rejection the caller would have to do anything
   * with. A failed write costs a ratio, not a session.
   *
   * Sent once, on release, by `App.tsx`'s `commitLayout` — never per frame.
   * `state.tabs` is where a gesture's ratios live while it runs precisely so
   * that no push path from the renderer to here exists during a drag; adding
   * one now would put several writes a second through a queue this same file
   * shares with restore and the exit handler.
   *
   * A row for a tab this handler has no saved layout for is not invented: a
   * missing `saved` means either a tab younger than this run's last read (its
   * row comes from `CHANNELS.splitPane`, not from here) or one `store.read()`
   * has already dropped for naming no live pane in its kids. Guessing a row
   * into existence from a ratio alone would be inventing membership, which is
   * exactly the thing `withTabRow` exists to never do implicitly.
   *
   * The shares arrive named, not positional, and `layoutWrite` — `shares.ts` —
   * is where they are routed: every share for a pane `saved.layout.kids`
   * names goes in the row, scaled into that row's own frame the same way a
   * split scales one; every other share has to name a pane this tab already
   * owes a claim to, and becomes that claim's new, current value. A message
   * naming a pane that is neither is refused whole, logged below, and nothing
   * is written — the alternative, pairing what can be placed and dropping the
   * rest, would leave the row in one frame and the claims in another, and a
   * short ratio paired with the row's kids is worse still: `normaliseLayout`
   * reads a ratio shorter than its kids as unusable and flattens the whole tab
   * to an even split. The invariant this used to lean on — that the
   * renderer's kids are always a superset of main's, so equal length implies
   * equal membership — is no longer load-bearing: every share now carries the
   * pane it belongs to, so nothing here depends on position at all.
   *
   * Writes `config.tabs` and nothing else. Layout, never existence: a ratio
   * has no business touching `config.panes`, and the "leaves the panes alone"
   * test exists to catch a handler that reaches for it anyway.
   */
  ipcMain.on(CHANNELS.setLayout, (_event, tabId: string, shares: Record<string, number>) => {
    void serialise(async () => {
      const config = await store.read()
      const saved = config.tabs.find((row) => row.id === tabId)
      if (!saved) return
      const routed = layoutWrite(saved, shares, tabId, tombstones)
      if (!routed.ok) {
        console.warn(`pTerm: ignored a layout for ${tabId} — ${routed.why}`)
        return
      }
      // The renderer wins on a tombstone's share, and only here: it is what the
      // user is looking at and what they just dragged. Main's record is
      // corrected by every commit rather than defended against one. An
      // in-memory write, so this adds no new path back into `serialise`.
      for (const entry of routed.owed) {
        tombstones.set(entry.id, { tabId, share: entry.share })
      }
      const tabs = withTabRow(config.tabs, tabId, routed.row)
      await store.write({ ...config, tabs })
    })
  })

  ipcMain.handle(CHANNELS.addProject, (_event, input: { name: string; cwd: string }) =>
    serialise(async () => {
      const { config } = addProject(await store.read(), input)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(
    CHANNELS.updateProject,
    (_event, id: string, patch: { name?: string; presets?: Preset[] }) =>
      serialise(async () => {
        const config = updateProject(await store.read(), id, patch)
        await store.write(config)
        return described(config)
      }),
  )

  ipcMain.handle(CHANNELS.removeProject, (_event, id: string) =>
    serialise(async () => {
      // The project's sessions keep running. They stop matching a project and
      // surface under Unsorted, so nothing is stranded and nothing is killed.
      const config = removeProject(await store.read(), id)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(CHANNELS.reorderProjects, (_event, ids: string[]) =>
    serialise(async () => {
      const config = reorderProjects(await store.read(), ids)
      await store.write(config)
      return described(config)
    }),
  )

  ipcMain.handle(CHANNELS.scanCandidates, async (): Promise<Candidate[]> => {
    const config = await store.read()
    return scanCandidates(config.projects.map((project) => project.cwd))
  })

  ipcMain.handle(CHANNELS.pickFolder, async (): Promise<string | null> => {
    const window = getWindow()
    const result = window
      ? await dialog.showOpenDialog(window, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle(CHANNELS.moveTabToProject, (_event, tabId: string, projectId: string) =>
    serialise(async () => {
      const config = await store.read()
      const target = config.projects.find((project) => project.id === projectId)
      if (!target) throw new Error(`moveTabToProject: no project ${projectId}`)

      // Every pane of the tab, or none of them. A pane's project membership
      // lives in its own member session name, so moving the founder alone
      // would leave the tab split across two projects; `moveTabToProject`
      // renames every member and rolls the lot back if any rename is refused.
      //
      // The saved rows go along because a pane whose client has gone is
      // resolved through tmux, which synthesises a cwd and knows no command at
      // all; config holds the real ones. The map is keyed by pane id over the
      // whole of `config.panes` rather than over this tab's rows alone: the
      // callee looks up only the panes it actually moves, so the other entries
      // cost a lookup that never happens, and narrowing it by the tab's layout
      // row would drop the truth for a pane whose row is on disk but whose tab
      // row — layout only, and dropped by `read()` whenever it stops
      // describing panes that exist — is not.
      const known = new Map<string, Pick<PaneRecord, 'cwd' | 'command' | 'type'>>(
        config.panes.map((row) => [
          row.id,
          { cwd: row.cwd, command: row.command, type: row.type },
        ]),
      )
      const moved = await manager.moveTabToProject(tabId, target.slug, known)

      // Replace in place where config already lists a pane, so the tab bar
      // keeps its order; append the ones it does not list. A plain `map` would
      // quietly drop the record for a pane config had never written — the
      // invariant that restore always writes one first holds on every path
      // this milestone exercises, but it is an invariant, not a guarantee, and
      // the cost of it failing is a session running under a name nothing on
      // disk knows. This invents nothing: the renames above succeeded, so the
      // sessions are there.
      //
      // The tab's own row is deliberately untouched: it carries layout, and a
      // move changes no pane id, no axis and no ratio.
      //
      // So a tab does not lose its name by being filed into another project:
      // `moved` came out of `manager.moveTabToProject`, which renames tmux
      // sessions and knows nothing of titles. Merged here, above the array
      // that gets written, rather than onto the reply alone: these records
      // REPLACE the saved rows below, so patching only the reply would show
      // the name until the next restore and then lose it for good.
      const merged = attachSavedFields(moved, config.panes)
      const byId = new Map<string, PaneRecord>(merged.map((pane) => [pane.id, pane]))
      const listed = new Set(config.panes.map((row) => row.id))
      const panes = [
        ...config.panes.map((row) => byId.get(row.id) ?? row),
        ...merged.filter((pane) => !listed.has(pane.id)),
      ]
      const updated: PTermConfig = { ...config, panes }
      await store.write(updated)
      return { projects: await described(updated), panes: merged }
    }),
  )

  ipcMain.handle(CHANNELS.renameTab, (_event, id: string, title: string) =>
    serialise(async () => {
      const config = await store.read()
      const trimmed = title.trim()
      const panes = config.panes.map((row) =>
        row.id === id
          ? // An empty name is how a title is removed, so it is stored as
            // absent rather than as "": one representation on disk, and
            // `tabLabel` never has to decide between them.
            { ...row, title: trimmed === '' ? undefined : trimmed }
          : row,
      )
      await store.write({ ...config, panes })
      // The saved rows, not `manager.list()`: `panes` is the state that was
      // just persisted, rather than a second, separate derivation of it, and
      // it already carries the title just written, so no `attachSavedFields` call
      // is needed on this path. (What keeps a dead tab's entry on the bar
      // through a rename is the `panesMerged` reducer's own merge by id, not
      // a property of this reply.)
      return panes
    }),
  )

  ipcMain.handle(CHANNELS.setPaneColor, (_event, id: string, color: PaneColor | null) =>
    serialise(async () => {
      const config = await store.read()
      const panes = config.panes.map((row) =>
        row.id === id
          ? // Null is how a colour is cleared, and the default is stored the
            // same way, so the disk has one spelling of "no colour" rather
            // than two. `PANE_COLOR_DEFAULT` is a real entry in the picker and
            // reaching it must not leave `#09090b` written on the row. See
            // `paneColors.ts`, which is where that rule is stated.
            //
            // Re-validated here even though the renderer can only send one of
            // six: this handler is reachable from any renderer code, and the
            // rule that an unofferable colour never reaches a pane belongs
            // with the write rather than with the widget.
            { ...row, color: color !== null && isPaneColor(color) && color !== PANE_COLOR_DEFAULT ? color : undefined }
          : row,
      )
      await store.write({ ...config, panes })
      // The saved rows, for the reason `renameTab` gives above.
      return panes
    }),
  )

  ipcMain.on(CHANNELS.input, (_event, id: string, data: string) => manager.write(id, data))

  ipcMain.on(CHANNELS.resize, (_event, id: string, cols: number, rows: number) => {
    // Same guard the manager applies, so a rejected size is never remembered
    // as the one a restart should attach at.
    if (cols >= 1 && rows >= 1) lastGeometry.set(id, { cols, rows })
    manager.resize(id, cols, rows)
  })

  // No persistence here: detaching is how a session survives, so forgetting it
  // would be exactly the wrong thing to record.
  ipcMain.on(CHANNELS.detach, (_event, id: string) => manager.detach(id))

  ipcMain.handle(
    CHANNELS.restartTab,
    async (_event, request: RestartRequest): Promise<TabDescriptor> => {
      const { tab } = request
      // Same guard `open` applies: node-pty does not throw on a missing cwd,
      // it yields a live process that produces nothing, so the tab comes back
      // permanently blank while looking fine.
      if (!(await isDirectory(tab.cwd))) {
        throw new Error(`Cannot restart: ${tab.cwd} is not a directory`)
      }
      const remembered = lastGeometry.get(tab.id)
      // `reopenInTab`, not `open`: a pane of a split has to REJOIN its tab's
      // group, and a bare `new-session -A` would bring it back beside the tab
      // instead of in it (finding I4). The manager decides which of the three
      // cases this is — see `reopenInTab`; only the "still has live siblings"
      // one does anything `open` did not.
      //
      // Nothing here says which tab the pane was in, and nothing in the
      // request could: the manager recorded that when the pane was created or
      // adopted. See `SessionManager.tabWasIn` and `RestartRequest`.
      const { record, groupId } = await manager.reopenInTab({
        id: tab.id,
        projectSlug: tab.projectSlug,
        cwd: tab.cwd,
        command: tab.command,
        type: tab.type,
        // The renderer's live measurement first, the last one main saw
        // second. Attaching at neither would let tmux shrink the recreated
        // session to 80×24 — the defect this codebase has now shipped twice.
        cols: request.cols ?? remembered?.cols,
        rows: request.rows ?? remembered?.rows,
      })

      // Which tab this pane came back into. It and `groupId` differ exactly
      // when the tab had no live member left and has re-founded around this
      // pane or an earlier one back: tmux cannot name a group after a session
      // it no longer has, so the group takes the name of whichever pane
      // returned first, while the tab keeps the id it has always had.
      //
      // The group comes back FROM the reopen rather than being asked of tmux
      // after it, and that is not a shortcut: the reopen is what decided it,
      // and on the re-founding path the session it just spawned may not have
      // reached tmux yet — a `list-sessions` in this line reads that as "the
      // tab has no group" and leaves the row pointing at a group that is gone.
      const tabId = manager.tabIdOf(record.id) ?? record.id

      // `rememberTab` would write the pane row and nothing else, and it is a
      // `serialise` wrapper, so the row update could not join it — two passes,
      // with a window in between where the file says this tab is in a group it
      // is not. One pass writes both.
      await serialise(async () => {
        const config = await store.read()
        const panes = [...config.panes.filter((saved) => saved.id !== record.id), record]
        const saved = config.tabs.find((row) => row.id === tabId)
        // Only when there is a row to correct. A tab that died WHOLE has none
        // by now — `forgetTab` dropped each pane row as its pane died, and
        // `store.read()` drops a tab row whose kids have all gone — so nothing
        // is written for it here, and nothing should be: a row naming panes
        // that do not exist is the one thing `normaliseLayout`'s "config
        // supplies layout, never existence" rule forbids. The tab's identity
        // is carried by the manager until the next split or close writes a row
        // under it.
        const tabs =
          saved && saved.groupId !== groupId
            ? withTabRow(config.tabs, tabId, { ...saved, groupId })
            : config.tabs
        await store.write({ ...config, panes, tabs })
      })
      registry.applyOpen(record.id, record.type)
      return record
    },
  )

  ipcMain.on(CHANNELS.dismissTab, (_event, id: string) => {
    // The row is already gone from config — the exit handler forgot it. This
    // drops the state, so the dock badge stops counting a tab nobody can see.
    registry.forget(id)
    // This pane, dismissed, can no longer be anybody's agent session. Any
    // browser pane it owned is released, not closed: see `agentSessions`.
    releaseAgentSession(agentSessions, id)
    lastGeometry.delete(id)
    // Read before the delete, because the record is the only thing left that
    // can say which tab this pane was in and what it held: `forgetTab` dropped
    // its row at its death, and `store.read()` dropped its kid after that. The
    // tab id travels on the claim for exactly this reason.
    const held = tombstones.get(id)
    tombstones.delete(id)
    if (held) {
      // The renderer has just renormalised its row around this pane leaving.
      // Following it here is what keeps the two frames in step until the next
      // rebuild; see `rescaledClaims`. The rescale changes values and never
      // the key set, so writing each entry back is the whole of applying it.
      for (const [paneId, claim] of rescaledClaims(held.tabId, held.share, tombstones)) {
        tombstones.set(paneId, claim)
      }
    }
    // Dismissing the tombstone is what takes Restart off the screen, so the
    // tab id kept for it goes the same way its geometry does — and so does the
    // share it died at, which only a restart could ever have spent.
    manager.forgetPane(id)
  })

  ipcMain.on(CHANNELS.acknowledgeTab, (_event, id: string) => {
    registry.acknowledge(id)
  })

  ipcMain.handle(CHANNELS.splitPane, async (_event, request: SplitRequest): Promise<TabShape> => {
    const { paneId, dir, cols, rows } = request
    // Refused, not defaulted. `splitTab` falls back to 80×24 and then resizes
    // the new window to whatever it settled on, unconditionally — `open()`'s
    // "no size given means do not size the window" guard does not reach it — so
    // an unmeasured split drives a window to the default rather than leaving it
    // to follow its client. Same shape of test as `CHANNELS.resize`'s guard,
    // and written as `>=` rather than `<` so a `NaN` from a renderer that
    // measured a hidden element is refused too.
    if (!(cols >= 1 && rows >= 1)) {
      throw new Error(`Cannot split: pane ${paneId} was not measured (got ${cols}x${rows})`)
    }

    // Outside every `serialise` pass, like `CHANNELS.closePane`'s `manager.kill`:
    // the tmux work first, then one pass of our own. Doing it the other way
    // round would be worse than slow — `serialise` is `tail.then(op, op)` with
    // no reentrancy protection, so anything it reaches that calls back into it
    // waits on its own caller for good.
    const record = await manager.splitTab({ paneId, cols, rows })

    // Read off the NEW pane, after the split, rather than derived a second time
    // from the sibling: this is the id `splitTab` itself decided and recorded
    // for the member it just made, so the row written below cannot be named
    // something the manager disagrees with.
    //
    // The sibling is asked second, and the sibling's own id only third. Nothing
    // can actually reach past the first — `tabIdOf` is the next synchronous
    // statement after the `await` above resolves, and the pty exit callback
    // that disposes an entry is a macrotask, which cannot interleave inside a
    // microtask continuation. But the last fallback is wrong wherever it is
    // reached: `paneId` is the SIBLING's id, and that equals the tab id only
    // when the sibling is the founder. Split from any other pane and it names a
    // tab nothing matches, which loses the layout at the next restore — the
    // failure `tabIdOf`'s own doc warns about. Asking the sibling's entry first
    // costs nothing and is right in both directions.
    const tabId = manager.tabIdOf(record.id) ?? manager.tabIdOf(paneId) ?? paneId
    // The group that tab is in now, which is its own id unless it has
    // re-founded since its panes all died. Asked here rather than taken from
    // the saved row: after a re-founding there IS no saved row, and the row
    // this handler is about to write is the first thing to record the tab's
    // new group. Outside the pass below, like every other tmux call here.
    const groupId = await manager.groupIdOf(tabId)

    // The same initialisation `CHANNELS.open` does, and needed for the same
    // reason: nothing else gives a pane its first state, so a `claude` pane
    // split off a tab would otherwise show no dot at all until its first hook.
    registry.applyOpen(record.id, record.type)

    return serialise(async () => {
      const config = await store.read()
      const panes = [...config.panes.filter((saved) => saved.id !== record.id), record]

      // `store.read()` has already dropped every kid that named a pane not in
      // `config.panes`, so the saved kids all still exist and none needs
      // filtering here. No saved row at all means a tab that has never been
      // split: `CHANNELS.open` writes none and restore writes one for every tab
      // it brings back, so the sibling alone is the best starting point.
      const saved = config.tabs.find((row) => row.id === tabId)
      const savedKids = saved?.layout.kids ?? [paneId]
      // Unioned with the tab's other live panes, because the row alone is not
      // the whole tab: a pane that died and was restarted is running, back in
      // this group, and back in `config.panes`, but no row claims it — its row
      // entry went when it died and nothing puts it back until the next
      // restore. Building `kids` from the row alone would drop a LIVE pane from
      // both the file and the reply, which is the one thing `TabShape` promises
      // not to do. Appending it is also exactly what `restore.ts`'s `tabRowFor`
      // does with a pane its saved row never knew, so this writes the row the
      // next restore would have produced rather than inventing a policy.
      //
      // `manager.panesOfTab` rather than the manager's own entries: it starts
      // from live tmux, so it also sees a pane whose session survives with no
      // client attached — detached, and still a member of this tab. Only the
      // ids are read, so the cwd it synthesises for a pane it has no entry for
      // never reaches anything.
      //
      // Filtered against `panes` because a kid has to name a pane row: an id
      // that names none would be dropped by the next `store.read()` anyway, and
      // `held` below would answer for it with nothing.
      const listed = new Set(panes.map((pane) => pane.id))
      const unclaimed = (await manager.panesOfTab(tabId))
        .map((pane) => pane.id)
        .filter((id) => id !== record.id && !savedKids.includes(id) && listed.has(id))
      const siblings = [...savedKids, ...unclaimed]
      const at = siblings.indexOf(paneId)
      const kids =
        at === -1
          ? [...siblings, record.id]
          : [...siblings.slice(0, at + 1), record.id, ...siblings.slice(at + 1)]

      const row: TabRow = {
        // The TAB's id, never the new pane's — a pane added to a tab is not
        // its founder, and a row named after it would be a second tab in the
        // bar with the first one's panes in it.
        id: tabId,
        // And the group it is in now, which is what the next restore resolves
        // this row by: that is all live tmux can report about a tab.
        groupId,
        // The pane the user just asked for is the one they are looking at.
        activePaneId: record.id,
        layout: {
          // The axis the caller asked for, always — a split re-orients the tab
          // it lands in.
          //
          // A RULING, and the SECOND one here: until 2026-08-06 an already-split
          // tab kept its own axis and the new pane joined it, so a request for
          // the other direction added a pane without moving the ones already
          // there. What that bought is real and is now given up deliberately:
          // re-orienting is not cosmetic with terminals, since every pane in the
          // tab reflows and its real tmux session is resized, including panes
          // the user did not act on.
          //
          // It is given up because the cost it charged was worse. A tab that had
          // ever been split downward could not be split right again by any
          // route — not ⌘D, not the menu, not after closing panes back down, as
          // long as two remained — and nothing on screen explained the refusal,
          // because there was no refusal to show: the split landed, just not
          // where it was asked for. That reached real use as "split right is not
          // working", and no amount of explanatory text would have given the
          // user the layout they were asking for. See `SplitRequest.dir`.
          dir,
          // See `carveRatio`'s own doc comment for what this does and does
          // not preserve — in particular, for the "dilutes every known share
          // evenly" case an unclaimed sibling produces, which is not a bug.
          ratio: carveRatio({
            tabId,
            kids,
            sourcePaneId: paneId,
            newPaneId: record.id,
            siblings,
            savedKids,
            savedRatio: saved?.layout.ratio ?? [],
            // What an unclaimed sibling is owed, when main saw it die, and
            // what any OTHER pane of this tab is still owed while it stays a
            // tombstone. The same map `closePane` hands `tabRowFor`, so the
            // two rebuilds of a tab's row agree about what a claim means.
            tombstones,
          }),
          kids,
        },
      }

      // Both arrays in one write. `rememberTab` is deliberately not used: it is
      // itself a `serialise` wrapper and would deadlock inside this pass, and
      // it writes `config.panes` alone — a separate write for the tab row would
      // leave a window in which the file holds a pane no tab lists.
      const tabs = withTabRow(config.tabs, tabId, row)
      await store.write({ ...config, panes, tabs })
      return { panes: held(panes, kids), tabs: [row] }
    })
  })

  /**
   * A pane dragged out of its tab and dropped onto another: the target tab
   * gains the pane, the source tab loses it.
   *
   * `tabIdOf(paneId)` has to run before `manager.joinTab`. `joinTab` ends by
   * re-registering the moved pane's manager entry under the TARGET's tab id
   * (`this.open({ ..., tabId: targetTabId })`), so a `tabIdOf(paneId)` read
   * AFTER the move does not fail or come back empty: it answers with the
   * target's tab id, indistinguishable from a pane that was already there.
   * Read there, `sourceTabId` would equal `tabId`, the `if (!sourceTabId)`
   * guard below would not catch it, and the double `withTabRow` further down
   * would overwrite the target row with the source row, writing a config
   * where the moved pane names no row at all.
   *
   * The source tab's live members are read before the move too, for a
   * related but distinct reason: when the moved pane is its own tab's
   * founder, `joinTab` renames the target's staging session back onto that
   * founder's OWN session name, so the session `panesOfTab(sourceTabId)`
   * would find by name after the move is the pane that just left, now
   * sitting in the target's tmux group, rather than whatever the source tab
   * has left. Read first, that lookup still sees the source tab as it stood
   * with the moved pane still in it, which is all this handler needs: the
   * moved pane is filtered out by id below regardless of when its
   * membership was read. `joinTab` and the two `groupIdOf` calls are all
   * tmux work, so they run outside `serialise` for the reason `splitPane`
   * and `closePane` already do: the queue has no reentrancy protection, and
   * anything it reaches that calls back into it deadlocks on its own caller.
   *
   * The target row is built the way `splitPane` builds a row for a tab that
   * gained a pane (the moved pane is simply appended rather than inserted
   * next to a sibling, since a join has no "split from" position to insert
   * it at). The source row is built the way `closePane` builds one for a tab
   * that lost a pane, including `tabRowFor` handing `activePaneId` to a
   * survivor when the pane that left was the one in focus.
   *
   * Both rows go into one `store.write`, for the same reason `splitPane` and
   * `closePane` write panes and tabs together: a separate write for each
   * array would leave a window where the file holds a pane no tab lists.
   * `rememberTab` is not used here for that reason, since it is itself a
   * `serialise` wrapper and writes `config.panes` alone.
   */
  ipcMain.handle(
    CHANNELS.joinPane,
    async (_event, paneId: string, targetPaneId: string): Promise<JoinShape> => {
      const sourceTabId = manager.tabIdOf(paneId)
      if (!sourceTabId) throw new Error(`Cannot join: pane ${paneId} is not open`)
      // Both read before the move: see the doc comment above for why after
      // is wrong whenever the moved pane is its own tab's founder.
      // `groupIdOf` has the same hazard as `panesOfTab` for that case, and a
      // narrower one besides: if the source tab has ALSO re-founded (every
      // pane of it died and one came back under a fresh group), its group
      // name no longer decodes to `sourceTabId`, `groupIdOf`'s founder-by-
      // session-name fallback is the only match left, and after the move
      // that fallback finds the very session `panesOfTab` is guarded
      // against above, now sitting in the TARGET's group. Read here, before
      // any of that has happened, both calls see the source tab exactly as
      // it stood with the moved pane still in it.
      const sourceMembers = (await manager.panesOfTab(sourceTabId)).map((pane) => pane.id)
      const sourceGroupId = await manager.groupIdOf(sourceTabId)

      const { record, tabId } = await manager.joinTab({ paneId, targetPaneId })
      const targetGroupId = await manager.groupIdOf(tabId)

      return serialise(async () => {
        const config = await store.read()
        const panes = [...config.panes.filter((saved) => saved.id !== record.id), record]
        const listed = new Set(panes.map((pane) => pane.id))

        // The target tab's row, built the way `splitPane` builds one: the
        // saved kids, unioned with any live pane the saved row does not
        // claim (a restarted pane whose row entry a death dropped), plus the
        // moved pane appended at the end.
        const savedTarget = config.tabs.find((row) => row.id === tabId)
        const targetSavedKids = savedTarget?.layout.kids ?? [targetPaneId]
        const targetUnclaimed = (await manager.panesOfTab(tabId))
          .map((pane) => pane.id)
          .filter((id) => id !== record.id && !targetSavedKids.includes(id) && listed.has(id))
        const targetSiblings = [...targetSavedKids, ...targetUnclaimed]
        const targetKids = [...targetSiblings, record.id]

        const targetRow: TabRow = {
          id: tabId,
          groupId: targetGroupId,
          activePaneId: record.id,
          layout: {
            // The target's own axis, kept rather than re-orientated: unlike a
            // split, a join carries no direction the user asked for.
            dir: savedTarget?.layout.dir ?? 'row',
            ratio: carveRatio({
              tabId,
              kids: targetKids,
              sourcePaneId: targetPaneId,
              newPaneId: record.id,
              siblings: targetSiblings,
              savedKids: targetSavedKids,
              savedRatio: savedTarget?.layout.ratio ?? [],
              tombstones,
            }),
            kids: targetKids,
          },
        }

        // The source tab's row, built the way `closePane` builds one for a
        // tab that has lost a pane: the moved pane dropped out of its saved
        // kids, unioned with any other live pane the saved row did not
        // claim, and `null` once nothing is left to lay out.
        const savedSource = config.tabs.find((row) => row.id === sourceTabId)
        const sourceSavedKids = savedSource?.layout.kids ?? []
        const sourceUnclaimed = sourceMembers.filter(
          (id) => id !== record.id && !sourceSavedKids.includes(id) && listed.has(id),
        )
        const sourceKids = [
          ...sourceSavedKids.filter((kid) => kid !== record.id),
          ...sourceUnclaimed,
        ]
        const sourceRow: TabRow | null =
          sourceKids.length > 0
            ? tabRowFor(
                { id: sourceTabId, groupId: sourceGroupId },
                sourceKids,
                savedSource,
                tombstones,
              )
            : null

        const tabs = withTabRow(
          withTabRow(config.tabs, tabId, targetRow),
          sourceTabId,
          sourceRow,
        )
        await store.write({ ...config, panes, tabs })

        // The target row always first: Task 5's reducer reads `tabs[0]` to
        // decide which pane to focus, and the source row second when the
        // source tab survives. See `JoinShape`'s doc comment in
        // `src/shared/ipc.ts`.
        const rows = sourceRow ? [targetRow, sourceRow] : [targetRow]
        // `held`, the same helper `splitPane` and `closePane` use, so `panes`
        // is in each row's own layout order rather than `config.panes`
        // order: a tab split more than once can have its kids reordered
        // relative to when each pane was first written to disk.
        return {
          panes: rows.flatMap((row) => held(panes, row.layout.kids)),
          tabs: rows,
          dropped: sourceRow ? null : sourceTabId,
        }
      })
    },
  )

  /**
   * The one way a pane is closed.
   *
   * There used to be two: a `CHANNELS.kill` that destroyed the session and
   * forgot the pane, and this, which does all of that AND maintains the tab
   * row the pane was laid out in. Two channels differing only in whether the
   * layout is kept is a place for drift — whichever one ⌘W did not use would
   * leave a stale row the first time it met a split tab — so the narrower one
   * is gone and every caller comes here.
   */
  ipcMain.handle(CHANNELS.closePane, async (_event, paneId: string): Promise<TabShape> => {
    // Before the kill, and it has to be: `manager.kill()` deletes the entry
    // this is held on, and a dead pane's tab is not recoverable afterwards —
    // its membership lived in the tmux session the kill destroys. The fallback
    // is a pane this process never held, which is a tab of one by definition.
    const tabId = manager.tabIdOf(paneId) ?? paneId

    // Whether there is a session behind this pane at all, asked of the saved
    // row rather than of the manager: the manager has no entry for an editor
    // pane AND none for a terminal pane whose client has gone, and `kill`
    // finds the second through `findOrphans`. Only the kind tells them apart.
    //
    // Outside `serialise`, like the tmux work below and for the same reason,
    // and safe to read there because a pane's kind is fixed at creation: a
    // stale read cannot answer this differently, only earlier. A row missing
    // altogether is treated as a terminal, which is the same answer this
    // handler gave before there were editor panes; it cannot be an editor
    // whose write has not landed, because `openEditor` awaits its own
    // `store.write` before the renderer ever learns the pane's id.
    const saved = (await store.read()).panes.find((row) => row.id === paneId)
    const sessionless = saved !== undefined && !canHaveSession(saved)

    if (!sessionless) {
      // Recorded before the first await inside `manager.kill()` can run, so it
      // is always in place before the exit event it settles could possibly fire:
      // that event is answered by asking this map, and it fires while the kill
      // is still in flight. See `pendingKills`.
      const outcome = manager.kill(paneId)
      pendingKills.set(paneId, outcome)
      try {
        await outcome
      } finally {
        pendingKills.delete(paneId)
      }
    }
    // The four lines below are NOT inside that branch, deliberately. Each is a
    // delete from a map an editor pane was never in, so all four are no-ops
    // for one, and a second branch that has to stay in step with the first is
    // the thing this file's own comments keep asking the next person not to
    // write. Only the kill has to be skipped: it is the one call that rejects
    // rather than shrugging when there is nothing there, which is how closing
    // an editor tab painted `kill: no tmux session found for tab ...` into the
    // pane the user had just clicked × on.
    //
    // A killed pane is not restartable, so its state, the geometry a restart
    // would have attached at, the share a restart would have come back at and
    // the tab a restart would have rejoined all go together. See
    // `SessionManager.forgetPane`.
    registry.forget(paneId)
    // The closed pane, gone, can no longer be anybody's agent session. Any
    // browser pane it owned is released, not closed: see `agentSessions`.
    releaseAgentSession(agentSessions, paneId)
    lastGeometry.delete(paneId)
    tombstones.delete(paneId)
    manager.forgetPane(paneId)

    // After the kill, so it reads the group the tab is left in rather than the
    // one it was in with this pane still alive — and outside the pass below,
    // like the kill itself.
    const groupId = await manager.groupIdOf(tabId)

    return serialise(async () => {
      const config = await store.read()
      const panes = config.panes.filter((saved) => saved.id !== paneId)

      // The same union `splitPane` builds, and for the same reason: a pane that
      // died and was restarted is live and in `config.panes` but in no row, and
      // closing its sibling must not be the thing that drops it from the tab.
      // The pane just closed cannot come back through it — `manager.kill()`
      // destroyed its tmux session, which is what `panesOfTab` reads, and
      // `listed` is the survivors on disk.
      const saved = config.tabs.find((row) => row.id === tabId)
      const savedKids = saved?.layout.kids ?? []
      const listed = new Set(panes.map((pane) => pane.id))
      const unclaimed = (await manager.panesOfTab(tabId))
        .map((pane) => pane.id)
        .filter((id) => !savedKids.includes(id) && listed.has(id))
      const kids = [...savedKids.filter((kid) => kid !== paneId), ...unclaimed]

      // `restore.ts`'s `tabRowFor`, on the same inputs and for the same reason:
      // a kid the saved row knew keeps its own share, a kid it does not know
      // but that `tombstones` remembers claims the share it died at, and
      // anything else takes an even one — with the saved-derived shares scaled
      // into whatever the claims leave, AND with any other pane of this tab
      // `tombstones` still owes something to held back from `kids` too, so the
      // row actually written describes only the panes it names, in the
      // live-remainder frame `config.tabs` has always been in (see
      // `inLiveFrame` in `shares.ts`). This handler had its own copy of the
      // saved-share-or-even part, converged on it line for line — and the
      // rescale is exactly the part that can rot unnoticed in one copy, since
      // `store.read()` rescales again on the way back in and repairs the
      // evidence.
      //
      // `tombstones` is passed here and nowhere in `restoreWorkspace`,
      // which is why the parameter is optional: restore prunes dead panes at
      // launch, so it never has a restarted pane to apply one to.
      //
      // A tab with no panes left loses its row outright rather than keeping an
      // empty one, which would put a tab nobody can see in the bar until the
      // next read swept it. That is why the emptiness is tested here rather
      // than inside `tabRowFor`, whose other caller can never be handed none.
      const row: TabRow | null =
        kids.length > 0 ? tabRowFor({ id: tabId, groupId }, kids, saved, tombstones) : null

      const tabs = withTabRow(config.tabs, tabId, row)
      await store.write({ ...config, panes, tabs })
      return { panes: row ? held(panes, row.layout.kids) : [], tabs: row ? [row] : [] }
    })
  })

  ipcMain.handle(CHANNELS.notifications, async () => (await store.read()).notifications)

  ipcMain.handle(
    CHANNELS.updateNotifications,
    (_event, patch: Partial<NotificationConfig>): Promise<NotificationConfig> =>
      serialise(async () => {
        const config = await store.read()
        const notifications = { ...config.notifications, ...patch }
        await store.write({ ...config, notifications })
        return notifications
      }),
  )

  ipcMain.handle(CHANNELS.theme, async () => (await store.read()).theme)

  ipcMain.handle(CHANNELS.updateTheme, (_event, id: ThemeId): Promise<ThemeId> =>
    serialise(async () => {
      const config = await store.read()
      // Through the same queue every other config write uses. Two writes racing
      // on this file is how a theme change loses a tab row written a
      // millisecond earlier.
      const theme = isThemeId(id) ? id : config.theme
      await store.write({ ...config, theme })
      return theme
    }),
  )

  // installHooks/uninstallHooks write ~/.claude/settings.json, not pTerm's own
  // config file, so these deliberately do not go through `serialise` above.
  // That queue has no reentrancy protection, and nothing reached from inside
  // it may call back into it — going through it here would risk a silent
  // deadlock for a screen the user is looking straight at.
  ipcMain.handle(CHANNELS.hooksState, () => readHooksState())
  ipcMain.handle(CHANNELS.installHooks, () => installHooks())
  ipcMain.handle(CHANNELS.uninstallHooks, () => uninstallHooks())

  // Read fresh on every call, like hooksState above: another window, or the
  // user's own shell, can append to the history file while an overlay built
  // on this is open.
  ipcMain.handle(
    CHANNELS.historyList,
    async (_event, projectCwd: string, scope: HistoryScope): Promise<HistoryEntry[]> =>
      selectHistory(await readHistory(), { scope, projectCwd }),
  )
  ipcMain.handle(CHANNELS.shellHistoryState, () => readShellHistoryState())
  ipcMain.handle(CHANNELS.installShellHistory, () => installShellHistory())
  ipcMain.handle(CHANNELS.uninstallShellHistory, () => uninstallShellHistory())

  // Explicitly ignores a previous skip: the user pressed a button, and the
  // answer they get must be about the release, not about a decision they made
  // last month. The background check in `schedule.ts` is the one that respects it.
  ipcMain.handle(CHANNELS.checkForUpdate, () =>
    realUpdateService(app.getVersion()).check({ respectSkip: false }),
  )
  ipcMain.handle(CHANNELS.skipUpdate, (_event, version: string) => writeSkipped(version))
  ipcMain.handle(CHANNELS.appVersion, () => app.getVersion())
  ipcMain.handle(CHANNELS.skippedVersion, () => readSkipped())

  // The URL came off the network by way of the renderer, which any renderer
  // code could invoke this with. `parseRelease` already checks the scheme
  // once, at the point a release enters the app; this is a second check at
  // this handler's own boundary, since `shell.openExternal` will hand a
  // `file:` or a custom-scheme URL to whatever claims it. See `isOpenable`.
  ipcMain.handle(CHANNELS.openExternal, async (_event, url: string) => {
    if (!isOpenable(url)) return
    // `shell` is non-writable, so a spec cannot stub this and an e2e that
    // clicks a link reaches the real OS: before this diversion existed, a full
    // suite run opened a browser tab on the developer's machine pointing at a
    // release tag that does not exist. With the variable set, the URL is
    // recorded and the browser is left alone, which also lets a spec assert
    // which URL the click sent.
    const log = process.env.PTERM_EXTERNAL_LOG
    if (log !== undefined) {
      await appendFile(log, `${url}\n`, 'utf8')
      return
    }
    await shell.openExternal(url)
  })

  // Deliberately not inside `serialise`: this reads `~/.claude`, never pTerm's
  // own config file, so it has nothing to serialise against — the same
  // reasoning the hooks handlers just above are registered under. Going
  // through that queue would add a deadlock risk for a panel the user is
  // looking straight at, and buy nothing.
  ipcMain.handle(CHANNELS.skills, (_event, projectCwd: string) => listSkills(projectCwd))

  // Like `skills` above, deliberately not inside `serialise`: notes live in
  // their own files beside config.json, never inside it, so there is nothing
  // to serialise against and no deadlock risk to buy.
  ipcMain.handle(CHANNELS.notesRead, (_event, projectId: string) => readNote(projectId))
  ipcMain.handle(CHANNELS.notesWrite, (_event, projectId: string, text: string) =>
    writeNote(projectId, text),
  )

  // Outside `serialise`, like the notes handlers above: todos are read and
  // written through their own module, imported above, not through this
  // file's config queue.
  //
  // Every mutation below pushes the new list to every live window via
  // `broadcastTodos`, unlike `send` above, which targets one window through
  // `getWindow()`: the todo list is global to the app rather than scoped to
  // a window the way `send`'s payloads are.
  ipcMain.handle(CHANNELS.todosList, () => readTodos())
  ipcMain.handle(CHANNELS.todosCreate, async (_event, draft: TodoDraft) => {
    const todos = await createTodo(draft)
    broadcastTodos(BrowserWindow.getAllWindows(), todos)
    return todos
  })
  ipcMain.handle(CHANNELS.todosUpdate, async (_event, id: string, patch: TodoPatch) => {
    const todos = await updateTodo(id, patch)
    broadcastTodos(BrowserWindow.getAllWindows(), todos)
    return todos
  })
  ipcMain.handle(CHANNELS.todosSetDone, async (_event, id: string, done: boolean) => {
    const todos = await setTodoDone(id, done)
    broadcastTodos(BrowserWindow.getAllWindows(), todos)
    return todos
  })
  ipcMain.handle(CHANNELS.todosDelete, async (_event, id: string) => {
    const todos = await deleteTodo(id)
    broadcastTodos(BrowserWindow.getAllWindows(), todos)
    return todos
  })

  // Outside `serialise` for the same reason as notes: prompts live in
  // `prompts.json` beside config.json and never inside it. The store has a
  // queue of its own, because add and remove are read-modify-write and this
  // one is the only thing standing between two quick clicks and a lost entry.
  ipcMain.handle(CHANNELS.promptsList, () => readPrompts())
  ipcMain.handle(CHANNELS.promptsAdd, (_event, label: string, body: string) =>
    addPrompt(label, body),
  )
  ipcMain.handle(CHANNELS.promptsRemove, (_event, id: string) => removePrompt(id))

  // Like `skills` and the notes channels above, deliberately not inside
  // `serialise`: this reads the filesystem and never writes config, so there
  // is nothing to serialise against.
  //
  // A project ID rather than the `projectCwd` that `skills` takes. That
  // channel names one fixed directory inside a project; this one lists any
  // directory it is given, so a renderer-supplied absolute path would be a
  // general directory-listing primitive. Here the renderer chooses a project
  // and a path within it, and main decides what that resolves to.
  // Outside `serialise` like the filesystem channels below it: this reads a
  // repository and never touches pTerm's config. Polled by the status bar, so
  // going through that queue would put a tick of it in front of every write the
  // user's own clicks are waiting on.
  ipcMain.handle(CHANNELS.gitStatus, async (_event, projectId: string) => {
    const config = await store.read()
    const project = config.projects.find((row) => row.id === projectId)
    if (!project) return null
    const branch = await readBranch(project.cwd)
    if (branch === null) return null
    // Only asked for once the checkout is known to be one: `readCounts` runs
    // git, and there is no point spawning it for a directory that has no `.git`
    // above it at all.
    const counts = await readCounts(project.cwd)
    return { branch, behind: counts?.behind ?? null, ahead: counts?.ahead ?? null }
  })

  // The only channel in this file that writes to a user's repository. Outside
  // `serialise` for the same reason as the read above, and unqueued against
  // itself: the button that calls it disables while it is in flight.
  ipcMain.handle(CHANNELS.gitSync, async (_event, projectId: string) => {
    const config = await store.read()
    const project = config.projects.find((row) => row.id === projectId)
    if (!project) return { ok: false as const, error: 'No project' }
    return syncBranch(project.cwd)
  })

  // Outside `serialise`, like the git read above and for the same reason:
  // this reads a repository and never touches pTerm's config, and it is
  // polled by the column while it is open.
  ipcMain.handle(CHANNELS.gitChanges, async (_event, projectId: string) => {
    const config = await store.read()
    const project = config.projects.find((row) => row.id === projectId)
    if (!project) return null
    return readChanges(project.cwd)
  })

  // Outside `serialise`, like the git read above and for the same reason:
  // these read a repository (via `gh`, not git itself) and never touch
  // pTerm's config.
  ipcMain.handle(
    CHANNELS.issuesList,
    async (_event, projectId: string, state: IssueStateFilter) => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return NO_PROJECT
      return listIssues(project.cwd, state)
    },
  )

  ipcMain.handle(CHANNELS.issuesGet, async (_event, projectId: string, number: number) => {
    const config = await store.read()
    const project = config.projects.find((row) => row.id === projectId)
    if (!project) return NO_PROJECT
    return getIssue(project.cwd, number)
  })

  // The four mutations, beside the two reads above and outside `serialise`
  // for the same reason they are: these read and write a GitHub repository
  // by way of `gh`, never pTerm's own config.
  ipcMain.handle(
    CHANNELS.issuesCreate,
    async (_event, projectId: string, title: string, body: string) => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return NO_PROJECT
      return createIssue(project.cwd, title, body)
    },
  )

  ipcMain.handle(
    CHANNELS.issuesEdit,
    async (_event, projectId: string, number: number, title: string, body: string) => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return NO_PROJECT
      return editIssue(project.cwd, number, title, body)
    },
  )

  ipcMain.handle(
    CHANNELS.issuesSetState,
    async (
      _event,
      projectId: string,
      number: number,
      action: 'close' | 'reopen',
      reason?: 'completed' | 'not planned',
    ) => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return NO_PROJECT
      return setIssueState(project.cwd, number, action, reason)
    },
  )

  ipcMain.handle(
    CHANNELS.issuesComment,
    async (_event, projectId: string, number: number, body: string) => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return NO_PROJECT
      return commentIssue(project.cwd, number, body)
    },
  )

  /**
   * The repository root behind a project id, or null when there is no project
   * or it is not in a repository. Every git mutation starts here, so that the
   * renderer names a project and main decides which directory that means.
   */
  const rootOfProject = async (projectId: string): Promise<string | null> => {
    const config = await store.read()
    const project = config.projects.find((row) => row.id === projectId)
    if (!project) return null
    return repoRoot(project.cwd)
  }

  // Outside `serialise`, beside `gitChanges` and for the same reason: these
  // read and write a repository, not pTerm's config.
  ipcMain.handle(CHANNELS.gitStage, async (_event, projectId: string, paths: string[]) => {
    const root = await rootOfProject(projectId)
    if (root === null) return { ok: false as const, error: 'Not a git repository', changes: null }
    return stage(root, paths)
  })

  ipcMain.handle(CHANNELS.gitUnstage, async (_event, projectId: string, paths: string[]) => {
    const root = await rootOfProject(projectId)
    if (root === null) return { ok: false as const, error: 'Not a git repository', changes: null }
    return unstage(root, paths)
  })

  ipcMain.handle(
    CHANNELS.gitCommit,
    async (
      _event,
      projectId: string,
      message: string,
      expected: { branch: string | null; head: string | null },
    ) => {
      const root = await rootOfProject(projectId)
      if (root === null) return { ok: false as const, error: 'Not a git repository', changes: null }
      return commit(root, message, expected)
    },
  )

  ipcMain.handle(
    CHANNELS.gitDiscard,
    async (_event, projectId: string, paths: string[], expectedUntracked: string[]) => {
      const root = await rootOfProject(projectId)
      if (root === null) {
        return { ok: false as const, error: 'Not a git repository', changes: null }
      }
      return discard(root, paths, expectedUntracked)
    },
  )

  ipcMain.handle(CHANNELS.gitStash, async (_event, projectId: string) => {
    const root = await rootOfProject(projectId)
    if (root === null) return { ok: false as const, error: 'Not a git repository', changes: null }
    return stashAll(root)
  })

  // Outside `serialise`, beside the rest of the git handlers: reads a
  // repository, writes no config.
  ipcMain.handle(
    CHANNELS.gitDiff,
    async (_event, projectId: string, relPath: string, side: DiffSide) => {
      const root = await rootOfProject(projectId)
      if (root === null) return null
      return diffOf(root, relPath, side)
    },
  )

  ipcMain.handle(CHANNELS.fsList, async (_event, projectId: string, relPath: string) => {
    const config = await store.read()
    const project = config.projects.find((row) => row.id === projectId)
    if (!project) return []
    return listDir(project.cwd, relPath)
  })

  // Beside `fsList` and for the same reasons: outside `serialise` because it
  // reads the filesystem and writes no config, and keyed by project id rather
  // than by a renderer-supplied path.
  ipcMain.handle(CHANNELS.fsRead, async (_event, projectId: string, relPath: string) => {
    const config = await store.read()
    const project = config.projects.find((row) => row.id === projectId)
    if (!project) return null
    return readFileInside(project.cwd, relPath)
  })

  // Beside `fsRead` and outside `serialise` for the same reason: it touches
  // the filesystem and writes no config. Two saves of one file racing is the
  // user's own doing and the mtime check is what makes the second one refuse,
  // which is a better answer than a queue that would let it clobber silently.
  ipcMain.handle(
    CHANNELS.fsWrite,
    async (_event, projectId: string, relPath: string, text: string, expectedMtimeMs: number) => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return { ok: false, reason: 'failed' }
      return writeFileInside(project.cwd, relPath, text, expectedMtimeMs)
    },
  )

  /*
   * The mutating half of the file tree.
   *
   * Outside `serialise`, beside `fsList` and `fsRead` and for the same reason:
   * these touch the filesystem and write no config. Each resolves the entry
   * through `files/ops`, which applies `resolveInside` and, where there is a
   * name, refuses one that is not a single plain name — so a rename cannot
   * become a move and nothing here can address outside the project.
   *
   * Each answers a message rather than throwing. A refusal is something the
   * user typed or clicked at, and the row it came from is still on screen.
   */
  ipcMain.handle(
    CHANNELS.fsRename,
    async (_event, projectId: string, relPath: string, newName: string): Promise<FsResult> => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return { ok: false, error: 'No such project' }
      return renameEntry(project.cwd, relPath, newName)
    },
  )

  ipcMain.handle(
    CHANNELS.fsTrash,
    async (_event, projectId: string, relPath: string): Promise<FsResult> => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return { ok: false, error: 'No such project' }
      const target = resolveInside(project.cwd, relPath)
      if (target === null) return { ok: false, error: 'That path is not in this project' }
      try {
        // Trash rather than unlink, which is why there is no confirmation
        // dialog in front of this: the entry stays recoverable from Finder.
        await shell.trashItem(target)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'Delete failed' }
      }
    },
  )

  ipcMain.handle(
    CHANNELS.fsReveal,
    async (_event, projectId: string, relPath: string): Promise<FsResult> => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return { ok: false, error: 'No such project' }
      const target = resolveInside(project.cwd, relPath)
      if (target === null) return { ok: false, error: 'That path is not in this project' }
      shell.showItemInFolder(target)
      return { ok: true }
    },
  )

  ipcMain.handle(
    CHANNELS.fsCopyPath,
    async (
      _event,
      projectId: string,
      relPath: string,
      kind: 'absolute' | 'relative',
    ): Promise<FsResult> => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return { ok: false, error: 'No such project' }
      const paths = pathsFor(project.cwd, relPath)
      if (paths === null) return { ok: false, error: 'That path is not in this project' }
      clipboard.writeText(kind === 'absolute' ? paths.absolute : paths.relative)
      return { ok: true }
    },
  )

  ipcMain.handle(
    CHANNELS.fsCreate,
    async (
      _event,
      projectId: string,
      relDir: string,
      name: string,
      kind: 'file' | 'directory',
    ): Promise<FsResult> => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return { ok: false, error: 'No such project' }
      return createEntry(project.cwd, relDir, name, kind)
    },
  )

  // The clipboard, for the pane menu. In main because the renderer's own
  // `navigator.clipboard.readText` needs a permission this app never prompts
  // for and rejects without it.
  ipcMain.handle(CHANNELS.clipboardRead, (): string => clipboard.readText())
  ipcMain.handle(CHANNELS.clipboardWrite, (_event, text: string): void => {
    clipboard.writeText(text)
  })

  // Outside `serialise` with the rest of the `fs*` reads: it spawns git and
  // writes no config.
  ipcMain.handle(
    CHANNELS.projectFiles,
    async (_event, projectId: string): Promise<ProjectFileList> => {
      const config = await store.read()
      const project = config.projects.find((row) => row.id === projectId)
      if (!project) return { files: [], truncated: false }
      return projectFiles(project.cwd)
    },
  )

  // Inside `serialise`, unlike `fsList` and `fsRead` just above: this one
  // writes a pane row and a tab row, and two of them racing would interleave
  // two read-modify-write cycles over one config file.
  //
  // Keyed by project id and given a relative path, like both of those: the
  // renderer never spells an absolute path, and `PaneRecord.filePath` is
  // absolute because MAIN writes it here and reads it back at the next restore.
  //
  // Two things separate this from `CHANNELS.open`, which it otherwise follows.
  // There is no `manager.open`, because there is no session to attach: the id
  // is minted here with the same `newSessionId` the manager uses. And a tab row
  // is written, which `CHANNELS.open` deliberately does not do: a terminal
  // regains its row from live tmux at the next restore, whereas
  // `mergeSessionlessPanes` puts back only a sessionless pane whose saved tab
  // row still names it, and drops one no tab holds. Without the row here, this
  // pane would be on disk after a relaunch and unreachable.
  ipcMain.handle(
    CHANNELS.openEditor,
    (_event, projectId: string, relPath: string): Promise<TabDescriptor | null> =>
      serialise(async () => {
        const config = await store.read()
        const project = config.projects.find((row) => row.id === projectId)
        if (!project) return null

        // The path the renderer named, resolved under the project and checked
        // for containment. Lexical rather than `realpath`-resolved on purpose:
        // this is the string the renderer turns back into a relative path for
        // every later `fsRead`, and each of those re-applies the whole guard
        // anyway, symlink half included.
        const filePath = resolveInside(project.cwd, relPath)
        if (filePath === null) return null

        // The guard's other half, called rather than re-derived: `fsRead`'s
        // `realpath` re-check and its is-it-a-file test both live in
        // `readFileInside`, and a file that cannot be read is not worth a tab
        // that could only ever say so. The cost is one read of a file the pane
        // is about to read again, paid once per deliberate click.
        if ((await readFileInside(project.cwd, relPath)) === null) return null

        /*
         * A file already open gets its existing pane back, not a second one.
         *
         * Every click on a tree row used to mint a fresh pane and a fresh tab,
         * so re-opening a file put a SECOND tab of that name in the bar. The
         * renderer needs nothing for this: `opened` already replaces a pane it
         * already knows in place and makes it active, so handing back the
         * existing record focuses that tab.
         *
         * Matched on the resolved absolute path and the project's slug. The
         * path alone would be enough today, since it is absolute and two
         * projects cannot resolve to one file without a symlink, but the slug
         * is what `PaneRecord` uses everywhere else to say which project a pane
         * belongs to and leaving it out would be the odd one.
         */
        const already = config.panes.find(
          (pane) =>
            pane.type === 'editor' &&
            pane.projectSlug === project.slug &&
            pane.filePath === filePath,
        )
        if (already) return already

        const id = newSessionId()
        const pane: PaneRecord = {
          id,
          projectSlug: project.slug,
          cwd: project.cwd,
          type: 'editor',
          filePath,
        }
        // A tab this pane founds, so the tab's id is the pane's. That is the
        // identity `TabRow.id` describes, and the one the renderer selects by.
        //
        // No `registry.applyOpen` beside this, unlike `CHANNELS.open` and
        // restore: `stateForOpen('editor')` is null, so `applyOpen` would only
        // ever `forget` an id nothing has ever recorded a state for.
        const row: TabRow = {
          id,
          // Its own id, because there is no tmux group for it to be in. Restore
          // matches a saved row by `id` and only reads `groupId` for tabs live
          // tmux reported, which will never include this one.
          groupId: id,
          activePaneId: id,
          layout: { dir: 'row', ratio: [1], kids: [id] },
        }

        // Both arrays in one write, for `splitPane`'s reason: a separate write
        // per array leaves a window in which the file holds a pane no tab lists.
        await store.write({
          ...config,
          panes: [...config.panes, pane],
          tabs: withTabRow(config.tabs, id, row),
        })
        return pane
      }),
  )

  // Clones `openEditor` above, with three differences: `type: 'diff'`, the
  // extra `diffSide`/`diffRelPath` fields, and no `readFileInside` pre-read.
  // A diff's subject may be a file that has been deleted, which is exactly a
  // change worth showing, and `readFileInside` would refuse it.
  ipcMain.handle(
    CHANNELS.openDiff,
    (_event, projectId: string, relPath: string, side: DiffSide): Promise<TabDescriptor | null> =>
      serialise(async () => {
        const config = await store.read()
        const project = config.projects.find((row) => row.id === projectId)
        if (!project) return null

        const root = await repoRoot(project.cwd)
        if (root === null) return null
        // Resolved against the REPOSITORY root, not the project cwd: status
        // paths are repo-relative, and a project pointed at a subdirectory
        // would reject every path outside it.
        const filePath = resolveInside(root, relPath)
        if (filePath === null) return null

        // A pane already showing this path and side is the answer, not a
        // reason to mint a second one. Returning the existing record makes
        // the renderer's `opened` action select it, which is the focus this
        // gesture wants. Scoped to THIS project too: two projects can point
        // into the same repository and resolve the same absolute filePath,
        // and `workspace.ts`'s `opened` case derives which project to focus
        // from the returned pane's `projectSlug`, so returning the other
        // project's record would silently activate the wrong project's tab.
        const already = config.panes.find(
          (row) =>
            row.type === 'diff' &&
            row.filePath === filePath &&
            row.diffSide === side &&
            row.projectSlug === project.slug,
        )
        if (already) return already

        const id = newSessionId()
        const pane: PaneRecord = {
          id,
          projectSlug: project.slug,
          cwd: project.cwd,
          type: 'diff',
          filePath,
          diffSide: side,
          // The repo-relative string as-is, rather than re-derived from
          // `filePath` later: `App.tsx`'s `editorRelPath` derives relative to
          // the PROJECT cwd, which only agrees with this repo-root-relative
          // path when the project IS the repository root.
          diffRelPath: relPath,
        }
        const row: TabRow = {
          id,
          groupId: id,
          activePaneId: id,
          layout: { dir: 'row', ratio: [1], kids: [id] },
        }
        await store.write({
          ...config,
          panes: [...config.panes, pane],
          tabs: withTabRow(config.tabs, id, row),
        })
        return pane
      }),
  )

  // Clones `openEditor` too, with two differences instead of `openDiff`'s
  // three: no dedupe, and no path resolution or containment guard. A URL is
  // not a path, so there is nothing to resolve against the project cwd and
  // nothing to keep inside it. And two browser panes open on the same URL is
  // a normal thing to want (two routes of one app, two viewport widths),
  // unlike a file, so this always mints a fresh pane rather than handing back
  // one that already shows the page.
  ipcMain.handle(
    CHANNELS.openBrowser,
    (_event, projectId: string, url?: string): Promise<TabDescriptor | null> =>
      serialise(async () => {
        const config = await store.read()
        const project = config.projects.find((row) => row.id === projectId)
        if (!project) return null

        const id = newSessionId()
        // Always the normalised form, even when normalisation fails: an empty
        // or blank `url` and a missing one both mean "no page yet", so both
        // land on the same `about:blank` a fresh pane opens to.
        const pane: PaneRecord = {
          id,
          projectSlug: project.slug,
          cwd: project.cwd,
          type: 'browser',
          url: (url === undefined ? null : normaliseUrl(url)) ?? 'about:blank',
        }
        const row: TabRow = {
          id,
          groupId: id,
          activePaneId: id,
          layout: { dir: 'row', ratio: [1], kids: [id] },
        }

        await store.write({
          ...config,
          panes: [...config.panes, pane],
          tabs: withTabRow(config.tabs, id, row),
        })
        return pane
      }),
  )

  // `.on`, not `.handle`, for the same reason `setLayout` above is: nothing
  // awaits this, and the renderer already shows where it navigated to
  // before the write lands. Debounced on the renderer side, so this fires
  // far less often than `did-navigate` does.
  ipcMain.on(CHANNELS.setPaneUrl, (_event, paneId: string, url: string) => {
    void serialise(async () => {
      const config = await store.read()
      const pane = config.panes.find((row) => row.id === paneId)
      // Not defensive noise: the kind check is what stops a stray call from
      // writing a `url` onto a terminal row. `normalisePane` keeps any
      // `url` field it finds regardless of kind, and nothing ever reads it
      // back off a row that is not `browser`, so a wrong write would sit
      // there silently rather than fail loudly.
      if (!pane || pane.type !== 'browser') return
      if (pane.url === url) return
      await store.write({
        ...config,
        panes: config.panes.map((row) => (row.id === paneId ? { ...row, url } : row)),
      })
    })
  })
}
